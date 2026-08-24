import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  addedRooms,
  peerMatchesIdentity,
  peerSharesRoom,
  sharedRoomsFromTopics,
  topicHex,
} from "../routing.js";

const ROOM_A = "aa".repeat(32);
const ROOM_B = "bb".repeat(32);
const ROOM_C = "cc".repeat(32);
const TOPIC_A = "11".repeat(32);
const TOPIC_B = "22".repeat(32);
const TOPIC_UNKNOWN = "33".repeat(32);

describe("PeerChat routing", () => {
  it("normalizes Buffer and string topics for discovery lookup", () => {
    assert.equal(topicHex(Buffer.from(TOPIC_A, "hex")), TOPIC_A);
    assert.equal(topicHex(TOPIC_B.toUpperCase()), TOPIC_B);
    assert.equal(topicHex("not-a-topic"), "");
  });

  it("looks up rooms without assuming the topic contains the room key", () => {
    const topics = [
      Buffer.from(TOPIC_A, "hex"),
      Buffer.from(TOPIC_UNKNOWN, "hex"),
      Buffer.from(TOPIC_A, "hex"),
    ];
    const discoveryKeys = new Map([
      [TOPIC_A, ROOM_A],
      [TOPIC_B, ROOM_B],
    ]);

    assert.deepEqual(
      sharedRoomsFromTopics(topics, discoveryKeys),
      [ROOM_A]
    );
  });

  it("checks room and identity routing independently", () => {
    const peer = { id: "a1b2c3d4", fullId: "a1b2c3d4".repeat(8), rooms: [ROOM_A] };

    assert.equal(peerSharesRoom(peer, ROOM_A), true);
    assert.equal(peerSharesRoom(peer, ROOM_B), false);
    assert.equal(peerMatchesIdentity(peer, "A1B2C3D4"), true);
    assert.equal(peerMatchesIdentity(peer, peer.fullId), true);
    assert.equal(peerMatchesIdentity(peer, "ffffffff"), false);
  });

  it("returns only newly shared rooms after a topic change", () => {
    assert.deepEqual(addedRooms([ROOM_A], [ROOM_A, ROOM_B]), [ROOM_B]);
    assert.deepEqual(addedRooms([ROOM_A, ROOM_B], [ROOM_B]), []);
  });
});
