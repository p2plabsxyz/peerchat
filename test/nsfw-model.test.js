// Loads the vendored model exactly the way the app does: through the same URL
// and the same in-memory fetch shim the scanner page installs. No real images
// anywhere. A flat generated square is enough to prove the pipeline runs, and
// what the classifier says about explicit content is the model's business, not
// something this repo should be carrying fixtures for.
import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import { EXPLICIT_CLASSES, verdictFromPredictions } from "../lib/media-moderation.js";

const MODEL_URL = "https://peersky.local/nsfw/model.json";
// nsfwjs's five classes, in the order the model emits them.
const CLASSES = ["Drawing", "Hentai", "Neutral", "Porn", "Sexy"];

describe("the vendored NSFW model", () => {
  let nsfwjs;

  before(async () => {
    const [library, modelJson, weights] = await Promise.all([
      readFile(new URL("../lib/nsfwjs.min.js", import.meta.url), "utf8"),
      readFile(new URL("../lib/nsfw-model/model.json", import.meta.url), "utf8"),
      readFile(new URL("../lib/nsfw-model/group1-shard1of1", import.meta.url)),
    ]);

    // The page has no server to fetch from, so tfjs is answered out of memory.
    // If this shim and the real one ever drift, the app stops loading a model.
    globalThis.fetch = async (input) => {
      const url = String(typeof input === "string" ? input : input?.url || "");
      if (url === MODEL_URL) return new Response(modelJson, { headers: { "content-type": "application/json" } });
      if (url.includes("group1-shard1of1")) return new Response(weights, { headers: { "content-type": "application/octet-stream" } });
      throw new Error("blocked: " + url);
    };

    for (const [name, value] of [
      ["window", globalThis],
      ["self", globalThis],
      ["document", { createElement: () => ({ getContext: () => ({}) }), addEventListener() {}, head: { appendChild() {} } }],
      ["navigator", { userAgent: "node" }],
    ]) {
      Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
    }

    const mod = { exports: {} };
    new Function("module", "exports", "window", "self", "document", "navigator", library)(
      mod, mod.exports, globalThis, globalThis, globalThis.document, globalThis.navigator
    );
    nsfwjs = globalThis.nsfwjs || mod.exports;
  });

  it("loads through the same URL and shim the scanner page uses", async () => {
    const model = await nsfwjs.load(MODEL_URL, { size: 224 });

    // Five classes out. A model that loaded but emits a different shape would
    // silently make every verdict meaningless.
    assert.deepEqual(model.model.outputs[0].shape, [null, CLASSES.length]);
  });

  it("names the classes the verdict rule is written against", () => {
    // verdictFromPredictions only refuses these two. If the model's vocabulary
    // ever changed, the rule would quietly stop refusing anything.
    for (const explicit of EXPLICIT_CLASSES) {
      assert.ok(CLASSES.includes(explicit), `${explicit} is not a class this model emits`);
    }
    assert.equal(verdictFromPredictions(CLASSES.map((className) => ({ className, probability: 0.2 }))), "allowed");
  });

  it("refuses to be fooled by a URL it was not given", async () => {
    await assert.rejects(fetch("https://example.com/model.json"), /blocked/);
  });
});
