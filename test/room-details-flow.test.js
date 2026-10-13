// A room's details, signed by the person who made the room, over real
// connections: the creator changes them and everyone in the room takes the
// change, from anyone; nobody else can change them.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import crypto from "hypercore-crypto";

import { handleChatRequest, initChat, deriveTopic } from "../p2p.js";
import { attachChatTransport } from "../transport.js";
import { makeCreatorRoomKey } from "../lib/room-move.js";
import { avatarHash, checkRoomDetails, signRoomDetails } from "../lib/room-details.js";
import { securePair, topicsFrame, wireRoom } from "./helpers.mjs";

const DEVICE = crypto.keyPair(Buffer.alloc(32, 71));
const DEVICE_KEY = DEVICE.publicKey.toString("hex");
const CREATOR = crypto.keyPair(Buffer.alloc(32, 72));
const CREATOR_KEY = CREATOR.publicKey.toString("hex");
const pair = (n) => crypto.keyPair(Buffer.alloc(32, n));
const MEMBER = pair(81);
const SECOND = pair(82);
const FORGER = pair(83);
const PICTURE = "data:image/png;base64,iVBORw0KGgo=";

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
  return { status: res.status, body: JSON.parse(await res.text()) };
};
const roomNamed = async (roomKey) => (await call("get-rooms", "GET")).body.rooms.find((room) => room.roomKey === roomKey);

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

// Rooms somebody else made, which this device is in, written up front.
const CLUB = makeCreatorRoomKey(CREATOR_KEY);
const LATER = makeCreatorRoomKey(CREATOR_KEY);
const OLDER = makeCreatorRoomKey(CREATOR_KEY);
const signedBy = (keyPair, roomKey, details) => signRoomDetails({
  topic: wireRoom(roomKey), name: "Club", bio: "", link: "", avatar: "",
  moderation: { abuseFilter: true, nsfwFilter: true, spamRateLimit: 10 }, keyPair, ...details,
});
let dir;

before(() => {
  dir = mkdtempSync(path.join(tmpdir(), "peerchat-room-details-"));
  const theirs = (roomKey, name, creatorKey = "") => ({
    roomKey, name, bio: "", link: "", avatar: null,
    createdAt: Date.now() - 120_000, joinedAt: Date.now() - 60_000,
    isHost: false, isPinned: false, isMuted: false, unreadCount: 0, unreadMentions: 0,
    lastMessage: null, members: {}, bans: [], creatorKey, createdBy: "", createdByName: "Cora",
  });
  writeFileSync(path.join(dir, "chat.json"), JSON.stringify({
    v: 1, profile: { username: "Ada" }, peerProfiles: {}, pendingDMs: {},
    rooms: {
      [CLUB.roomKey]: theirs(CLUB.roomKey, "Club", CREATOR_KEY),
      [LATER.roomKey]: theirs(LATER.roomKey, "Later"),
      [OLDER.roomKey]: theirs(OLDER.roomKey, "Older", CREATOR_KEY),
    },
  }));
  initChat(sdk, { storagePath: path.join(dir, "chat.json"), keyPair: DEVICE });
});

after(async () => {
  for (const peer of open) await peer.close();
  if (dir) rmSync(dir, { recursive: true, force: true });
});

describe("a room this device made", () => {
  let roomKey, member;

  before(async () => {
    roomKey = (await call("create-key", "POST", { name: "Book club", bio: "Monthly" })).body.roomKey;
    await call("join", "POST", {}, roomKey);
    member = await connect(MEMBER, [roomKey]);
    await opened(member, roomKey);
  });

  it("goes out with its details signed", async () => {
    const meta = await eventually(() => member.of("room-meta", roomKey).find((frame) => frame.details), "signed details");
    assert.equal(meta.details.name, "Book club");
    assert.equal(meta.details.bio, "Monthly");
    assert.ok(checkRoomDetails({ topic: wireRoom(roomKey), creatorKey: DEVICE_KEY, details: meta.details }));
  });

  it("can be changed, picture and settings too, and the change goes to everyone in it", async () => {
    const seen = member.of("room-meta", roomKey).length;
    const changed = await call("update-room", "POST", {
      name: "Reading club", avatar: PICTURE, moderation: { abuseFilter: true, nsfwFilter: true, spamRateLimit: 5 },
    }, roomKey);
    assert.deepEqual(changed, { status: 200, body: { ok: true } });
    const meta = await eventually(
      () => member.of("room-meta", roomKey).slice(seen).find((frame) => frame.details?.name === "Reading club"),
      "the change",
    );
    assert.ok(checkRoomDetails({ topic: wireRoom(roomKey), creatorKey: DEVICE_KEY, details: meta.details }));
    assert.equal(meta.avatar, PICTURE);
    assert.equal(meta.details.avatar, avatarHash(PICTURE));
    assert.equal(meta.details.moderation.spamRateLimit, 5);
    const listed = await roomNamed(roomKey);
    assert.equal(listed.name, "Reading club");
    assert.equal(listed.avatar, PICTURE);
  });
});

describe("a room somebody else made", () => {
  let member, second;

  before(async () => {
    member = await connect(MEMBER, [CLUB.roomKey, LATER.roomKey, OLDER.roomKey]);
    second = await connect(SECOND, [CLUB.roomKey]);
    await opened(member, CLUB.roomKey);
    await opened(second, CLUB.roomKey);
  });

  it("takes the creator's signed details from anyone in it, and passes them on", async () => {
    const details = signedBy(CREATOR, CLUB.roomKey, { v: 10, name: "Club renamed", avatar: PICTURE, moderation: { abuseFilter: true, nsfwFilter: false, spamRateLimit: 15 } });
    member.send({ type: "room-meta", room: wireRoom(CLUB.roomKey), name: "Club", avatar: PICTURE, details });
    const room = await eventually(async () => {
      const listed = await roomNamed(CLUB.roomKey);
      return listed?.name === "Club renamed" ? listed : null;
    }, "the signed details");
    assert.equal(room.avatar, PICTURE);
    assert.deepEqual(room.moderation, { abuseFilter: true, nsfwFilter: false, spamRateLimit: 15 });
    const passed = await eventually(() => second.of("room-meta", CLUB.roomKey).find((frame) => frame.details?.v === 10), "the details passed on");
    assert.deepEqual(passed.details, details);
    assert.equal(passed.avatar, PICTURE);
  });

  it("refuses details signed by anyone else, older ones, and anything unsigned once signed ones are here", async () => {
    member.send({ type: "room-meta", room: wireRoom(CLUB.roomKey), name: "Taken", details: signedBy(FORGER, CLUB.roomKey, { v: 50, name: "Taken" }) });
    member.send({ type: "room-meta", room: wireRoom(CLUB.roomKey), name: "Club", details: signedBy(CREATOR, CLUB.roomKey, { v: 5, name: "Club before" }) });
    member.send({ type: "room-meta", room: wireRoom(CLUB.roomKey), name: "Unsigned", bio: "Unsigned bio", moderation: { abuseFilter: false } });
    await sleep(400);
    const room = await roomNamed(CLUB.roomKey);
    assert.equal(room.name, "Club renamed");
    assert.equal(room.bio, "");
    assert.equal(room.moderation.abuseFilter, true);
  });

  it("keeps details that came before it knew who made the room, and takes them once it does", async () => {
    member.send({ type: "room-meta", room: wireRoom(LATER.roomKey), name: "Later", details: signedBy(CREATOR, LATER.roomKey, { v: 3, name: "Later, signed" }) });
    await sleep(300);
    assert.equal((await roomNamed(LATER.roomKey)).name, "Later");
    member.send({ type: "room-meta", room: wireRoom(LATER.roomKey), name: "Later", creatorKey: CREATOR_KEY, creatorProof: LATER.creatorProof });
    await eventually(async () => (await roomNamed(LATER.roomKey)).name === "Later, signed", "the waiting details");
  });

  it("takes unsigned settings only from the creator's own connection", async () => {
    member.send({ type: "room-meta", room: wireRoom(OLDER.roomKey), name: "Older", moderation: { abuseFilter: false, nsfwFilter: true, spamRateLimit: 10 } });
    await sleep(300);
    assert.equal((await roomNamed(OLDER.roomKey)).moderation.abuseFilter, true);
    const creator = await connect(CREATOR, [OLDER.roomKey]);
    await opened(creator, OLDER.roomKey);
    creator.send({ type: "room-meta", room: wireRoom(OLDER.roomKey), name: "Older", moderation: { abuseFilter: true, nsfwFilter: true, spamRateLimit: 15 } });
    await eventually(async () => (await roomNamed(OLDER.roomKey)).moderation.spamRateLimit === 15, "the creator's settings");
  });

  it("cannot be changed here by anyone but its creator", async () => {
    const refused = await call("update-room", "POST", { name: "Mine now" }, CLUB.roomKey);
    assert.equal(refused.status, 403);
    assert.equal((await roomNamed(CLUB.roomKey)).name, "Club renamed");
    // Pinning and muting stay anyone's own.
    assert.equal((await call("update-room", "POST", { isMuted: true }, CLUB.roomKey)).status, 200);
  });
});
