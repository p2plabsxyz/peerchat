// Ids first: a newer build hears only the id of each new message from most of
// its connections, and asks one of them for the message itself, over real
// connections. An older build is passed whole messages as before.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { createCipheriv, randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import crypto from "hypercore-crypto";

import { handleChatRequest, initChat, deriveTopic, deriveMessageKey } from "../p2p.js";
import { attachChatTransport } from "../transport.js";
import { signMessage } from "../lib/message-signature.js";
import { securePair, topicsFrame, wireRoom } from "./helpers.mjs";

const ROOM = "c1".repeat(32);
const DESK = crypto.keyPair(Buffer.alloc(32, 71));
const pair = (n) => crypto.keyPair(Buffer.alloc(32, n));
const WRITER = pair(72);
const ALICE = pair(73);
const BOB = pair(74);
const OLDER = pair(75);
const FAR = pair(76);
const idOf = (keyPair) => keyPair.publicKey.toString("hex").slice(0, 8);
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
  publicKey: DESK.publicKey,
  corestore: {
    get: ({ name }) => feeds.get(name) || feeds.set(name, fakeFeed()).get(name),
    createKeyPair: async (name) => (name === "noise" ? DESK : crypto.keyPair()),
  },
  join() {},
  swarm,
};

const call = async (action, method, body, roomKey) => {
  const qs = `hyper://chat?action=${action}${roomKey ? `&roomKey=${roomKey}` : ""}`;
  const res = await handleChatRequest({ url: qs, method, json: async () => body ?? {} }, sdk);
  return JSON.parse(await res.text());
};
const shown = async () => ((await call("get-history", "GET", null, ROOM)).messages || [])
  .filter((message) => message.type !== "system").map((message) => message.message);

function written(keyPair, text, id = newId()) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", deriveMessageKey(ROOM), iv);
  const ct = cipher.update(text, "utf8", "hex") + cipher.final("hex");
  const sealed = { ct, iv: iv.toString("hex"), tag: cipher.getAuthTag().toString("hex") };
  const ts = Date.now();
  return { id, sender: idOf(keyPair), sn: "Writer", ...sealed, ts, ...signMessage({ topic: wireRoom(ROOM), id, ts, sn: "Writer" }, sealed, keyPair) };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function eventually(check, label, tries = 100) {
  for (let i = 0; i < tries; i++) {
    const value = await check();
    if (value) return value;
    await sleep(50);
  }
  throw new Error(`timed out waiting for ${label}`);
}

const open = [];
async function connect(keyPair, { haves = true } = {}) {
  const pair = await securePair({ clientKeyPair: keyPair });
  const peer = { pair, frames: [] };
  open.push(peer);
  swarm.emit("connection", pair.serverStream, { topics: [deriveTopic(ROOM)] });
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
  const topics = JSON.parse(topicsFrame(pair.clientStream, [ROOM]));
  peer.send({ ...topics, pass: true, ...(haves && { have: true }) });
  await eventually(() => peer.frames.find((frame) => frame.type === "sync-done"), "the room opening");
  peer.ids = (type) => peer.frames.filter((frame) => frame.type === type).flatMap((frame) => frame.ids || []);
  peer.passed = (id) => peer.frames.filter((frame) => frame.type === "pass" && frame.m?.id === id);
  return peer;
}

describe("ids first", () => {
  let dir, writer, alice, bob, older;

  before(async () => {
    dir = mkdtempSync(path.join(tmpdir(), "peerchat-ids-first-"));
    const joinedAt = Date.now() - 60_000;
    writeFileSync(path.join(dir, "chat.json"), JSON.stringify({
      v: 1, profile: { username: "Desk" }, peerProfiles: {}, pendingDMs: {},
      rooms: {
        [ROOM]: {
          roomKey: ROOM, name: "Room", isHost: false, bio: "", link: "", avatar: null,
          createdAt: joinedAt, joinedAt, createdBy: "", createdByName: "",
          isPinned: false, isMuted: false, unreadCount: 0, unreadMentions: 0,
          lastMessage: null, members: {}, bans: [],
        },
      },
    }));
    initChat(sdk, { storagePath: path.join(dir, "chat.json") });
    await call("join", "POST", {}, ROOM);
    writer = await connect(WRITER);
    alice = await connect(ALICE);
    bob = await connect(BOB);
    older = await connect(OLDER, { haves: false });
  });

  after(async () => {
    for (const peer of open) {
      try { peer.transport?.close(); } catch {}
      await peer.pair.close().catch(() => {});
    }
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("tells a newer build only the id, and passes an older one the whole message", async () => {
    const message = written(WRITER, "Hello room");
    writer.send({ ...message, room: wireRoom(ROOM) });
    await eventually(() => alice.ids("have").includes(message.id) && bob.ids("have").includes(message.id), "the ids");
    await eventually(() => older.passed(message.id).length, "the whole message for the older build");
    assert.equal(alice.passed(message.id).length, 0);
    assert.equal(bob.passed(message.id).length, 0);
    // Not back to whoever wrote it.
    assert.equal(writer.ids("have").includes(message.id), false);

    // Asked for it, a neighbour gets the whole message.
    alice.send({ type: "want", room: wireRoom(ROOM), ids: [message.id] });
    const passed = await eventually(() => alice.passed(message.id)[0], "the message asked for");
    assert.equal(passed.m.as, message.as);
  });

  it("asks a neighbour for a message it only heard the id of, and takes it once", async () => {
    const message = written(pair(80), "Heard about");
    alice.send({ type: "have", room: wireRoom(ROOM), ids: [message.id] });
    await eventually(() => alice.ids("want").includes(message.id), "the ask");
    alice.send({ type: "pass", room: wireRoom(ROOM), m: message });
    await eventually(async () => (await shown()).includes("Heard about"), "the message taken");
    // On to the others, by id, but not back to the one it came from.
    await eventually(() => bob.ids("have").includes(message.id), "the id passed on");
    assert.equal(alice.ids("have").includes(message.id), false);
    // A second copy changes nothing.
    alice.send({ type: "pass", room: wireRoom(ROOM), m: message });
    await sleep(150);
    assert.equal((await shown()).filter((text) => text === "Heard about").length, 1);
  });

  it("asks the next neighbour that has it when the first does not answer", async () => {
    const far = await connect(FAR);
    const message = written(pair(81), "Second try");
    bob.send({ type: "have", room: wireRoom(ROOM), ids: [message.id] });
    await eventually(() => bob.ids("want").includes(message.id), "the first ask");
    far.send({ type: "have", room: wireRoom(ROOM), ids: [message.id] });
    // Bob never answers. A few seconds on, Far is asked.
    await eventually(() => far.ids("want").includes(message.id), "the second ask", 120);
    far.send({ type: "pass", room: wireRoom(ROOM), m: message });
    await eventually(async () => (await shown()).includes("Second try"), "the message from the second");
  });
});
