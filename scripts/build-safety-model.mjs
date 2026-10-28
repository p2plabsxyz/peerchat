// node scripts/build-safety-model.mjs <model.safetensors>
//
// Writes lib/safety-model/manifest.json and weights from the original
// image-safety-classifier-s weights (huggingface.co/OwenElliott/
// image-safety-classifier-s, model.safetensors), which lib/safety-model.js runs.
//
// The model is SwiftFormer-S. Every batch norm, layer scale and the attention
// scale is folded into the convolution or matrix next to it, and the two heads
// become one, so the forward pass is plain convolutions and matrices. Weights
// are written in the order it uses them, as 16-bit floats; biases and small
// vectors stay float32. lib/safety-model/README.md says how close that stays
// to the original, and why not 8-bit.
import { readFileSync, writeFileSync } from "node:fs";

const [src] = process.argv.slice(2);
if (!src) {
  console.error("usage: node scripts/build-safety-model.mjs <model.safetensors>");
  process.exit(1);
}
const OUT = new URL("../lib/safety-model/", import.meta.url);
const EPS = 1e-5;
const LAYERS = [3, 3, 9, 6];
const DIMS = [48, 64, 168, 224];
// Smaller tensors are not worth halving.
const MIN_PACKED = 65;

const file = readFileSync(src);
const headerLength = Number(file.readBigUInt64LE(0));
const header = JSON.parse(file.subarray(8, 8 + headerLength).toString("utf8"));
const base = 8 + headerLength;
function tensor(name) {
  const entry = header[name];
  if (!entry) throw new Error(`missing ${name}`);
  if (entry.dtype !== "F32") throw new Error(`${name} is ${entry.dtype}`);
  const [start, end] = entry.data_offsets;
  const copy = new Float32Array((end - start) / 4);
  for (let i = 0; i < copy.length; i++) copy[i] = file.readFloatLE(base + start + i * 4);
  return { shape: entry.shape, data: copy };
}

// Batch norm as y = x * s + t.
function bn(prefix) {
  const w = tensor(`${prefix}.weight`).data;
  const b = tensor(`${prefix}.bias`).data;
  const mean = tensor(`${prefix}.running_mean`).data;
  const variance = tensor(`${prefix}.running_var`).data;
  const s = new Float32Array(w.length);
  const t = new Float32Array(w.length);
  for (let c = 0; c < w.length; c++) {
    s[c] = w[c] / Math.sqrt(variance[c] + EPS);
    t[c] = b[c] - mean[c] * s[c];
  }
  return { s, t };
}

const out = [];
function emit(name, shape, data) {
  out.push({ name, shape, data });
}

// torch conv [O, I, kh, kw] to a TensorFlow.js filter [kh, kw, I, O], with the
// batch norm after it folded in.
function convBn(convPrefix, bnPrefix, name) {
  const w = tensor(`${convPrefix}.weight`);
  const b = tensor(`${convPrefix}.bias`).data;
  const [O, I, kh, kw] = w.shape;
  const { s, t } = bn(bnPrefix);
  const filter = new Float32Array(kh * kw * I * O);
  for (let o = 0; o < O; o++) {
    for (let i = 0; i < I; i++) {
      for (let y = 0; y < kh; y++) {
        for (let x = 0; x < kw; x++) {
          filter[((y * kw + x) * I + i) * O + o] = w.data[((o * I + i) * kh + y) * kw + x] * s[o];
        }
      }
    }
  }
  const bias = new Float32Array(O);
  for (let o = 0; o < O; o++) bias[o] = b[o] * s[o] + t[o];
  emit(`${name}.filter`, [kh, kw, I, O], filter);
  emit(`${name}.bias`, [O], bias);
}

// torch depthwise [C, 1, 3, 3] to [3, 3, C, 1], batch norm folded in.
function dwBn(convPrefix, bnPrefix, name) {
  const w = tensor(`${convPrefix}.weight`);
  const b = tensor(`${convPrefix}.bias`).data;
  const [C, , kh, kw] = w.shape;
  const { s, t } = bn(bnPrefix);
  const filter = new Float32Array(kh * kw * C);
  for (let c = 0; c < C; c++) {
    for (let y = 0; y < kh; y++) {
      for (let x = 0; x < kw; x++) filter[(y * kw + x) * C + c] = w.data[(c * kh + y) * kw + x] * s[c];
    }
  }
  const bias = new Float32Array(C);
  for (let c = 0; c < C; c++) bias[c] = b[c] * s[c] + t[c];
  emit(`${name}.filter`, [kh, kw, C, 1], filter);
  emit(`${name}.bias`, [C], bias);
}

// A 1x1 conv [O, I, 1, 1] or a linear [O, I] as an [I, O] matrix. scale
// multiplies each output (a layer scale), inNorm is a batch norm before it.
function dense(prefix, name, { scale = null, inNorm = null } = {}) {
  const w = tensor(`${prefix}.weight`);
  const b = tensor(`${prefix}.bias`).data;
  const [O, I] = w.shape;
  const matrix = new Float32Array(I * O);
  const bias = new Float32Array(O);
  for (let o = 0; o < O; o++) {
    let extra = 0;
    for (let i = 0; i < I; i++) {
      let v = w.data[o * I + i];
      if (inNorm) {
        extra += v * inNorm.t[i];
        v *= inNorm.s[i];
      }
      matrix[i * O + o] = v * (scale ? scale[o] : 1);
    }
    bias[o] = (b[o] + extra) * (scale ? scale[o] : 1);
  }
  emit(`${name}.matrix`, [I, O], matrix);
  emit(`${name}.bias`, [O], bias);
}

const gamma = (name) => tensor(name).data;

convBn("stem.0", "stem.1", "stem0");
convBn("stem.3", "stem.4", "stem1");
for (let stage = 0; stage < 4; stage++) {
  const dim = DIMS[stage];
  if (stage > 0) convBn(`stages.${stage}.downsample.proj`, `stages.${stage}.downsample.norm`, `s${stage}.down`);
  for (let block = 0; block < LAYERS[stage]; block++) {
    const p = `stages.${stage}.blocks.${block}`;
    const n = `s${stage}.b${block}`;
    if (block < LAYERS[stage] - 1) {
      dwBn(`${p}.dwconv`, `${p}.norm`, `${n}.dw`);
      dense(`${p}.pwconv1`, `${n}.pw1`);
      dense(`${p}.pwconv2`, `${n}.pw2`, { scale: gamma(`${p}.layer_scale.gamma`) });
    } else {
      const l = `${p}.local_representation`;
      dwBn(`${l}.dwconv`, `${l}.norm`, `${n}.local.dw`);
      dense(`${l}.pwconv1`, `${n}.local.pw1`);
      dense(`${l}.pwconv2`, `${n}.local.pw2`, { scale: gamma(`${l}.layer_scale.gamma`) });
      dense(`${p}.attn.to_query`, `${n}.query`);
      dense(`${p}.attn.to_key`, `${n}.key`);
      const wg = tensor(`${p}.attn.w_g`).data;
      emit(`${n}.wg`, [dim, 1], Float32Array.from(wg, (v) => v * dim ** -0.5));
      dense(`${p}.attn.proj`, `${n}.proj`);
      dense(`${p}.attn.final`, `${n}.final`, { scale: gamma(`${p}.layer_scale_1.gamma`) });
      dense(`${p}.linear.fc1`, `${n}.fc1`, { inNorm: bn(`${p}.linear.norm1`) });
      dense(`${p}.linear.fc2`, `${n}.fc2`, { scale: gamma(`${p}.layer_scale_2.gamma`) });
    }
  }
}
// The final norm, the average pool and both heads: logits = W (s m + t) + b.
{
  const { s, t } = bn("norm");
  const h = tensor("head.weight");
  const hb = tensor("head.bias").data;
  const d = tensor("head_dist.weight").data;
  const db = tensor("head_dist.bias").data;
  const [O, I] = h.shape;
  const matrix = new Float32Array(I * O);
  const bias = new Float32Array(O);
  for (let o = 0; o < O; o++) {
    let extra = 0;
    for (let i = 0; i < I; i++) {
      const w = (h.data[o * I + i] + d[o * I + i]) / 2;
      extra += w * t[i];
      matrix[i * O + o] = w * s[i];
    }
    bias[o] = (hb[o] + db[o]) / 2 + extra;
  }
  emit("head.matrix", [I, O], matrix);
  emit("head.bias", [O], bias);
}

// IEEE half precision, rounded to nearest even.
function toHalf(value) {
  const bits = new Uint32Array(new Float32Array([value]).buffer)[0];
  const sign = (bits >>> 16) & 0x8000;
  const exponent = ((bits >>> 23) & 0xff) - 127 + 15;
  const mantissa = bits & 0x7fffff;
  if (exponent >= 31) return sign | 0x7c00;
  if (exponent <= 0) {
    if (exponent < -10) return sign;
    const full = mantissa | 0x800000;
    const shift = 14 - exponent;
    const half = full >>> shift;
    const rest = full & ((1 << shift) - 1);
    const midpoint = 1 << (shift - 1);
    return sign | (rest > midpoint || (rest === midpoint && (half & 1)) ? half + 1 : half);
  }
  const half = sign | (exponent << 10) | (mantissa >>> 13);
  const rest = mantissa & 0x1fff;
  return rest > 0x1000 || (rest === 0x1000 && (half & 1)) ? half + 1 : half;
}

const chunks = [];
const manifest = [];
let offset = 0;
function push(buffer) {
  chunks.push(Buffer.from(buffer.buffer, buffer.byteOffset, buffer.byteLength));
  offset += buffer.byteLength;
}
for (const entry of out) {
  const size = entry.data.length;
  if (size < MIN_PACKED) {
    manifest.push({ name: entry.name, shape: entry.shape, dtype: "float32", offset });
    push(entry.data);
    continue;
  }
  manifest.push({ name: entry.name, shape: entry.shape, dtype: "float16", offset });
  push(Uint16Array.from(entry.data, toHalf));
  // Keep every float32 that follows on a four byte boundary.
  const pad = (4 - (offset % 4)) % 4;
  if (pad) push(new Uint8Array(pad));
}
writeFileSync(new URL("weights", OUT), Buffer.concat(chunks));
writeFileSync(new URL("manifest.json", OUT), JSON.stringify(manifest) + "\n");
console.log(`${out.length} tensors, ${offset} bytes`);
