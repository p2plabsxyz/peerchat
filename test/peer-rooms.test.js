// Drives a real Protomux channel over TCP against a live initChat instance and
// pins the topics handshake: all mutual rooms open, not just the lucky one.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";

import { handleChatRequest, initChat, deriveTopic } from "../p2p.js";
import { attachChatTransport } from "../transport.js";
import { topicHex } from "../routing.js";
import { securePair } from "./helpers.mjs";

const ROOM_X = "aa".repeat(32);
const ROOM_Y = "bb".repeat(32);
const ROOM_Z = "cc".repeat(32);

const swarm = new EventEmitter();
swarm.flush = async () => {};
// Minimal in-memory feed so paths requiring roomFeeds stay live.
function fakeFeed() {
  const feed = new EventEmitter();
  feed.length = 0;
  feed.ready = async () => {};
  feed.get = async () => { throw new Error("empty"); };
  feed.append = async () => { feed.length++; };
  return feed;
}
const sdk = {
  publicKey: Buffer.alloc(32, 7),
  corestore: { get: () => fakeFeed() },
  join() {},
  swarm,
};

function savedRoom(roomKey, name) {
  return {
    roomKey, name, isHost: true, bio: "", link: "", avatar: null,
    createdAt: Date.now(), createdBy: "07070707", createdByName: "me",
    isPinned: false, isMuted: false, unreadCount: 0, unreadMentions: 0,
    lastMessage: null, members: {},
  };
}

async function call(action, method, body, roomKey) {
  const qs = `hyper://chat?action=${action}${roomKey ? `&roomKey=${roomKey}` : ""}`;
  const res = await handleChatRequest({ url: qs, method, json: async () => body ?? {} }, sdk);
  return JSON.parse(await res.text());
}

describe("room handshake over a live connection", () => {
  let pair, transport;
  const frames = [];
  const waiters = [];
  let dir;

  const onFrame = (frame) => {
    frames.push(frame);
    for (let i = waiters.length - 1; i >= 0; i--) {
      if (waiters[i].match(frame)) waiters.splice(i, 1)[0].resolve(frame);
    }
  };

  const nextFrame = (match, label, timeoutMs = 30_000) => {
    const hit = frames.find(match);
    if (hit) return Promise.resolve(hit);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timed out waiting for ${label}`)), timeoutMs);
      waiters.push({ match, resolve: (f) => { clearTimeout(timer); resolve(f); } });
    });
  };

  before(async () => {
    dir = mkdtempSync(path.join(tmpdir(), "peerchat-handshake-"));
    writeFileSync(path.join(dir, "chat.json"), JSON.stringify({
      v: 1, profile: { username: "tester" }, peerProfiles: {}, pendingDMs: {},
      rooms: { [ROOM_X]: savedRoom(ROOM_X, "Room X"), [ROOM_Y]: savedRoom(ROOM_Y, "Room Y") },
    }));
    initChat(sdk, { storagePath: path.join(dir, "chat.json") });
    await new Promise((r) => setTimeout(r, 200));

    pair = await securePair();
    // The chat side sees an inbound connection whose topics name ONLY room X.
    swarm.emit("connection", pair.serverStream, { topics: [deriveTopic(ROOM_X)] });

    let buffer = "";
    const opened = new Promise((r) => {
      transport = attachChatTransport(pair.clientStream, (raw) => {
        buffer += raw.toString();
        const lines = buffer.split("\n");
        buffer = lines.pop();
        for (const line of lines) {
          if (!line) continue;
          try { onFrame(JSON.parse(line)); } catch {}
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

  it("starts with only the connection-forming room shared", async () => {
    // Sync on net-status, not the announce frame (re-sent on ping cadence).
    let status;
    for (let i = 0; i < 100; i++) {
      status = await call("net-status", "GET");
      if (status.peers.length === 1) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.equal(status.peers.length, 1, "peer never activated");
    assert.deepEqual(status.peers[0].rooms, [ROOM_X]);
    assert.equal(status.peers[0].handshake, false, "no topics received from us yet");
  });

  it("opens every mutually held room when the peer's topics arrive", async () => {
    transport.send(JSON.stringify({
      type: "topics",
      topics: [topicHex(deriveTopic(ROOM_X)), topicHex(deriveTopic(ROOM_Y))],
    }) + "\n");

    for (let i = 0; i < 40; i++) {
      const status = await call("net-status", "GET");
      if (status.peers[0]?.rooms.includes(ROOM_Y)) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    const status = await call("net-status", "GET");
    assert.deepEqual([...status.peers[0].rooms].sort(), [ROOM_X, ROOM_Y]);
    assert.equal(status.peers[0].handshake, true);

    await nextFrame((f) => f.type === "room-meta" && f.roomKey === ROOM_Y, "room-meta backfill for Y");
  });

  it("never widens to rooms the peer did not announce and we both hold", async () => {
    const status = await call("net-status", "GET");
    assert.ok(!status.peers[0].rooms.includes(ROOM_Z));
  });

  it("announces the full topic set when a new room is joined", async () => {
    const joining = call("join", "POST", {}, ROOM_Z);
    const announce = await nextFrame(
      (f) => f.type === "topics" && f.topics.includes(topicHex(deriveTopic(ROOM_Z))),
      "topics re-announce including room Z",
    );
    // Full set, never a delta.
    assert.ok(announce.topics.includes(topicHex(deriveTopic(ROOM_X))));
    assert.ok(announce.topics.includes(topicHex(deriveTopic(ROOM_Y))));
    await joining;
  });
});
