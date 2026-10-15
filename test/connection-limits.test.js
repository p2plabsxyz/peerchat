// What one connection can make this desktop do. Room details, removal lists,
// moves and asks for room details have a budget a connection, the phone's 60 a
// minute, so a member cannot keep the main process checking signatures and
// answering. And a line with no end closes the connection, so a member cannot
// grow the main process until it runs out of memory. Over real connections.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import crypto from "hypercore-crypto";

import { handleChatRequest, initChat, deriveTopic } from "../p2p.js";
import { attachChatTransport } from "../transport.js";
import { makeCreatorRoomKey, signMove } from "../lib/room-move.js";
import { newKeyChain } from "../lib/key-chain.js";
import { signRoomDetails } from "../lib/room-details.js";
import { signRemovals } from "../lib/removal-signature.js";
import { securePair, topicsFrame, wireRoom } from "./helpers.mjs";

const pair = (n) => crypto.keyPair(Buffer.alloc(32, n));
const keyOf = (keyPair) => keyPair.publicKey.toString("hex");
const DEVICE = pair(151);
const CREATOR = pair(152);
const ROOM = makeCreatorRoomKey(keyOf(CREATOR));
const topic = wireRoom(ROOM.roomKey);

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
  publicKey: DEVICE.publicKey,
  corestore: {
    get: ({ name }) => feeds.get(name) || feeds.set(name, fakeFeed()).get(name),
    createKeyPair: async (name) => (name === "noise" ? DEVICE : crypto.keyPair()),
  },
  join() {},
  leave: async () => {},
  swarm,
};

const call = async (action, method, body, roomKey) => {
  const qs = `hyper://chat?action=${action}${roomKey ? `&roomKey=${roomKey}` : ""}`;
  const res = await handleChatRequest({ url: qs, method, json: async () => body ?? {} }, sdk);
  return JSON.parse(await res.text());
};
const rooms = () => call("get-rooms", "GET");
const roomOf = async () => (await rooms()).rooms.find((room) => room.roomKey === ROOM.roomKey);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function eventually(check, label) {
  for (let i = 0; i < 100; i++) {
    const value = await check();
    if (value) return value;
    await sleep(50);
  }
  throw new Error(`timed out waiting for ${label}`);
}

const open = [];
async function connect(keyPair, { opens = "sync-done" } = {}) {
  const pair = await securePair({ clientKeyPair: keyPair });
  const peer = { pair, frames: [], closed: false };
  open.push(peer);
  swarm.emit("connection", pair.serverStream, { topics: [deriveTopic(ROOM.roomKey)] });
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
  pair.clientStream.on("close", () => { peer.closed = true; });
  peer.send = (frame) => peer.transport.send(JSON.stringify(frame) + "\n");
  peer.send({ ...JSON.parse(topicsFrame(pair.clientStream, [ROOM.roomKey])), pass: true, move: true });
  peer.of = (type) => peer.frames.filter((frame) => frame.type === type);
  await eventually(() => peer.of(opens)[0], "the connection opening");
  return peer;
}

// What the creator signed, which counts from anyone with budget left.
const DETAILS = signRoomDetails({
  topic, v: 50, name: "Renamed", bio: "", link: "", avatar: "",
  moderation: { abuseFilter: true, nsfwFilter: true, spamRateLimit: 10 }, keyPair: CREATOR,
});
const BANS = [{ id: "c0ffee11", key: "", at: Date.now(), name: "Ben" }];
const SIGNED_BANS = { v: 50, sig: signRemovals({ topic, version: 50, bans: BANS, keyPair: CREATOR }) };
const NEXT = makeCreatorRoomKey(keyOf(CREATOR));
const MOVE = signMove({ fromTopic: topic, topicOf: wireRoom, to: NEXT.roomKey, proof: NEXT.creatorProof, chain: newKeyChain(), at: Date.now(), keyPair: CREATOR });
let dir;

before(() => {
  dir = mkdtempSync(path.join(tmpdir(), "peerchat-connection-limits-"));
  writeFileSync(path.join(dir, "chat.json"), JSON.stringify({
    v: 1, profile: { username: "Ada" }, peerProfiles: {}, pendingDMs: {},
    rooms: {
      [ROOM.roomKey]: {
        roomKey: ROOM.roomKey, name: "Club", bio: "", link: "", avatar: null,
        createdAt: Date.now() - 120_000, joinedAt: Date.now() - 60_000,
        isHost: false, isPinned: false, isMuted: false, unreadCount: 0, unreadMentions: 0,
        lastMessage: null, members: {}, bans: [],
        creatorKey: keyOf(CREATOR), creatorProof: ROOM.creatorProof, createdBy: keyOf(CREATOR).slice(0, 8), createdByName: "Cora",
      },
    },
  }));
  initChat(sdk, { storagePath: path.join(dir, "chat.json"), keyPair: DEVICE });
});

after(async () => {
  for (const peer of open) {
    try { peer.transport.close(); } catch {}
    await peer.pair.close().catch(() => {});
  }
  if (dir) rmSync(dir, { recursive: true, force: true });
});

describe("room details, removal lists, moves and asks for room details", () => {
  it("are answered 60 times a minute on one connection, no more", async () => {
    const ben = await connect(pair(153));
    await sleep(100);
    const before = ben.of("room-meta").length;
    for (let i = 0; i < 100; i++) ben.send({ type: "request-room-meta", room: topic });
    await eventually(() => ben.of("room-meta").length >= before + 60, "the answers");
    await sleep(300);
    assert.equal(ben.of("room-meta").length, before + 60);
  });

  it("share the one budget, so what comes after it is spent is dropped", async () => {
    const cora = await connect(pair(154));
    for (let i = 0; i < 60; i++) cora.send({ type: "request-room-meta", room: topic });
    cora.send({ type: "room-meta", room: topic, name: "Renamed", details: DETAILS });
    cora.send({ type: "room-bans", room: topic, bans: BANS, signed: SIGNED_BANS });
    cora.send({ type: "room-moved", room: topic, moves: [MOVE] });
    await sleep(500);
    const room = await roomOf();
    assert.equal(room.name, "Club");
    assert.deepEqual(room.bans, []);
    assert.equal((await rooms()).movedRooms[ROOM.roomKey], undefined);
  });

  it("are taken from another connection with its own budget", async () => {
    const dev = await connect(pair(155));
    dev.send({ type: "room-meta", room: topic, name: "Renamed", details: DETAILS });
    dev.send({ type: "room-bans", room: topic, bans: BANS, signed: SIGNED_BANS });
    await eventually(async () => (await roomOf()).name === "Renamed", "the details");
    await eventually(async () => (await roomOf()).bans.length === 1, "the list");
    dev.send({ type: "room-moved", room: topic, moves: [MOVE] });
    await eventually(async () => (await rooms()).movedRooms[ROOM.roomKey] === NEXT.roomKey, "the move");
  });
});

describe("a line with no end", () => {
  it("closes the connection once it is longer than any line this side reads", async () => {
    // Open as soon as this side says which rooms it is in.
    const eli = await connect(pair(156), { opens: "topics" });
    // As long as the longest line read here, and ended: still read.
    eli.send({ type: "ping", pad: "x".repeat(200_000) });
    await eventually(() => eli.of("pong")[0], "the answer to a long line");
    assert.equal(eli.closed, false);
    // Megabytes with no newline.
    for (let i = 0; i < 4; i++) eli.transport.send("x".repeat(1024 * 1024));
    await eventually(() => eli.closed, "the connection closed");
    assert.ok(eli.pair.serverStream.destroyed);
  });
});
