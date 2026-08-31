// Messages sent while a peer is away must arrive when they reconnect, via the
// per-message sync that runs on activation and on handshake-opened rooms.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";

import { handleChatRequest, initChat, deriveTopic, decryptMsg } from "../p2p.js";
import { attachChatTransport } from "../transport.js";
import { topicHex } from "../routing.js";
import { securePair } from "./helpers.mjs";

const ROOM_X = "aa".repeat(32);
const ROOM_Y = "bb".repeat(32);
const M1 = "sent in X while you were offline";
const M2 = "sent in Y while you were offline";
const M3 = "sent live while connected";

const swarm = new EventEmitter();
swarm.flush = async () => {};
// In-memory feed that stores entries so history sync has something to read.
function fakeFeed() {
  const feed = new EventEmitter();
  const entries = [];
  feed.length = 0;
  feed.ready = async () => {};
  feed.get = async (i) => entries[i];
  feed.append = async (entry) => { entries.push(entry); feed.length = entries.length; feed.emit("append"); };
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

describe("offline delivery", () => {
  let pair, transport, dir;
  const frames = [];
  const waiters = [];

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
  const encryptedFor = (roomKey, plaintext) => (f) => {
    if (f.roomKey !== roomKey || !f.ct || !f.iv || !f.tag) return false;
    try { return decryptMsg(f.ct, f.iv, f.tag, roomKey) === plaintext; } catch { return false; }
  };

  before(async () => {
    dir = mkdtempSync(path.join(tmpdir(), "peerchat-offline-"));
    writeFileSync(path.join(dir, "chat.json"), JSON.stringify({
      v: 1, profile: { username: "tester" }, peerProfiles: {}, pendingDMs: {},
      rooms: { [ROOM_X]: savedRoom(ROOM_X, "X"), [ROOM_Y]: savedRoom(ROOM_Y, "Y") },
    }));
    initChat(sdk, { storagePath: path.join(dir, "chat.json") });
    await new Promise((r) => setTimeout(r, 200));
  });

  after(async () => {
    try { transport?.close(); } catch {}
    await pair?.close();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("accepts messages while no peer is connected", async () => {
    assert.equal((await call("send", "POST", { message: M1 }, ROOM_X)).error, undefined);
    assert.equal((await call("send", "POST", { message: M2 }, ROOM_Y)).error, undefined);
  });

  it("delivers missed messages when the peer comes online", async () => {
    pair = await securePair();
    swarm.emit("connection", pair.serverStream, { topics: [deriveTopic(ROOM_X)] });

    let buffer = "";
    transport = attachChatTransport(pair.clientStream, (raw) => {
      buffer += raw.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop();
      for (const line of lines) {
        if (!line) continue;
        try { onFrame(JSON.parse(line)); } catch {}
      }
    }, {});

    await nextFrame(encryptedFor(ROOM_X, M1), "missed message in the connection-forming room");
  });

  it("delivers missed messages in rooms opened by the topics handshake", async () => {
    transport.send(JSON.stringify({
      type: "topics",
      topics: [topicHex(deriveTopic(ROOM_X)), topicHex(deriveTopic(ROOM_Y))],
    }) + "\n");

    await nextFrame(encryptedFor(ROOM_Y, M2), "missed message in the handshake-opened room");
  });

  it("delivers live messages while connected", async () => {
    await call("send", "POST", { message: M3 }, ROOM_X);
    await nextFrame(encryptedFor(ROOM_X, M3), "live message");
  });
});
