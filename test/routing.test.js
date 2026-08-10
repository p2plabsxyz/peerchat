import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  addedRooms,
  peerMatchesIdentity,
  peerSharesRoom,
  roomKeyFromTopic,
  sharedRoomsFromTopics,
} from "../routing.js";

const ROOM_A = "aa".repeat(32);
const ROOM_B = "bb".repeat(32);
const ROOM_C = "cc".repeat(32);

describe("PeerChat routing", () => {
  it("normalizes Buffer and string topics to room keys", () => {
    assert.equal(roomKeyFromTopic(Buffer.from(ROOM_A, "hex")), ROOM_A);
    assert.equal(roomKeyFromTopic(ROOM_B.toUpperCase()), ROOM_B);
    assert.equal(roomKeyFromTopic("not-a-topic"), "");
  });

  it("keeps only topics that are joined locally", () => {
    const topics = [
      Buffer.from(ROOM_A, "hex"),
      Buffer.from(ROOM_C, "hex"),
      Buffer.from(ROOM_A, "hex"),
    ];

    assert.deepEqual(
      sharedRoomsFromTopics(topics, new Set([ROOM_A, ROOM_B])),
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
