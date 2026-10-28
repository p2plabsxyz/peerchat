// The safety model: image-safety-classifier-s (SwiftFormer-S, MIT), which says
// how likely a picture is to show gore or graphic violence (NSFL), nudity
// (NSFW) or neither (SFW). This is its forward pass in TensorFlow.js, over the
// weights scripts/build-safety-model.mjs folds and packs into
// lib/safety-model/. A plain script, for a page and for PeerSky Mobile's
// scanner page alike: it defines createSafetyModel on the global object, or
// exports it when loaded as a module.
(function (root) {
  const LAYERS = [3, 3, 9, 6];
  const DIMS = [48, 64, 168, 224];
  const SIZE = 224;
  const MEAN = [0.485, 0.456, 0.406];
  const STD = [0.229, 0.224, 0.225];
  // In the order the model reports them.
  const CLASSES = ["NSFL", "NSFW", "SFW"];

  const product = (dims) => dims.reduce((a, b) => a * b, 1);

  // Every 16-bit float as a 32-bit one, looked up rather than worked out for
  // each of the model's five and a half million weights.
  function halfTable() {
    const table = new Float32Array(65536);
    for (let h = 0; h < 65536; h++) {
      const sign = h & 0x8000 ? -1 : 1;
      const exponent = (h >> 10) & 0x1f;
      const mantissa = h & 0x3ff;
      if (exponent === 0) table[h] = sign * mantissa * 2 ** -24;
      else if (exponent === 31) table[h] = mantissa ? NaN : sign * Infinity;
      else table[h] = sign * (1 + mantissa / 1024) * 2 ** (exponent - 15);
    }
    return table;
  }

  // Each tensor is float32, or float16 for the big ones.
  function unpack(tf, manifest, bytes) {
    const weights = {};
    const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    const table = halfTable();
    for (const entry of manifest) {
      const size = product(entry.shape);
      let values;
      if (entry.dtype === "float16") {
        const halves = new Uint16Array(buffer, entry.offset, size);
        values = new Float32Array(size);
        for (let i = 0; i < size; i++) values[i] = table[halves[i]];
      } else {
        values = new Float32Array(buffer, entry.offset, size);
      }
      weights[entry.name] = tf.tensor(values, entry.shape, "float32");
    }
    return weights;
  }

  function createSafetyModel(tf, manifest, bytes) {
    const w = unpack(tf, manifest, bytes);

    const gelu = (x) => tf.mul(tf.mul(x, 0.5), tf.add(1, tf.erf(tf.mul(x, Math.SQRT1_2))));

    // Divided by its length along axis, never by less than 1e-12.
    const l2 = (x, axis) => tf.div(x, tf.maximum(tf.sqrt(tf.sum(tf.square(x), axis, true)), 1e-12));

    // 3x3, padded by one on every side as the original is. 'same' would pad a
    // stride of two on one side only.
    const conv = (x, name, stride) => tf.add(tf.conv2d(x, w[`${name}.filter`], stride, 1), w[`${name}.bias`]);

    // A 1x1 convolution or a linear layer, over [tokens, channels].
    const dense = (x, name) => tf.add(tf.matMul(x, w[`${name}.matrix`]), w[`${name}.bias`]);

    // Depthwise 3x3, then two 1x1 with GELU between, added back to the input.
    function convEncoder(x, name, size, channels) {
      let y = tf.add(tf.depthwiseConv2d(x, w[`${name}.dw.filter`], 1, 1), w[`${name}.dw.bias`]);
      y = tf.reshape(y, [size * size, channels]);
      y = dense(gelu(dense(y, `${name}.pw1`)), `${name}.pw2`);
      return tf.add(x, tf.reshape(y, [1, size, size, channels]));
    }

    // SwiftFormer's last block in a stage: the same local part, efficient
    // additive attention, and an MLP.
    function block(x, name, size, channels) {
      x = convEncoder(x, `${name}.local`, size, channels);
      let tokens = tf.reshape(x, [size * size, channels]);
      const query = l2(dense(tokens, `${name}.query`), 1);
      const key = l2(dense(tokens, `${name}.key`), 1);
      const attn = l2(tf.matMul(query, w[`${name}.wg`]), 0);
      const global = tf.sum(tf.mul(attn, query), 0, true);
      let out = tf.add(dense(tf.mul(global, key), `${name}.proj`), query);
      out = dense(out, `${name}.final`);
      x = tf.add(x, tf.reshape(out, [1, size, size, channels]));
      tokens = tf.reshape(x, [size * size, channels]);
      const mlp = dense(gelu(dense(tokens, `${name}.fc1`)), `${name}.fc2`);
      return tf.add(x, tf.reshape(mlp, [1, size, size, channels]));
    }

    // pixels: [height, width, 3], 0 to 255, best already 224 square. Returns
    // the three probabilities.
    function predict(pixels) {
      return tf.tidy(() => {
        let x = tf.cast(pixels, "float32");
        if (x.shape[0] !== SIZE || x.shape[1] !== SIZE) x = tf.image.resizeBilinear(x, [SIZE, SIZE]);
        x = tf.reshape(x, [1, SIZE, SIZE, 3]);
        x = tf.div(tf.sub(tf.div(x, 255), MEAN), STD);
        x = tf.relu(conv(x, "stem0", 2));
        x = tf.relu(conv(x, "stem1", 2));
        let size = SIZE / 4;
        for (let stage = 0; stage < 4; stage++) {
          if (stage > 0) {
            x = conv(x, `s${stage}.down`, 2);
            size /= 2;
          }
          for (let b = 0; b < LAYERS[stage]; b++) {
            const name = `s${stage}.b${b}`;
            x = b < LAYERS[stage] - 1 ? convEncoder(x, name, size, DIMS[stage]) : block(x, name, size, DIMS[stage]);
          }
        }
        return tf.softmax(dense(tf.mean(x, [1, 2]), "head"));
      });
    }

    return {
      classes: CLASSES,
      size: SIZE,
      // Probabilities by class name, for a [height, width, 3] tensor or
      // anything a page can draw: a canvas, an image, a video frame. Always a
      // promise: a picture it cannot read is a rejection, never a throw.
      classify(input) {
        let probabilities;
        try {
          const isTensor = !!(input && input.shape && input.dtype);
          const pixels = isTensor ? input : tf.browser.fromPixels(input);
          try {
            probabilities = predict(pixels);
          } finally {
            if (!isTensor) pixels.dispose();
          }
        } catch (error) {
          return Promise.reject(error);
        }
        return probabilities.data().then((values) => {
          probabilities.dispose();
          return Object.fromEntries(CLASSES.map((label, i) => [label, values[i]]));
        });
      },
      dispose() {
        for (const tensor of Object.values(w)) tensor.dispose();
      },
    };
  }

  if (typeof module !== "undefined" && module.exports) module.exports = { createSafetyModel };
  else root.createSafetyModel = createSafetyModel;
})(typeof globalThis !== "undefined" ? globalThis : this);
