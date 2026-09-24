// The member list is what makes a room show everyone who has been in it rather
// than only the peers currently connected. It has to survive the frame cap: a
// room of 64 people carrying data-url avatars is megabytes, and both this side
// and mobile drop an oversized line outright.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";

import { handleChatRequest, initChat, deriveTopic } from "../p2p.js";
import { attachChatTransport } from "../transport.js";
import { securePair } from "./helpers.mjs";

const ROOM = "aa".repeat(32);
const MEMBER_COUNT = 64;
// What the receive side allows: MAX_MSG_LEN * 4 in p2p.js.
const MAX_LINE_BYTES = 64 * 1024 * 4;

const swarm = new EventEmitter();
swarm.flush = async () => {};
function fakeFeed() {
  const feed = new EventEmitter();
  feed.length = 0;
  feed.ready = async () => {};
  feed.get = async () => { throw new Error("empty"); };
  feed.append = async () => { feed.length++; };
  return feed;
}
const sdk = { publicKey: Buffer.alloc(32, 5), corestore: { get: () => fakeFeed() }, join() {}, swarm };

// What resizeImage actually produces: 369px, JPEG q0.8, around 27 KB as a
// data url. Nine of these in one frame is already past what a receiver takes.
function realisticAvatar() {
  return "data:image/jpeg;base64," + "A".repeat(27_000);
}

describe("member list propagation", () => {
  let dir, pair, transport;
  const frames = [];

  before(async () => {
    dir = mkdtempSync(path.join(tmpdir(), "peerchat-members-"));
    const members = {};
    for (let i = 0; i < MEMBER_COUNT; i++) {
      members[i.toString(16).padStart(8, "0")] = {
        username: `Member ${i}`,
        bio: "Here since the start",
        avatar: realisticAvatar(),
        joinedAt: 1_700_000_000_000 + i,
      };
    }
    writeFileSync(path.join(dir, "chat.json"), JSON.stringify({
      v: 1, profile: { username: "tester" }, peerProfiles: {}, pendingDMs: {},
      rooms: {
        [ROOM]: {
          roomKey: ROOM, name: "Crowded", isHost: true, bio: "", link: "", avatar: null,
          createdAt: Date.now(), createdBy: "05050505", createdByName: "me",
          isPinned: false, isMuted: false, unreadCount: 0, unreadMentions: 0,
          lastMessage: null, members,
        },
      },
    }));
    initChat(sdk, { storagePath: path.join(dir, "chat.json") });
    await new Promise((r) => setTimeout(r, 200));

    pair = await securePair();
    swarm.emit("connection", pair.serverStream, { topics: [deriveTopic(ROOM)] });

    let buffer = "";
    const opened = new Promise((r) => {
      transport = attachChatTransport(pair.clientStream, (raw) => {
        buffer += raw.toString();
        const lines = buffer.split("\n");
        buffer = lines.pop();
        for (const line of lines) {
          if (!line) continue;
          try { frames.push({ line, message: JSON.parse(line) }); } catch {}
        }
      }, { onopen: r });
    });
    await opened;
  });

  after(async () => {
    try { transport?.close(); } catch {}
    await pair?.close();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("sends every member, in lines small enough to be accepted", async () => {
    let lists = [];
    for (let i = 0; i < 200; i++) {
      lists = frames.filter((frame) => frame.message.type === "members-list");
      const total = lists.reduce((sum, frame) => sum + Object.keys(frame.message.members).length, 0);
      if (total >= MEMBER_COUNT) break;
      await new Promise((r) => setTimeout(r, 50));
    }

    assert.ok(lists.length > 1, "a crowded room has to be chunked");
    for (const frame of lists) {
      assert.ok(
        Buffer.byteLength(frame.line) < MAX_LINE_BYTES,
        `a ${Buffer.byteLength(frame.line)} byte line would be dropped on receipt`
      );
    }

    const seen = new Set();
    let withPictures = 0;
    for (const frame of lists) {
      for (const [peerId, member] of Object.entries(frame.message.members)) {
        seen.add(peerId);
        assert.ok(member.username, "a member without a name is not worth sending");
        if (member.avatar) withPictures += 1;
      }
    }
    assert.equal(seen.size, MEMBER_COUNT, "everyone has to arrive");
    // Splitting the list is not an excuse to throw the pictures away.
    assert.equal(withPictures, MEMBER_COUNT, "pictures have to survive the split");
  });
});
