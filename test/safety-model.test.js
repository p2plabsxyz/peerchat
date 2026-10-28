// Loads the safety model the way the page does: nsfwjs first, whose TensorFlow.js
// engine and CPU backend tf-core then runs on, then the forward pass over the
// packed weights. Two generated pictures, no real ones: the original model
// (image-safety-classifier-s, run in ONNX Runtime) gave these answers for them,
// and the packed weights must stay within a hair of it, so a mistake in the
// forward pass or the packing shows up here.
import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import { GRAPHIC_CLASS } from "../lib/media-moderation.js";

const SIZE = 224;
const PICTURES = {
  stripes: {
    pixel: (y, x, c) => (x * 3 + y * 5 + c * 85) % 256,
    expected: { NSFL: 0.03254, NSFW: 0.04069, SFW: 0.92678 },
  },
  warm: {
    pixel: (y, x, c) => [200 - (y >> 1), 90 + (x >> 2), 60][c],
    expected: { NSFL: 0.03176, NSFW: 0.03829, SFW: 0.92995 },
  },
};

function evaluate(source, globals = {}) {
  const mod = { exports: {} };
  new Function("module", "exports", ...Object.keys(globals), source)(mod, mod.exports, ...Object.values(globals));
  return mod.exports;
}

describe("the vendored safety model", () => {
  let tf;
  let model;

  before(async () => {
    const read = (path) => readFile(new URL(path, import.meta.url));
    for (const [name, value] of [
      ["window", globalThis],
      ["self", globalThis],
      ["document", { createElement: () => ({ getContext: () => ({}) }), addEventListener() {}, head: { appendChild() {} } }],
      ["navigator", { userAgent: "node" }],
    ]) {
      Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
    }
    evaluate(String(await read("../lib/nsfwjs.min.js")), {
      window: globalThis, self: globalThis, document: globalThis.document, navigator: globalThis.navigator,
    });
    tf = evaluate(String(await read("../lib/tf-core.min.js")));
    const { createSafetyModel } = evaluate(String(await read("../lib/safety-model.js")));
    const manifest = JSON.parse(String(await read("../lib/safety-model/manifest.json")));
    model = createSafetyModel(tf, manifest, new Uint8Array(await read("../lib/safety-model/weights")));
  });

  it("runs on the engine and backend nsfwjs brought", async () => {
    // tf-core has no backend of its own: this is the one nsfwjs registered.
    await tf.ready();
    assert.equal(tf.getBackend(), "cpu");
  });

  it("gives the original model's answers", async () => {
    for (const [name, picture] of Object.entries(PICTURES)) {
      const pixels = new Float32Array(SIZE * SIZE * 3);
      for (let y = 0; y < SIZE; y++) {
        for (let x = 0; x < SIZE; x++) {
          for (let c = 0; c < 3; c++) pixels[(y * SIZE + x) * 3 + c] = picture.pixel(y, x, c);
        }
      }
      const input = tf.tensor3d(pixels, [SIZE, SIZE, 3]);
      const scores = await model.classify(input);
      input.dispose();
      for (const [label, expected] of Object.entries(picture.expected)) {
        assert.ok(Math.abs(scores[label] - expected) < 0.01, `${name} ${label}: ${scores[label]} instead of ${expected}`);
      }
    }
  });

  it("names the class the graphic rule reads", () => {
    assert.deepEqual(model.classes, ["NSFL", "NSFW", "SFW"]);
    assert.ok(model.classes.includes(GRAPHIC_CLASS));
  });

  it("refuses a picture it cannot read, without throwing", async () => {
    await assert.rejects(model.classify({}));
  });

  it("leaves nothing behind in the engine", async () => {
    const before = tf.memory().numTensors;
    const input = tf.zeros([SIZE, SIZE, 3]);
    await model.classify(input);
    input.dispose();
    assert.equal(tf.memory().numTensors, before);
  });
});
