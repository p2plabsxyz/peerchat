// Rooms whose keys rotate, over a real connection, next to a room made before
// rotation, which has to go on exactly as it was.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";

import { handleChatRequest, initChat, deriveTopic, deriveMessageKey } from "../p2p.js";
import { attachChatTransport } from "../transport.js";
import { chainSecretAt, hourOf, messageKeyAt, roomRotates } from "../lib/key-chain.js";
import { normalizeSharedRooms } from "../lib/device-link.js";
import { securePair, topicsFrame, wireRoom } from "./helpers.mjs";

// Made before rotation: its key carries no mark.
const OLD = "a1".repeat(32);
// Made elsewhere on a new build, joined here, with no chain here yet.
const THEIRS = "7d7d9b49efb7ed5d6b3594fec3ecc129a689cc3d226b479d7fa329062d7bbd92";
const now = Date.now();
const hour = hourOf(now);
// Their chain, from an hour before now, so there is something older to hide.
const THEIR_CHAIN = { first: hour - 1, secret: randomBytes(32).toString("hex") };

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
  publicKey: Buffer.alloc(32, 9),
  corestore: { get: ({ name }) => feeds.get(name) || feeds.set(name, fakeFeed()).get(name) },
  join() {},
  swarm,
};

const call = async (action, method, body, roomKey) => {
  const qs = `hyper://chat?action=${action}${roomKey ? `&roomKey=${roomKey}` : ""}`;
  const res = await handleChatRequest({ url: qs, method, json: async () => body ?? {} }, sdk);
  return JSON.parse(await res.text());
};
const roomOf = async (roomKey) => (await call("get-rooms", "GET")).rooms.find((room) => room.roomKey === roomKey);
const shown = async (roomKey) => ((await call("get-history", "GET", null, roomKey)).messages || [])
  .filter((message) => message.type !== "system");

function seal(text, key) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ct = cipher.update(text, "utf8", "hex") + cipher.final("hex");
  return { ct, iv: iv.toString("hex"), tag: cipher.getAuthTag().toString("hex") };
}
function open(frame, key) {
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(frame.iv, "hex"));
  decipher.setAuthTag(Buffer.from(frame.tag, "hex"));
  return decipher.update(frame.ct, "hex", "utf8") + decipher.final("utf8");
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function eventually(check, label) {
  for (let i = 0; i < 100; i++) {
    const value = await check();
    if (value) return value;
    await sleep(50);
  }
  throw new Error(`timed out waiting for ${label}`);
}

describe("rooms whose keys rotate", () => {
  let dir, pair, transport, mine;
  const frames = [];
  const send = (frame) => transport.send(JSON.stringify(frame) + "\n");
  const inRoom = (roomKey) => frames.filter((frame) => frame.room === wireRoom(roomKey));

  before(async () => {
    dir = mkdtempSync(path.join(tmpdir(), "peerchat-rotation-"));
    const room = (roomKey, name) => ({
      roomKey, name, isHost: false, bio: "", link: "", avatar: null,
      createdAt: now - 7_200_000, joinedAt: now - 7_200_000, createdBy: "", createdByName: "",
      isPinned: false, isMuted: false, unreadCount: 0, unreadMentions: 0,
      lastMessage: null, members: {}, bans: [],
    });
    writeFileSync(path.join(dir, "chat.json"), JSON.stringify({
      v: 1, profile: { username: "Ada" }, peerProfiles: {}, pendingDMs: {},
      rooms: { [OLD]: room(OLD, "Old room"), [THEIRS]: room(THEIRS, "Their room") },
    }));
    initChat(sdk, { storagePath: path.join(dir, "chat.json") });

    mine = (await call("create-key", "POST", { name: "New room" })).roomKey;
    for (const roomKey of [OLD, THEIRS, mine]) await call("join", "POST", {}, roomKey);

    pair = await securePair();
    swarm.emit("connection", pair.serverStream, { topics: [OLD, THEIRS, mine].map(deriveTopic) });
    let buffer = "";
    await new Promise((opened) => {
      transport = attachChatTransport(pair.clientStream, (raw) => {
        buffer += raw.toString();
        const lines = buffer.split("\n");
        buffer = lines.pop();
        for (const line of lines) {
          if (line) { try { frames.push(JSON.parse(line)); } catch {} }
        }
      }, { onopen: opened });
    });
    transport.send(topicsFrame(pair.clientStream, [OLD, THEIRS, mine]));
    await eventually(() => frames.filter((frame) => frame.type === "room-meta").length >= 3, "the rooms opening");
  });

  after(async () => {
    try { transport?.close(); } catch {}
    await pair?.close();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("makes a new room that rotates, and leaves the old one as it was", async () => {
    assert.equal(roomRotates(mine), true);
    assert.equal((await roomOf(mine)).rotates, true);
    assert.equal((await roomOf(OLD)).rotates, false);
    assert.equal((await roomOf(THEIRS)).rotates, false, "no chain here yet");
  });

  it("hands somebody joining the current hour's key, and nothing for rooms without one", async () => {
    const gifts = frames.filter((frame) => frame.type === "room-chain");
    assert.deepEqual(gifts.map((gift) => gift.room), [wireRoom(mine)]);
    assert.equal(gifts[0].e, hour);
    // Ahead of anything that needs it.
    const order = inRoom(mine).map((frame) => frame.type);
    assert.ok(order.indexOf("room-chain") > order.indexOf("room-meta"));
    assert.equal(order.indexOf("sync"), -1);
  });

  it("seals a new room's messages with the hour's key, not the room key", async () => {
    const gift = frames.find((frame) => frame.type === "room-chain");
    await call("send", "POST", { message: "sealed by the hour" }, mine);
    const sent = await eventually(() => inRoom(mine).find((frame) => frame.ct), "the message");
    assert.equal(sent.e, hour);
    assert.equal(open(sent, messageKeyAt({ first: gift.e, secret: gift.secret }, sent.e)), "sealed by the hour");
    assert.throws(() => open(sent, deriveMessageKey(mine)));
  });

  it("seals an old room's messages with its room key, as before", async () => {
    await call("send", "POST", { message: "as it always was" }, OLD);
    const sent = await eventually(() => inRoom(OLD).find((frame) => frame.ct), "the message");
    assert.equal(sent.e, undefined);
    assert.equal(open(sent, deriveMessageKey(OLD)), "as it always was");
    assert.deepEqual((await shown(OLD)).map((message) => message.message), ["as it always was"]);
  });

  it("never gives an old room a chain, whoever offers one", async () => {
    send({ type: "room-chain", room: wireRoom(OLD), e: hour, secret: "44".repeat(32) });
    await sleep(200);
    assert.equal((await roomOf(OLD)).rotates, false);
  });

  it("takes the current key for a room made elsewhere, and reads from that hour on only", async () => {
    send({ type: "room-chain", room: wireRoom(THEIRS), e: hour, secret: chainSecretAt(THEIR_CHAIN, hour) });
    await eventually(async () => (await roomOf(THEIRS)).rotates, "the chain taken");

    // A message from this hour, one from the hour before, and one from a build
    // without chains, sealed with the room key.
    const id = (n) => `theirs-${n}`;
    send({ id: id(1), room: wireRoom(THEIRS), sn: "Pat", ts: Date.now(), e: hour, ...seal("this hour", messageKeyAt(THEIR_CHAIN, hour)) });
    send({ type: "sync", id: id(2), room: wireRoom(THEIRS), sender: "a2a2a2a2", sn: "Pat", ts: Date.now(), e: hour - 1, ...seal("an hour ago", messageKeyAt(THEIR_CHAIN, hour - 1)) });
    send({ id: id(3), room: wireRoom(THEIRS), sn: "Pat", ts: Date.now(), ...seal("from an older build", deriveMessageKey(THEIRS)) });
    await eventually(async () => (await shown(THEIRS)).length >= 2, "the messages");
    await sleep(200);
    const texts = (await shown(THEIRS)).map((message) => message.message).sort();
    assert.deepEqual(texts, ["from an older build", "this hour"]);
  });

  it("carries a file's own key in a new room, and ignores one in an old room", async () => {
    const fileKey = "55".repeat(32);
    const file = { message: "hyper://drive/1.bin", fileName: "photo.png", fileSize: 10, fileEnc: true, fileKey };
    assert.equal((await call("send", "POST", file, mine)).sent.fileKey, fileKey);
    const inNew = (await shown(mine)).find((message) => message.fileName === "photo.png");
    assert.equal(inNew.fileKey, fileKey);

    assert.equal((await call("send", "POST", file, OLD)).sent.fileKey, undefined);
    const inOld = (await shown(OLD)).find((message) => message.fileName === "photo.png");
    assert.equal(inOld.fileKey, undefined);
  });

  it("passes a chain to the person's own devices, and nothing for a room without one", () => {
    const rooms = normalizeSharedRooms([
      { roomKey: mine, name: "New room", chain: THEIR_CHAIN },
      { roomKey: OLD, name: "Old room" },
    ]);
    assert.deepEqual(rooms[0].chain, THEIR_CHAIN);
    assert.equal(rooms[1].chain, undefined);
  });
});
