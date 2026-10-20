// The person key and its signature, which PeerSky Mobile has to make and check
// byte for byte the same (backend/peerchat/person-proof.mjs there).
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { checkPersonProof, makePersonProof, personKey } from "../lib/person-proof.js";

const LINK = { key: "ef".repeat(32) };
const DEVICE = "0d".repeat(32);

describe("a person's devices, shown to anyone", () => {
  it("is the same key and signature on the phone", () => {
    assert.equal(personKey(LINK), "d3bf15e8fadd5284f2181aa53140f5678eb927d22156b3823c33c41b407a57f8");
    assert.deepEqual(makePersonProof(LINK, DEVICE), {
      key: "d3bf15e8fadd5284f2181aa53140f5678eb927d22156b3823c33c41b407a57f8",
      sig: "022f768ba313a8b2531b47ca82f5a333f8a137e870e88b2725d67f22239e8b3400ad007cde84ecdcbdb093b92211c6a0dc4f80de51711542427707225ec9e50d",
    });
  });

  it("names the person only for the device the signature was made for", () => {
    const proof = makePersonProof(LINK, DEVICE);
    assert.equal(checkPersonProof(proof, DEVICE), personKey(LINK));
    assert.equal(checkPersonProof(proof, "0e".repeat(32)), "");
    assert.equal(checkPersonProof({ ...proof, key: personKey({ key: "aa".repeat(32) }) }, DEVICE), "");
    assert.equal(checkPersonProof({ key: proof.key, sig: "00".repeat(64) }, DEVICE), "");
    assert.equal(checkPersonProof(null, DEVICE), "");
    assert.equal(makePersonProof(null, DEVICE), null);
  });
});
