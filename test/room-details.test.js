// A room's details, signed by the person who made the room.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import crypto from "hypercore-crypto";

import {
  avatarHash,
  checkRoomDetails,
  nextDetailsVersion,
  normalizeRoomDetails,
  signRoomDetails,
} from "../lib/room-details.js";

// The same vector is in PeerSky Mobile's test/protocol/peerchat-room-details.test.mjs.
// If either app changes a byte of what is signed, both of these fail.
const CREATOR = crypto.keyPair(Buffer.alloc(32, 0x21));
const CREATOR_KEY = "884b8857f4eaa1613c61504db34d4beaf346517a0e31de3cddd4d9b4201d9d0b";
const OTHER = crypto.keyPair(Buffer.alloc(32, 0x22));
const topicOf = (key) => createHash("sha256").update("peersky-chat:topic:" + key).digest("hex");
const TOPIC = topicOf("7fb72ca22e0efb0506a7402bf3d3a1548e2b7244b9ff2d8cb3fb3a063851d932");
const PICTURE = "data:image/png;base64,iVBORw0KGgo=";
const INPUT = {
  topic: TOPIC,
  v: 1764000000000,
  name: "Weekend plans",
  bio: "Saturday hike",
  link: "https://example.com/trail",
  avatar: PICTURE,
  moderation: { abuseFilter: true, nsfwFilter: false, spamRateLimit: 15 },
  keyPair: CREATOR,
};
const SIG = "9b5d415a4998afb13d576e456e831bccc6e67e1a241fa6195d878adb8728bbd80e41aed86830a49797f0bf144a60575b31bdcf3a9955c9c2bb6cd09ded02870a";

describe("a room's details, signed by its creator", () => {
  it("are signed the same in both apps", () => {
    assert.equal(TOPIC, "fbbd51376d25756d9e2cc4c1e78ceb54caeea03b367ae2456b2a628d35e14666");
    assert.equal(avatarHash(PICTURE), "e1e10747c2374f621aa59fefede6ef99dc6acdb41b267ab4af408d5529f89ea8");
    const details = signRoomDetails(INPUT);
    assert.equal(details.sig, SIG);
    assert.equal(details.avatar, avatarHash(PICTURE));
    assert.ok(checkRoomDetails({ topic: TOPIC, creatorKey: CREATOR_KEY, details }));
  });

  it("do not check out once anything in them changes, or for another room or person", () => {
    const details = signRoomDetails(INPUT);
    const fails = (changes, extra = {}) => assert.equal(
      checkRoomDetails({ topic: TOPIC, creatorKey: CREATOR_KEY, details: { ...details, ...changes }, ...extra }),
      false,
    );
    fails({ v: details.v + 1 });
    fails({ name: "Weekend plan" });
    fails({ bio: "" });
    fails({ link: "https://example.com/other" });
    fails({ avatar: avatarHash("data:image/png;base64,AAAA") });
    fails({ moderation: { ...details.moderation, abuseFilter: false } });
    fails({ moderation: { ...details.moderation, spamRateLimit: 50 } });
    fails({}, { topic: topicOf("ab".repeat(32)) });
    fails({}, { creatorKey: Buffer.from(OTHER.publicKey).toString("hex") });
  });

  it("are not taken from anyone but the creator", () => {
    const forged = signRoomDetails({ ...INPUT, keyPair: OTHER });
    assert.equal(checkRoomDetails({ topic: TOPIC, creatorKey: CREATOR_KEY, details: forged }), false);
  });

  it("keep only well-formed details", () => {
    const details = signRoomDetails(INPUT);
    assert.deepEqual(normalizeRoomDetails(details), details);
    for (const broken of [
      { ...details, v: 0 },
      { ...details, name: 3 },
      { ...details, name: "x".repeat(401) },
      { ...details, avatar: "not a hash" },
      { ...details, moderation: { ...details.moderation, spamRateLimit: 0 } },
      { ...details, moderation: { abuseFilter: "yes", nsfwFilter: true, spamRateLimit: 10 } },
      { ...details, sig: "00" },
    ]) {
      assert.equal(normalizeRoomDetails(broken), null);
    }
    assert.equal(signRoomDetails({ ...INPUT, keyPair: {} }), null);
    assert.equal(signRoomDetails({ ...INPUT, moderation: { spamRateLimit: 99 } }), null);
  });

  it("move to a newer version every time, even with the clock behind", () => {
    const details = signRoomDetails(INPUT);
    assert.equal(nextDetailsVersion(null, 1000), 1000);
    assert.equal(nextDetailsVersion(details, details.v - 5000), details.v + 1);
    assert.equal(nextDetailsVersion(details, details.v + 5000), details.v + 5000);
  });
});
