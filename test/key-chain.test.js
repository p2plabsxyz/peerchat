// Room keys that rotate, so a stolen key cannot read old messages.
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  KEY_HOUR_MS,
  chainSecretAt,
  currentKeyGift,
  earlierKeyChain,
  hourOf,
  makeRotatingRoomKey,
  messageKeyAt,
  newKeyChain,
  roomRotates,
  takeKeyGift,
} from "../lib/key-chain.js";

// The same vector is in PeerSky Mobile's test/protocol/peerchat-key-chain.test.mjs.
// If either app changes a byte of the chain, both of these fail.
const CHAIN = { first: 490000, secret: "11".repeat(32) };
const MARKED = "7d7d9b49efb7ed5d6b3594fec3ecc129a689cc3d226b479d7fa329062d7bbd92";
const REPUBLIC = "bc8f61ba9f96a181bb26e0221e5caefc48e5987c89ccd1292cefa3b4e544c845";

describe("rotating room keys", () => {
  it("works out the same keys as the phone", () => {
    assert.equal(chainSecretAt(CHAIN, 490002), "f1e0270a239eaaa0873b88aeeb5c3ecbf44f4ca6b906a4fc6e12340444b70b59");
    assert.equal(messageKeyAt(CHAIN, 490002).toString("hex"), "fdb6e2c1df9797f5259bb9c5dcab8d53b5adb5ba4c5ffd9c8c9a9311b4688f57");
    assert.equal(roomRotates(MARKED), true);
  });

  it("leaves every room made before this as it was, P2P Republic included", () => {
    assert.equal(roomRotates(REPUBLIC), false);
    assert.equal(roomRotates("not a key"), false);
  });

  it("goes forward only: nothing before the first hour a device holds", () => {
    assert.equal(chainSecretAt(CHAIN, 489999), null);
    assert.equal(messageKeyAt(CHAIN, 489999), null);
    // Out of order asks give the same answers as in order ones.
    const later = chainSecretAt(CHAIN, 490010);
    assert.equal(chainSecretAt(CHAIN, 490002), "f1e0270a239eaaa0873b88aeeb5c3ecbf44f4ca6b906a4fc6e12340444b70b59");
    assert.equal(chainSecretAt(CHAIN, 490010), later);
    assert.notEqual(chainSecretAt(CHAIN, 490011), later);
  });

  it("makes new rooms that carry the mark, with a chain for this hour", () => {
    const key = makeRotatingRoomKey();
    assert.equal(roomRotates(key), true);
    const now = 490000 * KEY_HOUR_MS + 5;
    assert.equal(newKeyChain(now).first, 490000);
    assert.match(newKeyChain(now).secret, /^[0-9a-f]{64}$/);
  });

  it("gives a joining member the current hour and nothing older", () => {
    const now = 490003 * KEY_HOUR_MS + 1000;
    assert.deepEqual(currentKeyGift(CHAIN, now), { e: 490003, secret: chainSecretAt(CHAIN, 490003) });
    assert.equal(hourOf(now), 490003);
  });

  it("takes a key from the room only when it has none, and only for about now", () => {
    const now = 490003 * KEY_HOUR_MS;
    const gift = currentKeyGift(CHAIN, now);
    assert.deepEqual(takeKeyGift(null, gift, now), { chain: { first: 490003, secret: gift.secret }, taken: true });
    // A far hour is not trusted, from anybody.
    assert.equal(takeKeyGift(null, { e: 490003 - 30, secret: gift.secret }, now).taken, false);
    // A device with a chain keeps it, and says whether the two agree.
    assert.deepEqual(takeKeyGift(CHAIN, gift, now), { chain: CHAIN, taken: false, agrees: true });
    assert.equal(takeKeyGift(CHAIN, { e: 490003, secret: "22".repeat(32) }, now).agrees, false);
    assert.equal(takeKeyGift(null, { e: 490003, secret: "nope" }, now).taken, false);
  });

  it("lets the person's own devices share the earliest start of one chain", () => {
    const later = { first: 490005, secret: chainSecretAt(CHAIN, 490005) };
    assert.deepEqual(earlierKeyChain(later, CHAIN), CHAIN);
    assert.deepEqual(earlierKeyChain(CHAIN, later), CHAIN);
    // Not a different chain claiming to be earlier.
    assert.deepEqual(earlierKeyChain(later, { first: 489000, secret: "33".repeat(32) }), later);
  });
});
