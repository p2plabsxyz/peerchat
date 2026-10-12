// A room key that says who made the room, and a room that moves to a new key
// when somebody is removed from it.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import crypto from "hypercore-crypto";

import { roomRotates } from "../lib/key-chain.js";
import {
  MAX_KNOWN_KEYS,
  checkCreatorProof,
  checkMove,
  knownBefore,
  makeCreatorRoomKey,
  normalizeKnownKeys,
  normalizeMove,
  noteKnownKey,
  roomKeyFromCreator,
  signMove,
} from "../lib/room-move.js";

// The same vector is in PeerSky Mobile's test/protocol/peerchat-room-move.test.mjs.
// If either app changes a byte of a room key or a move, both of these fail.
const CREATOR = crypto.keyPair(Buffer.alloc(32, 0x21));
const CREATOR_KEY = "884b8857f4eaa1613c61504db34d4beaf346517a0e31de3cddd4d9b4201d9d0b";
const OTHER = crypto.keyPair(Buffer.alloc(32, 0x22));
const topicOf = (key) => createHash("sha256").update("peersky-chat:topic:" + key).digest("hex");
const counter = () => {
  let n = 0;
  return () => {
    const bytes = Buffer.alloc(32);
    bytes.writeUInt32BE(++n, 28);
    return bytes;
  };
};
const ROOM = "7fb72ca22e0efb0506a7402bf3d3a1548e2b7244b9ff2d8cb3fb3a063851d932";
const PROOF = "00000000000000000000000000000000000000000000000000000000000172fd";
const CHAIN = { first: 490000, secret: "cd".repeat(32) };
const AT = 1764000000000;
const SIG = "8450b45eab77ebf532d58921b5dc906693a06eeedbdf54ec91306df0722bce213f9999b4cf5fcb62c68a742915f1c8d28bed5c9310dc848f7dd34ef7657e3408";

describe("a room key that says who made the room", () => {
  it("is the same bytes in both apps", () => {
    assert.equal(Buffer.from(CREATOR.publicKey).toString("hex"), CREATOR_KEY);
    assert.equal(roomKeyFromCreator(CREATOR_KEY, "aa".repeat(32)), "09142152a8e7299e52c9dd5c801b899fb2145444eff34b96d47e88552b79517f");
    assert.deepEqual(makeCreatorRoomKey(CREATOR_KEY, counter()), { roomKey: ROOM, creatorProof: PROOF });
  });

  it("carries the mark for a key chain", () => {
    const { roomKey, creatorProof } = makeCreatorRoomKey(CREATOR_KEY);
    assert.ok(roomRotates(roomKey));
    assert.ok(checkCreatorProof(roomKey, CREATOR_KEY, creatorProof));
  });

  it("checks out only for the key and secret that made it", () => {
    const other = Buffer.from(OTHER.publicKey).toString("hex");
    assert.ok(checkCreatorProof(ROOM, CREATOR_KEY, PROOF));
    assert.ok(checkCreatorProof(ROOM.toUpperCase(), CREATOR_KEY.toUpperCase(), PROOF));
    assert.equal(checkCreatorProof(ROOM, other, PROOF), false);
    assert.equal(checkCreatorProof(ROOM, CREATOR_KEY, "00".repeat(32)), false);
    assert.equal(checkCreatorProof("ab".repeat(32), CREATOR_KEY, PROOF), false);
    assert.equal(checkCreatorProof(ROOM, "", PROOF), false);
    assert.equal(checkCreatorProof(ROOM, CREATOR_KEY, ""), false);
    assert.throws(() => makeCreatorRoomKey("not a key"));
  });
});

describe("a room moving to a new key", () => {
  const FROM = topicOf("ef".repeat(32));
  const signed = () => signMove({ fromTopic: FROM, topicOf, to: ROOM, proof: PROOF, chain: CHAIN, at: AT, keyPair: CREATOR });

  it("is signed the same in both apps", () => {
    const move = signMove({ fromTopic: topicOf(ROOM), topicOf, to: ROOM, proof: PROOF, chain: CHAIN, at: AT, keyPair: CREATOR });
    assert.equal(move.sig, SIG);
    assert.ok(checkMove({ fromTopic: topicOf(ROOM), creatorKey: CREATOR_KEY, move, topicOf }));
  });

  it("checks out from the creator, to a key the same creator made", () => {
    assert.ok(checkMove({ fromTopic: FROM, creatorKey: CREATOR_KEY, move: signed(), topicOf }));
  });

  it("does not check out once anything in it changes", () => {
    const move = signed();
    const other = Buffer.from(OTHER.publicKey).toString("hex");
    const fails = (changes, extra = {}) => assert.equal(
      checkMove({ fromTopic: FROM, creatorKey: CREATOR_KEY, move: { ...move, ...changes }, topicOf, ...extra }),
      false,
    );
    fails({ at: AT + 1 });
    fails({ chain: { ...CHAIN, secret: "ce".repeat(32) } });
    fails({ chain: { ...CHAIN, first: CHAIN.first + 1 } });
    fails({ proof: "00".repeat(32) });
    fails({ to: "ab".repeat(32) });
    fails({}, { fromTopic: topicOf("aa".repeat(32)) });
    fails({}, { creatorKey: other });
  });

  it("is not taken from anyone but the creator, even to a room they made", () => {
    const { roomKey, creatorProof } = makeCreatorRoomKey(Buffer.from(OTHER.publicKey).toString("hex"));
    const move = signMove({ fromTopic: FROM, topicOf, to: roomKey, proof: creatorProof, chain: CHAIN, at: AT, keyPair: OTHER });
    assert.equal(checkMove({ fromTopic: FROM, creatorKey: CREATOR_KEY, move, topicOf }), false);
  });

  it("is not made to a key without the mark", () => {
    const unmarked = roomKeyFromCreator(CREATOR_KEY, "01".repeat(32));
    assert.equal(roomRotates(unmarked), false);
    const move = signMove({ fromTopic: FROM, topicOf, to: unmarked, proof: "01".repeat(32), chain: CHAIN, at: AT, keyPair: CREATOR });
    assert.equal(checkMove({ fromTopic: FROM, creatorKey: CREATOR_KEY, move, topicOf }), false);
  });

  it("is null with any part missing", () => {
    const move = signed();
    for (const missing of ["to", "proof", "chain", "at", "sig"]) {
      assert.equal(normalizeMove({ ...move, [missing]: undefined }), null);
    }
    assert.equal(signMove({ fromTopic: FROM, topicOf, to: ROOM, proof: PROOF, chain: CHAIN, at: AT, keyPair: {} }), null);
  });
});

describe("who a device has seen in a room", () => {
  const key = (n) => n.toString(16).padStart(64, "0");

  it("keeps when each key was first seen, and moves the last sighting along", () => {
    const known = {};
    assert.ok(noteKnownKey(known, key(1), 1000));
    assert.equal(noteKnownKey(known, key(1), 2000), false);
    assert.equal(noteKnownKey(known, key(1), 70_000), false);
    assert.ok(noteKnownKey(known, key(1), 3_700_000));
    assert.deepEqual(known[key(1)], [1000, 3_700_000]);
    assert.ok(knownBefore(known, key(1), 1001));
    assert.equal(knownBefore(known, key(1), 1000), false);
    assert.equal(knownBefore(known, key(2), Infinity), false);
    assert.equal(noteKnownKey(known, "not a key", 1), false);
  });

  it("is bounded, and the ones seen longest ago go first", () => {
    const known = {};
    for (let i = 1; i <= MAX_KNOWN_KEYS + 1; i++) noteKnownKey(known, key(i), i * 100);
    assert.ok(Object.keys(known).length <= MAX_KNOWN_KEYS);
    assert.equal(known[key(1)], undefined);
    assert.ok(known[key(MAX_KNOWN_KEYS + 1)]);
  });

  it("keeps only well-formed entries when read back", () => {
    assert.deepEqual(normalizeKnownKeys({
      [key(1)]: [10, 20],
      [key(2)]: [20, 10],
      nope: [1, 2],
      [key(3)]: "x",
    }), { [key(1)]: [10, 20] });
  });
});
