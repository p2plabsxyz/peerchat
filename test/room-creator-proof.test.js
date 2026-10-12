// Who made a room, learned from anyone in it. A room made on this version has a
// key made from its creator's key and a secret, so a member who never meets the
// creator can still check the creator key, and with it the removal lists.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import crypto from "hypercore-crypto";

import { handleChatRequest, initChat, deriveTopic } from "../p2p.js";
import { attachChatTransport } from "../transport.js";
import { signRemovals } from "../lib/removal-signature.js";
import { checkCreatorProof, makeCreatorRoomKey } from "../lib/room-move.js";
import { securePair, topicsFrame, wireRoom } from "./helpers.mjs";

const CREATOR = crypto.keyPair(Buffer.alloc(32, 41));
const CREATOR_KEY = CREATOR.publicKey.toString("hex");
const STRANGER = crypto.keyPair(Buffer.alloc(32, 42));
const STRANGER_KEY = STRANGER.publicKey.toString("hex");
const DEVICE = crypto.keyPair(Buffer.alloc(32, 43));
const DEVICE_KEY = DEVICE.publicKey.toString("hex");
// Two rooms the creator made, which this device joined without meeting them.
const FIRST = makeCreatorRoomKey(CREATOR_KEY);
const SECOND = makeCreatorRoomKey(CREATOR_KEY);
const ROOMS = [FIRST.roomKey, SECOND.roomKey];

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
  swarm,
};

const call = async (action, method, body, roomKey) => {
  const qs = `hyper://chat?action=${action}${roomKey ? `&roomKey=${roomKey}` : ""}`;
  const res = await handleChatRequest({ url: qs, method, json: async () => body ?? {} }, sdk);
  return JSON.parse(await res.text());
};
const roomOf = async (roomKey) =>
  (await call("get-rooms", "GET")).rooms.find((room) => room.roomKey === roomKey);

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
async function connect(roomKeys) {
  const pair = await securePair();
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
  peer.metas = (roomKey) => peer.frames.filter((frame) => frame.type === "room-meta" && frame.room === wireRoom(roomKey));
  peer.lists = (roomKey) => peer.frames.filter((frame) => frame.type === "room-bans" && frame.room === wireRoom(roomKey));
  peer.transport.send(topicsFrame(pair.clientStream, roomKeys));
  await eventually(() => peer.frames.find((frame) => frame.type === "sync-done"), "the rooms opening");
  return peer;
}

describe("a creator key learned from anyone in the room", () => {
  let dir, relay, watcher;

  before(async () => {
    dir = mkdtempSync(path.join(tmpdir(), "peerchat-creator-proof-"));
    const room = (roomKey) => ({
      roomKey, name: "Trip", bio: "", link: "", avatar: null,
      createdAt: Date.now() - 120_000, joinedAt: Date.now() - 60_000,
      isHost: false, isPinned: false, isMuted: false, unreadCount: 0, unreadMentions: 0,
      lastMessage: null, members: {}, bans: [], creatorKey: "", createdBy: "", createdByName: "Cora",
    });
    writeFileSync(path.join(dir, "chat.json"), JSON.stringify({
      v: 1, profile: { username: "Ada" }, peerProfiles: {}, pendingDMs: {},
      rooms: Object.fromEntries(ROOMS.map((roomKey) => [roomKey, room(roomKey)])),
    }));
    initChat(sdk, { storagePath: path.join(dir, "chat.json"), keyPair: DEVICE });
    for (const roomKey of ROOMS) await call("join", "POST", {}, roomKey);
    relay = await connect(ROOMS);
    watcher = await connect(ROOMS);
  });

  after(async () => {
    for (const peer of open) {
      try { peer.transport?.close(); } catch {}
      await peer.pair.close().catch(() => {});
    }
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("holds a signed removal list until it knows who made the room, then takes it and passes it on", async () => {
    const roomKey = FIRST.roomKey;
    const bans = [{ id: "c0ffee11", key: "", at: Date.now(), name: "Carol" }];
    const signed = { v: 2000, sig: signRemovals({ topic: wireRoom(roomKey), version: 2000, bans, keyPair: CREATOR }) };
    relay.send({ type: "room-bans", room: wireRoom(roomKey), bans, signed });
    await sleep(200);
    // Nothing to check it against yet, so nothing taken.
    assert.deepEqual((await roomOf(roomKey)).bans, []);

    // The creator key and the secret that made the room's key, from somebody
    // who is not the creator.
    relay.send({ type: "room-meta", room: wireRoom(roomKey), name: "Trip", creatorKey: CREATOR_KEY, creatorProof: FIRST.creatorProof });
    await eventually(async () => (await roomOf(roomKey)).bans.length === 1, "the held list taken");
    assert.equal((await roomOf(roomKey)).createdBy, CREATOR_KEY.slice(0, 8));

    // The list, and the creator key with its secret, go on to the rest.
    const passed = await eventually(() => watcher.lists(roomKey).find((frame) => frame.signed?.v === 2000), "the list passed on");
    assert.deepEqual(passed.bans.map((ban) => ban.id), ["c0ffee11"]);
    const meta = await eventually(() => watcher.metas(roomKey).find((frame) => frame.creatorProof), "the secret passed on");
    assert.equal(meta.creatorKey, CREATOR_KEY);
    assert.ok(checkCreatorProof(roomKey, meta.creatorKey, meta.creatorProof));
  });

  it("takes no creator key without the secret, or with one that does not make the room's key", async () => {
    const roomKey = SECOND.roomKey;
    relay.send({ type: "room-meta", room: wireRoom(roomKey), name: "Trip", creatorKey: STRANGER_KEY });
    relay.send({ type: "room-meta", room: wireRoom(roomKey), name: "Trip", creatorKey: STRANGER_KEY, creatorProof: FIRST.creatorProof });
    relay.send({ type: "room-meta", room: wireRoom(roomKey), name: "Trip", creatorKey: CREATOR_KEY, creatorProof: FIRST.creatorProof });
    await sleep(300);
    assert.equal((await roomOf(roomKey)).createdBy, "");
    // A list signed by somebody who only claimed the room is held, never taken.
    const bans = [{ id: "c0ffee22", key: "", at: Date.now(), name: "Dan" }];
    relay.send({ type: "room-bans", room: wireRoom(roomKey), bans, signed: { v: 3000, sig: signRemovals({ topic: wireRoom(roomKey), version: 3000, bans, keyPair: STRANGER }) } });
    relay.send({ type: "room-meta", room: wireRoom(roomKey), name: "Trip", creatorKey: CREATOR_KEY, creatorProof: SECOND.creatorProof });
    await eventually(async () => (await roomOf(roomKey)).createdBy === CREATOR_KEY.slice(0, 8), "the real creator key");
    await sleep(200);
    assert.deepEqual((await roomOf(roomKey)).bans, []);
  });

  it("makes a room whose key says who made it, and tells anyone in it", async () => {
    const { roomKey } = await call("create-key", "POST", { name: "Made here" });
    await call("join", "POST", {}, roomKey);
    const peer = await connect([roomKey]);
    const meta = await eventually(() => peer.metas(roomKey)[0], "the room's details");
    assert.equal(meta.creatorKey, DEVICE_KEY);
    assert.ok(checkCreatorProof(roomKey, DEVICE_KEY, meta.creatorProof));
  });
});
