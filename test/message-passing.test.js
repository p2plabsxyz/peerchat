// Signed messages passed on from device to device, over real connections.
// Alice and Bob run builds that pass messages on, Carol an older one that does
// not, and Writer is somebody this desktop never connects to.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import crypto from "hypercore-crypto";

import { handleChatRequest, initChat, deriveTopic, deriveMessageKey } from "../p2p.js";
import { attachChatTransport } from "../transport.js";
import { messageKeyAt } from "../lib/key-chain.js";
import { decodeMessagePayload } from "../lib/link-preview.js";
import { readSignedMessage, readSignedReaction, signMessage, signReaction } from "../lib/message-signature.js";
import { securePair, topicsFrame, wireRoom } from "./helpers.mjs";

const OLD = "a1".repeat(32);
const DESK = crypto.keyPair(Buffer.alloc(32, 9));
const ALICE = crypto.keyPair(Buffer.alloc(32, 11));
const BOB = crypto.keyPair(Buffer.alloc(32, 12));
const CAROL = crypto.keyPair(Buffer.alloc(32, 13));
const WRITER = crypto.keyPair(Buffer.alloc(32, 14));
const SPAMMER = crypto.keyPair(Buffer.alloc(32, 15));
const hex = (pair) => Buffer.from(pair.publicKey).toString("hex");
const idOf = (pair) => hex(pair).slice(0, 8);
const newId = () => randomBytes(16).toString("hex");

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
  publicKey: Buffer.from(DESK.publicKey),
  corestore: {
    get: ({ name }) => feeds.get(name) || feeds.set(name, fakeFeed()).get(name),
    createKeyPair: async () => DESK,
  },
  join() {},
  swarm,
};

const call = async (action, method, body, roomKey) => {
  const qs = `hyper://chat?action=${action}${roomKey ? `&roomKey=${roomKey}` : ""}`;
  const res = await handleChatRequest({ url: qs, method, json: async () => body ?? {} }, sdk);
  return JSON.parse(await res.text());
};
const shown = async (roomKey) => ((await call("get-history", "GET", null, roomKey)).messages || [])
  .filter((message) => message.type !== "system" && message.type !== "reaction");
const notices = async (roomKey) => ((await call("get-history", "GET", null, roomKey)).messages || [])
  .filter((message) => message.type === "system").map((message) => message.text);

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

// A message as its author writes and signs it.
function written(pair, roomKey, text, { id = newId(), ts = Date.now(), sn = "Writer" } = {}) {
  const sealed = seal(text, deriveMessageKey(roomKey));
  return { id, sender: idOf(pair), sn, ...sealed, ts, ...signMessage({ topic: wireRoom(roomKey), id, ts, sn }, sealed, pair) };
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

async function connectClient(keyPair, rooms, { passes }) {
  const pair = await securePair({ clientKeyPair: keyPair });
  const frames = [];
  swarm.emit("connection", pair.serverStream, { topics: rooms.map(deriveTopic) });
  let buffer = "";
  let transport;
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
  const topics = JSON.parse(topicsFrame(pair.clientStream, rooms));
  if (passes) topics.pass = true;
  transport.send(JSON.stringify(topics) + "\n");
  await eventually(() => frames.filter((frame) => frame.type === "room-meta").length >= rooms.length, "the rooms opening");
  return {
    pair,
    frames,
    send: (frame) => transport.send(JSON.stringify(frame) + "\n"),
    passed: (id) => frames.filter((frame) => frame.type === "pass" && (!id || frame.m?.id === id)),
    close: async () => { try { transport.close(); } catch {} await pair.close(); },
  };
}

describe("signed messages passed on", () => {
  let dir, newRoom, alice, bob, carol;

  before(async () => {
    dir = mkdtempSync(path.join(tmpdir(), "peerchat-passing-"));
    const joinedAt = Date.now() - 5 * 60_000;
    writeFileSync(path.join(dir, "chat.json"), JSON.stringify({
      v: 1, profile: { username: "Desk" }, peerProfiles: {}, pendingDMs: {},
      rooms: {
        [OLD]: {
          roomKey: OLD, name: "Old room", isHost: false, bio: "", link: "", avatar: null,
          createdAt: joinedAt, joinedAt, createdBy: "", createdByName: "",
          isPinned: false, isMuted: false, unreadCount: 0, unreadMentions: 0,
          lastMessage: null, members: {}, bans: [],
        },
      },
    }));
    initChat(sdk, { storagePath: path.join(dir, "chat.json") });
    newRoom = (await call("create-key", "POST", { name: "New room" })).roomKey;
    for (const roomKey of [OLD, newRoom]) await call("join", "POST", {}, roomKey);
    await sleep(50);

    alice = await connectClient(ALICE, [OLD, newRoom], { passes: true });
    bob = await connectClient(BOB, [OLD, newRoom], { passes: true });
    carol = await connectClient(CAROL, [OLD], { passes: false });
  });

  after(async () => {
    for (const client of [alice, bob, carol]) await client?.close();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("says in its handshake that it passes messages on", () => {
    assert.equal(alice.frames.find((frame) => frame.type === "topics")?.pass, true);
  });

  it("signs what it writes, and an old room keeps the reply and file details next to the body", async () => {
    const replyTo = { id: "earlier", sender: idOf(ALICE), sn: "Alice", text: "see you there" };
    await call("send", "POST", { message: "on my way", replyTo }, OLD);
    await call("send", "POST", { message: `hyper://${"a".repeat(52)}/1-00.bin`, fileName: "map.png", fileSize: 12, fileEnc: true }, OLD);
    const sent = await eventually(() => {
      const frames = alice.frames.filter((frame) => frame.room === wireRoom(OLD) && frame.ct);
      return frames.length >= 2 && frames;
    }, "the messages");
    const [reply, file] = sent;
    assert.equal(readSignedMessage(reply, wireRoom(OLD)).authorId, idOf(DESK));
    assert.deepEqual(readSignedMessage(reply, wireRoom(OLD)).header.replyTo, replyTo);
    // An older build reads these from next to the body, as before.
    assert.deepEqual(reply.replyTo, replyTo);
    assert.equal(file.fileName, "map.png");
    assert.equal(open(reply, deriveMessageKey(OLD)), "on my way");
  });

  it("keeps the reply and file details inside the sealed body in a room whose keys rotate", async () => {
    const replyTo = { id: "earlier", sender: idOf(ALICE), sn: "Alice", text: "the secret plan" };
    await call("send", "POST", { message: "agreed", replyTo }, newRoom);
    const frame = await eventually(() => alice.frames.find((f) => f.room === wireRoom(newRoom) && f.ct), "the message");
    assert.equal(frame.replyTo, undefined);
    assert.ok(readSignedMessage(frame, wireRoom(newRoom)));
    assert.ok(!frame.h.includes("secret plan"));
    const gift = alice.frames.find((f) => f.type === "room-chain" && f.room === wireRoom(newRoom));
    const payload = decodeMessagePayload(open(frame, messageKeyAt({ first: gift.e, secret: gift.secret }, frame.e)));
    assert.deepEqual(payload.replyTo, replyTo);
    assert.deepEqual((await shown(newRoom)).find((message) => message.message === "agreed").replyTo, replyTo);
  });

  it("takes a signed message straight from its author and passes it on to those who take it", async () => {
    const message = written(ALICE, OLD, "hello from Alice", { sn: "Alice" });
    alice.send({ ...message, room: wireRoom(OLD) });
    await eventually(async () => (await shown(OLD)).some((m) => m.id === message.id), "the message");
    const taken = (await shown(OLD)).find((m) => m.id === message.id);
    assert.equal(taken.sender, idOf(ALICE));
    const onToBob = await eventually(() => bob.passed(message.id)[0], "passed to Bob");
    assert.equal(onToBob.m.as, message.as);
    await sleep(100);
    assert.equal(alice.passed(message.id).length, 0);
    assert.equal(carol.passed().length, 0);
  });

  it("takes a message passed on as its author's, and sends it on once", async () => {
    const message = written(WRITER, OLD, "passed along");
    bob.send({ type: "pass", room: wireRoom(OLD), m: message });
    await eventually(async () => (await shown(OLD)).some((m) => m.id === message.id), "the message");
    const taken = (await shown(OLD)).find((m) => m.id === message.id);
    assert.equal(taken.sender, idOf(WRITER));
    assert.equal(taken.senderName, "Writer");
    await eventually(() => alice.passed(message.id).length === 1, "passed to Alice");
    // A second copy goes nowhere.
    alice.send({ type: "pass", room: wireRoom(OLD), m: message });
    await sleep(150);
    assert.equal(alice.passed(message.id).length, 1);
    assert.equal(bob.passed(message.id).length, 0);
    assert.equal(carol.passed().length, 0);
  });

  it("counts somebody else's history only when its author signed it", async () => {
    const forged = { type: "sync", id: newId(), room: wireRoom(OLD), sender: idOf(WRITER), sn: "Writer", ...seal("I never said this", deriveMessageKey(OLD)), ts: Date.now() };
    const real = { ...written(WRITER, OLD, "I did say this"), type: "sync", room: wireRoom(OLD) };
    const changed = written(WRITER, OLD, "changed on the way");
    const own = { type: "sync", id: newId(), room: wireRoom(OLD), sender: idOf(ALICE), sn: "Alice", ...seal("Alice's own, from an older build", deriveMessageKey(OLD)), ts: Date.now() };
    alice.send(forged);
    alice.send(real);
    alice.send({ ...changed, type: "sync", room: wireRoom(OLD), h: changed.h.replace("Writer", "Someone") });
    alice.send(own);
    await eventually(async () => (await shown(OLD)).some((m) => m.id === own.id), "the history");
    await sleep(150);
    const ids = (await shown(OLD)).map((m) => m.id);
    assert.ok(ids.includes(real.id) && ids.includes(own.id));
    assert.ok(!ids.includes(forged.id) && !ids.includes(changed.id));
  });

  it("takes a live message only when its own connection signed it", async () => {
    const borrowed = written(WRITER, OLD, "not Alice's to send");
    alice.send({ ...borrowed, room: wireRoom(OLD) });
    await sleep(200);
    assert.equal((await shown(OLD)).some((m) => m.id === borrowed.id), false);
  });

  it("takes nothing unsigned, stale or from before it joined passed on", async () => {
    const unsigned = { id: newId(), sender: idOf(WRITER), sn: "Writer", ...seal("unsigned", deriveMessageKey(OLD)), ts: Date.now() };
    const stale = written(WRITER, OLD, "stale", { ts: Date.now() - 11 * 60_000 });
    const early = written(WRITER, OLD, "before it joined", { ts: Date.now() - 8 * 60_000 });
    for (const m of [unsigned, stale, early]) bob.send({ type: "pass", room: wireRoom(OLD), m });
    const fine = written(WRITER, OLD, "this one counts");
    bob.send({ type: "pass", room: wireRoom(OLD), m: fine });
    await eventually(async () => (await shown(OLD)).some((m) => m.id === fine.id), "the good one");
    const ids = (await shown(OLD)).map((m) => m.id);
    assert.ok(![unsigned, stale, early].some((m) => ids.includes(m.id)));
  });

  it("holds each author to their own limit and never blames whoever passed it on", async () => {
    for (let index = 0; index < 12; index += 1) {
      bob.send({ type: "pass", room: wireRoom(OLD), m: written(SPAMMER, OLD, `burst ${index}`, { sn: "Spammer", ts: Date.now() + index }) });
    }
    const bobLive = written(BOB, OLD, "Bob still talking", { sn: "Bob" });
    await sleep(200);
    bob.send({ ...bobLive, room: wireRoom(OLD) });
    await eventually(async () => (await shown(OLD)).some((m) => m.id === bobLive.id), "Bob's message");
    const said = await notices(OLD);
    assert.ok(said.some((text) => text.includes("Spammer")));
    assert.ok(!said.some((text) => text.includes("Bob")));
  });

  it("signs reactions and passes them on like messages", async () => {
    const [target] = await shown(OLD);
    await call("react", "POST", { msgId: target.id, emoji: "\u{1F44D}" }, OLD);
    const own = await eventually(() => alice.frames.find((f) => f.type === "reaction"), "the reaction");
    assert.equal(readSignedReaction(own, wireRoom(OLD)).authorId, idOf(DESK));

    const id = newId();
    const ts = Date.now();
    const theirs = {
      type: "reaction", id, msgId: target.id, emoji: "\u{1F525}", sender: idOf(WRITER), sn: "Writer", ts,
      ...signReaction({ topic: wireRoom(OLD), id, ts, msgId: target.id, emoji: "\u{1F525}", sn: "Writer" }, WRITER),
    };
    bob.send({ type: "pass", room: wireRoom(OLD), m: theirs });
    await eventually(() => alice.passed(id).length === 1, "the reaction passed on");
  });
});
