// How far a line of moves goes on a device that follows it, over real
// connections. A creator, or somebody wrongly taken for one, could send a long
// line of moves on every connection, and a device joined a room, opened a feed
// and wrote a line for every move in it. Now only the room the line ends in is
// joined, and at most ten moves a line are taken in any hour. And a moved room
// goes on only to keys that proved the room on a connection to this device
// before the move, never to a key that only signed something passed on.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { randomBytes } from "node:crypto";
import crypto from "hypercore-crypto";

import { encryptMsg, handleChatRequest, initChat, deriveTopic } from "../p2p.js";
import { attachChatTransport } from "../transport.js";
import { makeCreatorRoomKey, signMove } from "../lib/room-move.js";
import { newKeyChain } from "../lib/key-chain.js";
import { signMessage, signReaction } from "../lib/message-signature.js";
import { securePair, topicsFrame, wireRoom } from "./helpers.mjs";

const pair = (n) => crypto.keyPair(Buffer.alloc(32, n));
const keyOf = (keyPair) => keyPair.publicKey.toString("hex");
const idOf = (keyPair) => keyOf(keyPair).slice(0, 8);
const DEVICE = pair(101);
const CREATOR = pair(102);
const ALICE = pair(103);
const REMOVED = pair(104);
// Keys that never connect before the move, only sign something passed on.
const SPARE = pair(105);
const SPARE_TOO = pair(106);
const HOUR = 60 * 60_000;

const joinedTopics = [];
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
  join(topic) { joinedTopics.push(topic.toString("hex")); },
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
  peer.send({ ...JSON.parse(topicsFrame(pair.clientStream, roomKeys)), pass: true, move: true });
  peer.of = (type, roomKey) => peer.frames.filter((frame) => frame.type === type && (!roomKey || frame.room === wireRoom(roomKey)));
  peer.close = async () => { try { peer.transport.close(); } catch {} await pair.close().catch(() => {}); };
  return peer;
}
const opened = (peer, roomKey) => eventually(() => peer.of("room-meta", roomKey)[0] || peer.of("sync-done")[0], "the room opening");

// A line of moves by one creator, from a room, each at the time given.
function lineOfMoves(fromKey, count, keyPair, at = () => Date.now()) {
  const moves = [];
  let from = fromKey;
  for (let i = 0; i < count; i++) {
    const next = makeCreatorRoomKey(keyOf(keyPair));
    moves.push(signMove({ fromTopic: wireRoom(from), topicOf: wireRoom, to: next.roomKey, proof: next.creatorProof, chain: newKeyChain(), at: at(i), keyPair }));
    from = next.roomKey;
  }
  return moves;
}

// Rooms the creator made, which this device is in and knows who made.
const LINE = makeCreatorRoomKey(keyOf(CREATOR));
const CAPPED = makeCreatorRoomKey(keyOf(CREATOR));
const OLDER = makeCreatorRoomKey(keyOf(CREATOR));
let dir;

before(() => {
  dir = mkdtempSync(path.join(tmpdir(), "peerchat-move-limits-"));
  const theirs = ({ roomKey, creatorProof }, name) => ({
    roomKey, name, bio: "", link: "", avatar: null,
    createdAt: Date.now() - 120_000, joinedAt: Date.now() - 60_000,
    isHost: false, isPinned: false, isMuted: false, unreadCount: 0, unreadMentions: 0,
    lastMessage: null, members: {}, bans: [],
    creatorKey: keyOf(CREATOR), creatorProof, createdBy: idOf(CREATOR), createdByName: "Cora",
  });
  writeFileSync(path.join(dir, "chat.json"), JSON.stringify({
    v: 1, profile: { username: "Ada" }, peerProfiles: {}, pendingDMs: {},
    rooms: {
      [LINE.roomKey]: theirs(LINE, "Line"),
      [CAPPED.roomKey]: theirs(CAPPED, "Capped"),
      [OLDER.roomKey]: theirs(OLDER, "Older"),
    },
  }));
  initChat(sdk, { storagePath: path.join(dir, "chat.json"), keyPair: DEVICE });
});

after(async () => {
  for (const peer of open) await peer.close();
  if (dir) rmSync(dir, { recursive: true, force: true });
});

describe("a line of moves taken at once", () => {
  it("joins only the room it ends in, and keeps the rest as records for history", async () => {
    const creator = await connect(CREATOR, [LINE.roomKey]);
    await opened(creator, LINE.roomKey);
    await call("send", "POST", { message: "Before the line" }, LINE.roomKey);
    const moves = lineOfMoves(LINE.roomKey, 5, CREATOR);
    const between = moves.slice(0, -1).map((move) => move.to);
    const end = moves.at(-1).to;
    creator.send({ type: "room-moved", room: wireRoom(LINE.roomKey), moves });
    await eventually(async () => (await rooms()).movedRooms[LINE.roomKey] === end, "the line followed");
    await eventually(() => joinedTopics.includes(wireRoom(end)), "the end joined");
    await sleep(200);
    for (const key of between) {
      assert.equal(joinedTopics.includes(wireRoom(key)), false, "a room on the way is not joined");
      assert.equal(feeds.has(`chat-${key}`), false, "nor is its feed opened");
    }
    const listed = await rooms();
    for (const key of [LINE.roomKey, ...between]) assert.equal(listed.movedRooms[key], end);
    // One line, in the room it ends in, and the history from before.
    const messages = await history(end);
    assert.equal(messages.filter((message) => message.type === "system" && /new key/.test(message.text)).length, 1);
    assert.ok(messages.some((message) => message.message === "Before the line" && message.roomKey === LINE.roomKey));
  });
});

describe("moves in an hour", () => {
  it("takes at most ten along a line, counting the ones taken already", async () => {
    const creator = await connect(CREATOR, [CAPPED.roomKey]);
    await opened(creator, CAPPED.roomKey);
    const moves = lineOfMoves(CAPPED.roomKey, 12, CREATOR);
    creator.send({ type: "room-moved", room: wireRoom(CAPPED.roomKey), moves: moves.slice(0, 6) });
    await eventually(async () => (await rooms()).movedRooms[CAPPED.roomKey] === moves[5].to, "the first six");
    // The whole line again, as it comes on the next connection: four more.
    creator.send({ type: "room-moved", room: wireRoom(CAPPED.roomKey), moves });
    await eventually(async () => (await rooms()).movedRooms[CAPPED.roomKey] === moves[9].to, "four more");
    await sleep(300);
    const listed = await rooms();
    assert.equal(listed.movedRooms[CAPPED.roomKey], moves[9].to);
    assert.equal(listed.rooms.some((room) => room.roomKey === moves[10].to || room.roomKey === moves[11].to), false);
    assert.equal(listed.movedRooms[moves[10].to], undefined);
  });

  it("does not count a move made over an hour ago", async () => {
    const creator = await connect(CREATOR, [OLDER.roomKey]);
    await opened(creator, OLDER.roomKey);
    const moves = lineOfMoves(OLDER.roomKey, 12, CREATOR, (i) => Date.now() - (i < 4 ? 3 * HOUR : 0));
    creator.send({ type: "room-moved", room: wireRoom(OLDER.roomKey), moves });
    await eventually(async () => (await rooms()).movedRooms[OLDER.roomKey] === moves[11].to, "all twelve");
  });

  it("never holds back the creator's own device", async () => {
    let roomKey = (await call("create-key", "POST", { name: "Busy" })).roomKey;
    await call("join", "POST", {}, roomKey);
    const moved = [];
    for (let i = 0; i < 11; i++) {
      const { movedTo } = await call("remove-room-member", "POST", { roomKey, peerId: (0xd0000000 + i).toString(16) });
      assert.match(movedTo, /^[0-9a-f]{64}$/);
      moved.push(movedTo);
      roomKey = movedTo;
    }
    assert.equal(new Set(moved).size, 11);
  });
});

describe("who a moved room is handed to", () => {
  let roomKey, alice, removed, moved;

  before(async () => {
    roomKey = (await call("create-key", "POST", { name: "Weekend" })).roomKey;
    await call("join", "POST", {}, roomKey);
    alice = await connect(ALICE, [roomKey]);
    removed = await connect(REMOVED, [roomKey]);
    for (const peer of [alice, removed]) await opened(peer, roomKey);
    const topic = wireRoom(roomKey);
    // About to be removed, they pass on a reaction and a message, each signed
    // with a spare key that never proved the room here.
    const reactionId = randomBytes(16).toString("hex");
    const ts = Date.now();
    const reaction = { type: "reaction", id: reactionId, ts, msgId: "nothing-here", emoji: "👍", sn: "Spare" };
    removed.send({ type: "pass", room: topic, m: { ...reaction, ...signReaction({ topic, ...reaction }, SPARE) } });
    const messageId = randomBytes(16).toString("hex");
    const sealed = encryptMsg("Hello from a spare key", roomKey);
    const message = { id: messageId, sender: idOf(SPARE_TOO), sn: "Spare", ts, ...sealed };
    removed.send({ type: "pass", room: topic, m: { ...message, ...signMessage({ topic, id: messageId, ts, e: sealed.e, sn: "Spare" }, sealed, SPARE_TOO) } });
    await eventually(async () => (await history(roomKey)).some((entry) => entry.message === "Hello from a spare key"), "the passed-on message taken");
    await sleep(50);
    moved = (await call("remove-room-member", "POST", { roomKey, peerId: idOf(REMOVED) })).movedTo;
    assert.match(moved, /^[0-9a-f]{64}$/);
  });

  it("goes to somebody who proved the room here before the move", async () => {
    const frame = await eventually(() => alice.of("room-moved", roomKey)[0], "the move for Alice");
    assert.equal(frame.moves[0].to, moved);
  });

  it("does not go to a key that only signed something passed on", async () => {
    const spare = await connect(SPARE, [roomKey]);
    const spareToo = await connect(SPARE_TOO, [roomKey]);
    await sleep(500);
    for (const peer of [spare, spareToo]) {
      assert.equal(peer.of("room-moved").length, 0);
      assert.equal(peer.of("room-meta", roomKey).length, 0);
    }
  });
});
