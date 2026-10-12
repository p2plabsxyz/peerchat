// A room that moves to a new key when its creator removes somebody, over real
// connections: everyone still in it follows, the person removed does not, and
// neither does anyone who turns up with the old key afterwards.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import crypto from "hypercore-crypto";

import { handleChatRequest, initChat, deriveTopic } from "../p2p.js";
import { attachChatTransport } from "../transport.js";
import { checkMove, makeCreatorRoomKey, signMove } from "../lib/room-move.js";
import { newKeyChain } from "../lib/key-chain.js";
import { securePair, topicsFrame, wireRoom } from "./helpers.mjs";

const DEVICE = crypto.keyPair(Buffer.alloc(32, 51));
const DEVICE_KEY = DEVICE.publicKey.toString("hex");
const CREATOR = crypto.keyPair(Buffer.alloc(32, 52));
const CREATOR_KEY = CREATOR.publicKey.toString("hex");
const STRANGER = crypto.keyPair(Buffer.alloc(32, 53));
const pair = (n) => crypto.keyPair(Buffer.alloc(32, n));
const ALICE = pair(61);
const BOB = pair(62);
const REMOVED = pair(63);
const SAM = pair(64);
const OLDER = pair(65);
const NEWCOMER = pair(66);
const UNKNOWN = pair(67);
const idOf = (keyPair) => keyPair.publicKey.toString("hex").slice(0, 8);

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
const history = async (roomKey) => (await call("get-history", "GET", null, roomKey)).messages || [];

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
async function connect(keyPair, roomKeys, { moves = true } = {}) {
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
  peer.prove = (keys) => {
    const frame = JSON.parse(topicsFrame(pair.clientStream, keys));
    peer.send({ ...frame, pass: true, ...(moves && { move: true }) });
  };
  peer.of = (type, roomKey) => peer.frames.filter((frame) => frame.type === type && (!roomKey || frame.room === wireRoom(roomKey)));
  peer.close = async () => { try { peer.transport.close(); } catch {} await pair.close().catch(() => {}); };
  peer.prove(roomKeys);
  return peer;
}
const opened = (peer, roomKey) => eventually(() => peer.of("room-meta", roomKey)[0] || peer.of("sync-done")[0], "the room opening");

// Two rooms the creator made, which this device is in, written up front.
const CLUB = makeCreatorRoomKey(CREATOR_KEY);
const OTHER = makeCreatorRoomKey(CREATOR_KEY);
let dir;

before(() => {
  dir = mkdtempSync(path.join(tmpdir(), "peerchat-room-move-"));
  const theirs = (roomKey, name) => ({
    roomKey, name, bio: "", link: "", avatar: null,
    createdAt: Date.now() - 120_000, joinedAt: Date.now() - 60_000,
    isHost: false, isPinned: false, isMuted: false, unreadCount: 0, unreadMentions: 0,
    lastMessage: null, members: {}, bans: [], creatorKey: "", createdBy: "", createdByName: "Cora",
  });
  writeFileSync(path.join(dir, "chat.json"), JSON.stringify({
    v: 1, profile: { username: "Ada" }, peerProfiles: {}, pendingDMs: {},
    rooms: { [CLUB.roomKey]: theirs(CLUB.roomKey, "Club"), [OTHER.roomKey]: theirs(OTHER.roomKey, "Other") },
  }));
  initChat(sdk, { storagePath: path.join(dir, "chat.json"), keyPair: DEVICE });
});

after(async () => {
  for (const peer of open) await peer.close();
  if (dir) rmSync(dir, { recursive: true, force: true });
});

describe("a room that moves when its creator removes somebody", () => {
  let roomKey, moved, alice, bob, removed, older;

  before(async () => {
    roomKey = (await call("create-key", "POST", { name: "Weekend" })).roomKey;
    await call("join", "POST", {}, roomKey);
    alice = await connect(ALICE, [roomKey]);
    bob = await connect(BOB, [roomKey]);
    removed = await connect(REMOVED, [roomKey]);
    older = await connect(OLDER, [roomKey], { moves: false });
    const sam = await connect(SAM, [roomKey]);
    for (const peer of [alice, bob, removed, older, sam]) await opened(peer, roomKey);
    // Sam was here, and is offline when the room moves.
    await sam.close();
    await call("send", "POST", { message: "Before the move" }, roomKey);
  });

  it("moves to a new key made from the creator's, and tells everyone still in it", async () => {
    const response = await call("remove-room-member", "POST", { roomKey, peerId: idOf(REMOVED) });
    moved = response.movedTo;
    assert.match(moved, /^[0-9a-f]{64}$/);
    for (const peer of [alice, bob]) {
      const frame = await eventually(() => peer.of("room-moved", roomKey)[0], "the move");
      assert.equal(frame.moves.length, 1);
      assert.equal(frame.moves[0].to, moved);
      assert.ok(checkMove({ fromTopic: wireRoom(roomKey), creatorKey: DEVICE_KEY, move: frame.moves[0], topicOf: wireRoom }));
    }
    await sleep(200);
    // Not the person removed, and not a build that would not know what to do
    // with it.
    assert.equal(removed.of("room-moved").length, 0);
    assert.equal(older.of("room-moved").length, 0);
  });

  it("shows the new room in place of the old, with the old one's history", async () => {
    const listed = await rooms();
    assert.ok(listed.rooms.some((room) => room.roomKey === moved));
    assert.ok(!listed.rooms.some((room) => room.roomKey === roomKey));
    assert.equal(listed.movedRooms[roomKey], moved);
    const messages = await history(moved);
    const before = messages.find((message) => message.message === "Before the move");
    assert.ok(before);
    assert.equal(before.roomKey, roomKey);
    assert.ok(messages.some((message) => message.type === "system" && /new key/.test(message.text)));
    // The old key still names the room here, as the new one.
    assert.equal((await history(roomKey)).length, messages.length);
  });

  it("says nothing to somebody who turns up with the old key afterwards", async () => {
    const stranger = await connect(UNKNOWN, [roomKey]);
    await sleep(400);
    assert.equal(stranger.of("room-meta", roomKey).length, 0);
    assert.equal(stranger.of("room-moved").length, 0);
    assert.equal(stranger.of("sync", roomKey).length, 0);
  });

  it("tells somebody who was here before, back after the move, where it went", async () => {
    const sam = await connect(SAM, [roomKey]);
    const frame = await eventually(() => sam.of("room-moved", roomKey)[0], "the move for Sam");
    assert.equal(frame.moves[0].to, moved);
  });

  it("sends what is written now in the new room, to whoever is in it", async () => {
    alice.prove([moved]);
    await eventually(() => alice.of("room-meta", moved)[0], "the new room opening for Alice");
    // A page still on the old key writes in the new room.
    await call("send", "POST", { message: "After the move" }, roomKey);
    const sent = await eventually(() => alice.frames.find((frame) => frame.room === wireRoom(moved) && frame.ct && frame.as), "the message in the new room");
    assert.ok(sent.e);
    assert.equal(alice.frames.filter((frame) => frame.room === wireRoom(roomKey) && frame.ct && !frame.type && frame.ts > sent.ts - 1).length, 0);
  });

  it("is not moved again by the person removed, or anybody else", async () => {
    const { roomKey: theirs, creatorProof } = makeCreatorRoomKey(STRANGER.publicKey.toString("hex"));
    const forged = signMove({ fromTopic: wireRoom(moved), topicOf: wireRoom, to: theirs, proof: creatorProof, chain: newKeyChain(), at: Date.now(), keyPair: STRANGER });
    alice.send({ type: "room-moved", room: wireRoom(moved), moves: [forged] });
    await sleep(300);
    assert.ok((await rooms()).rooms.some((room) => room.roomKey === moved));
    assert.equal((await rooms()).movedRooms[moved], undefined);
  });

  it("leaves the old room with the new one", async () => {
    await call("delete-room", "POST", {}, moved);
    const listed = await rooms();
    assert.ok(!listed.rooms.some((room) => room.roomKey === moved || room.roomKey === roomKey));
    assert.deepEqual(listed.movedRooms, {});
  });
});

describe("a move taken from the creator, by somebody in the room", () => {
  const { roomKey, creatorProof: proof } = CLUB;
  let creator, alice, hop;

  before(async () => {
    creator = await connect(CREATOR, [roomKey]);
    alice = await connect(ALICE, [roomKey]);
    for (const peer of [creator, alice]) await opened(peer, roomKey);
    creator.send({ type: "room-meta", room: wireRoom(roomKey), name: "Club", creatorKey: CREATOR_KEY, creatorProof: proof });
    await eventually(async () => (await rooms()).rooms.find((room) => room.roomKey === roomKey)?.createdBy === CREATOR_KEY.slice(0, 8), "the creator known");
  });

  it("follows it, and passes it on only to people seen here before it was made", async () => {
    const next = makeCreatorRoomKey(CREATOR_KEY);
    hop = signMove({ fromTopic: wireRoom(roomKey), topicOf: wireRoom, to: next.roomKey, proof: next.creatorProof, chain: newKeyChain(), at: Date.now(), keyPair: CREATOR });
    await sleep(5);
    // In the room for the first time after the move was made: never told.
    const newcomer = await connect(NEWCOMER, [roomKey]);
    await opened(newcomer, roomKey);
    creator.send({ type: "room-moved", room: wireRoom(roomKey), moves: [hop] });
    await eventually(async () => (await rooms()).movedRooms[roomKey] === hop.to, "the move taken");
    const passed = await eventually(() => alice.of("room-moved", roomKey)[0], "the move passed on");
    assert.equal(passed.moves[0].to, hop.to);
    await sleep(200);
    assert.equal(newcomer.of("room-moved").length, 0);
    assert.equal(creator.of("room-moved").length, 0);
  });

  it("does not take a move signed by anyone else", async () => {
    const other = OTHER.roomKey;
    const relay = await connect(BOB, [other]);
    await opened(relay, other);
    const fake = makeCreatorRoomKey(STRANGER.publicKey.toString("hex"));
    const forged = signMove({ fromTopic: wireRoom(other), topicOf: wireRoom, to: fake.roomKey, proof: fake.creatorProof, chain: newKeyChain(), at: Date.now(), keyPair: STRANGER });
    relay.send({ type: "room-moved", room: wireRoom(other), moves: [forged] });
    await sleep(300);
    assert.equal((await rooms()).movedRooms[other], undefined);
  });
});
