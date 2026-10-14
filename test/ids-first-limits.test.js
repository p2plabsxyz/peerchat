// The ids a device asks its neighbours for are kept in one list for every room,
// and one member could fill it with made-up ids, from P2P Republic say, so that
// real ids from every other room were not asked for. Each connection, and each
// room, now has a share of the list. Over real connections.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import crypto from "hypercore-crypto";

import { initChat, deriveTopic } from "../p2p.js";
import { attachChatTransport } from "../transport.js";
import { securePair, topicsFrame, wireRoom } from "./helpers.mjs";

// A big room anyone can be in, a second one, and a small one of friends.
const BUSY = "c3".repeat(32);
const CROWDED = "c4".repeat(32);
const QUIET = "c5".repeat(32);
const DESK = crypto.keyPair(Buffer.alloc(32, 121));
const pair = (n) => crypto.keyPair(Buffer.alloc(32, n));
const newId = () => randomBytes(16).toString("hex");
const madeUp = (count) => Array.from({ length: count }, newId);

const swarm = new EventEmitter();
swarm.flush = async () => {};
const feeds = new Map();
function fakeFeed() {
  const feed = new EventEmitter();
  feed.entries = [];
  Object.defineProperty(feed, "length", { get: () => feed.entries.length });
  feed.ready = async () => {};
  feed.get = async (index) => feed.entries[index];
  feed.append = async (entry) => { feed.entries.push(entry); feed.emit("append"); };
  return feed;
}
const sdk = {
  publicKey: DESK.publicKey,
  corestore: {
    get: ({ name }) => feeds.get(name) || feeds.set(name, fakeFeed()).get(name),
    createKeyPair: async (name) => (name === "noise" ? DESK : crypto.keyPair()),
  },
  join() {},
  swarm,
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function eventually(check, label) {
  for (let i = 0; i < 100; i++) {
    const value = await check();
    if (value) return value;
    await sleep(20);
  }
  throw new Error(`timed out waiting for ${label}`);
}

const open = [];
async function connect(keyPair, roomKeys) {
  const pair = await securePair({ clientKeyPair: keyPair });
  const peer = { pair, frames: [] };
  open.push(peer);
  swarm.emit("connection", pair.serverStream, { topics: roomKeys.map(deriveTopic) });
  let buffer = "";
  await new Promise((opened) => {
    peer.transport = attachChatTransport(pair.clientStream, (raw) => {
      buffer += raw.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop();
      for (const line of lines) {
        if (line) { try { peer.frames.push(JSON.parse(line)); } catch {} }
      }
    }, { onopen: opened });
  });
  peer.send = (frame) => peer.transport.send(JSON.stringify(frame) + "\n");
  peer.send({ ...JSON.parse(topicsFrame(pair.clientStream, roomKeys)), pass: true, have: true });
  await eventually(() => peer.frames.find((frame) => frame.type === "sync-done"), "the rooms opening");
  peer.asked = () => peer.frames.filter((frame) => frame.type === "want").flatMap((frame) => frame.ids || []);
  // Ids in frames of 256, as a sender packs them.
  peer.has = (roomKey, ids) => {
    for (let i = 0; i < ids.length; i += 256) peer.send({ type: "have", room: wireRoom(roomKey), ids: ids.slice(i, i + 256) });
  };
  return peer;
}

let dir;

before(() => {
  dir = mkdtempSync(path.join(tmpdir(), "peerchat-ids-limits-"));
  const room = (roomKey, name) => ({
    roomKey, name, isHost: false, bio: "", link: "", avatar: null,
    createdAt: Date.now() - 60_000, joinedAt: Date.now() - 60_000, createdBy: "", createdByName: "",
    isPinned: false, isMuted: false, unreadCount: 0, unreadMentions: 0,
    lastMessage: null, members: {}, bans: [],
  });
  writeFileSync(path.join(dir, "chat.json"), JSON.stringify({
    v: 1, profile: { username: "Desk" }, peerProfiles: {}, pendingDMs: {},
    rooms: { [BUSY]: room(BUSY, "Busy"), [CROWDED]: room(CROWDED, "Crowded"), [QUIET]: room(QUIET, "Quiet") },
  }));
  initChat(sdk, { storagePath: path.join(dir, "chat.json") });
});

after(async () => {
  for (const peer of open) {
    try { peer.transport?.close(); } catch {}
    await peer.pair.close().catch(() => {});
  }
  if (dir) rmSync(dir, { recursive: true, force: true });
});

describe("ids asked for", () => {
  it("are 512 at most from one connection, so a real id from somebody else is still asked for", async () => {
    const flooder = await connect(pair(122), [BUSY]);
    const friend = await connect(pair(123), [QUIET]);
    // 4096 made-up ids, the whole list, inside the connection's 6000 a minute.
    flooder.has(BUSY, madeUp(4096));
    await eventually(() => flooder.asked().length >= 512, "the first ids asked for");
    await sleep(200);
    assert.equal(flooder.asked().length, 512);
    const real = newId();
    friend.has(QUIET, [real]);
    await eventually(() => friend.asked().includes(real), "the real id asked for");
  });

  it("are 2048 at most for one room, so one room cannot crowd out the others", async () => {
    const flooders = [];
    for (let n = 0; n < 5; n++) flooders.push(await connect(pair(130 + n), [CROWDED]));
    for (const flooder of flooders) {
      flooder.has(CROWDED, madeUp(512));
      await sleep(100);
    }
    await sleep(300);
    const asked = flooders.reduce((sum, flooder) => sum + flooder.asked().length, 0);
    assert.equal(asked, 2048);
    const friend = await connect(pair(140), [QUIET]);
    const real = newId();
    friend.has(QUIET, [real]);
    await eventually(() => friend.asked().includes(real), "the real id asked for");
  });
});
