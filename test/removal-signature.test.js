// A removal list signed by the room's creator, so that anyone can pass it on
// and a removal reaches people who never meet the creator.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import crypto from "hypercore-crypto";

import {
  checkSignedRemovals,
  nextRemovalsVersion,
  normalizeSignedRemovals,
  pickSigningKeyPair,
  removalsMessage,
  signRemovals,
} from "../lib/removal-signature.js";
import { wireRoom } from "./helpers.mjs";

// The same vector is in PeerSky Mobile's test/protocol/peerchat-removal-signature.test.mjs.
// If either app changes a byte of what is signed, both of these fail.
const CREATOR = crypto.keyPair(Buffer.alloc(32, 1));
const CREATOR_KEY = CREATOR.publicKey.toString("hex");
const TOPIC = wireRoom("ab".repeat(32));
const BANS = [
  { id: "c0ffee11", key: "", at: 1790000000000, name: "Carol" },
  { key: "dd".repeat(32), at: 1790000000001, name: "Dave Two" },
];
const VERSION = 1790000000002;
const SIGNATURE = "d0147b5d6ef93cd662267a14b27de16cd26f44bba4e266b5b04ed611e2cce67b" +
  "a0e0a645c74f2c7dde35174339775cddbe4f57437d8db2855737274a858b7803";

describe("signed removal lists", () => {
  it("signs the same bytes as the phone", () => {
    assert.equal(CREATOR_KEY, "8a88e3dd7409f195fd52db2d3cba5d72ca6709bf1d94121bf3748801b40f6f5c");
    assert.equal(
      removalsMessage(TOPIC, VERSION, BANS),
      `peersky-chat/2 removals\n${TOPIC}\n${VERSION}\n` +
        '[["c0ffee11","",1790000000000,"Carol"],["dddddddd","' + "dd".repeat(32) + '",1790000000001,"Dave Two"]]',
    );
    assert.equal(signRemovals({ topic: TOPIC, version: VERSION, bans: BANS, keyPair: CREATOR }), SIGNATURE);
  });

  it("is believed from anyone, as long as nothing in it changed", () => {
    const signed = { v: VERSION, sig: SIGNATURE };
    assert.equal(checkSignedRemovals({ topic: TOPIC, creatorKey: CREATOR_KEY, bans: BANS, signed }), true);

    // Somebody taking a name off the list, adding one, or changing one.
    assert.equal(checkSignedRemovals({ topic: TOPIC, creatorKey: CREATOR_KEY, bans: BANS.slice(1), signed }), false);
    assert.equal(checkSignedRemovals({
      topic: TOPIC, creatorKey: CREATOR_KEY, signed,
      bans: [...BANS, { id: "eeee0000", at: 1790000000003, name: "Eve" }],
    }), false);
    assert.equal(checkSignedRemovals({
      topic: TOPIC, creatorKey: CREATOR_KEY, signed,
      bans: [{ ...BANS[0], name: "Mallory" }, BANS[1]],
    }), false);
    // Another version, another room, or anybody else's key.
    assert.equal(checkSignedRemovals({ topic: TOPIC, creatorKey: CREATOR_KEY, bans: BANS, signed: { ...signed, v: VERSION + 1 } }), false);
    assert.equal(checkSignedRemovals({ topic: wireRoom("cd".repeat(32)), creatorKey: CREATOR_KEY, bans: BANS, signed }), false);
    const other = crypto.keyPair(Buffer.alloc(32, 2)).publicKey.toString("hex");
    assert.equal(checkSignedRemovals({ topic: TOPIC, creatorKey: other, bans: BANS, signed }), false);
  });

  it("takes nothing that is not a version and a signature", () => {
    assert.deepEqual(normalizeSignedRemovals({ v: VERSION, sig: SIGNATURE }), { v: VERSION, sig: SIGNATURE });
    assert.deepEqual(normalizeSignedRemovals({ v: -1, sig: "nope" }), { v: 0, sig: "" });
    assert.deepEqual(normalizeSignedRemovals(null), { v: 0, sig: "" });
    assert.equal(checkSignedRemovals({ topic: TOPIC, creatorKey: CREATOR_KEY, bans: BANS, signed: null }), false);
    assert.equal(signRemovals({ topic: TOPIC, version: VERSION, bans: BANS, keyPair: { publicKey: CREATOR.publicKey } }), "");
  });

  it("only ever moves the version forward", () => {
    assert.equal(nextRemovalsVersion(0, 5000), 5000);
    assert.equal(nextRemovalsVersion(9000, 5000), 9001);
  });

  it("signs only with the pair behind this device's own key", () => {
    const stranger = crypto.keyPair(Buffer.alloc(32, 3));
    assert.equal(pickSigningKeyPair(CREATOR_KEY, [null, stranger, CREATOR]), CREATOR);
    assert.equal(pickSigningKeyPair(CREATOR_KEY, [stranger]), null);
  });
});
