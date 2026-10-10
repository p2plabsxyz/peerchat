// Removals that reach people who never meet the room's creator, over real
// connections. The creator signs the list, anybody in the room passes it on,
// and each device checks the signature against the creator key it trusts.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import crypto from "hypercore-crypto";

import { handleChatRequest, initChat, deriveTopic } from "../p2p.js";
import { attachChatTransport } from "../transport.js";
import { checkSignedRemovals, signRemovals } from "../lib/removal-signature.js";
import { securePair, topicsFrame, wireRoom } from "./helpers.mjs";

// A room this device joined, made by somebody it is not connected to.
const THEIRS = "b1".repeat(32);
// A room made here.
const MINE = "b2".repeat(32);
const CREATOR = crypto.keyPair(Buffer.alloc(32, 4));
const CREATOR_KEY = CREATOR.publicKey.toString("hex");
// This device. Its store holds the pair behind the key it connects with.
const DEVICE = crypto.keyPair(Buffer.alloc(32, 5));
const DEVICE_KEY = DEVICE.publicKey.toString("hex");

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

const request = async (action, method, body, roomKey) => {
  const qs = `hyper://chat?action=${action}${roomKey ? `&roomKey=${roomKey}` : ""}`;
  const res = await handleChatRequest({ url: qs, method, json: async () => body ?? {} }, sdk);
  return { status: res.status, body: JSON.parse(await res.text()) };
};
const call = async (...args) => (await request(...args)).body;
const roomOf = async (roomKey) =>
  (await call("get-rooms", "GET")).rooms.find((room) => room.roomKey === roomKey);
const notices = async (roomKey) => ((await call("get-history", "GET", null, roomKey)).messages || [])
  .filter((message) => message.moderationNotice)
  .map((message) => message.text);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function eventually(check, label) {
  for (let i = 0; i < 100; i++) {
    const value = await check();
    if (value) return value;
    await sleep(50);
  }
  throw new Error(`timed out waiting for ${label}`);
}

// Somebody in both rooms, with what this device sends them.
const open = [];
async function connect() {
  const pair = await securePair();
  const peer = { pair, frames: [] };
  open.push(peer);
  swarm.emit("connection", pair.serverStream, { topics: [deriveTopic(THEIRS), deriveTopic(MINE)] });
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
  peer.lists = (roomKey) => peer.frames.filter((frame) => frame.type === "room-bans" && frame.room === wireRoom(roomKey));
  peer.transport.send(topicsFrame(pair.clientStream, [THEIRS, MINE]));
  await eventually(() => peer.frames.find((frame) => frame.type === "room-meta"), "the rooms opening");
  return peer;
}

const signedFor = (bans, v, keyPair = CREATOR) =>
  ({ v, sig: signRemovals({ topic: wireRoom(THEIRS), version: v, bans, keyPair }) });

describe("signed removal lists over real connections", () => {
  let dir, relay, watcher;

  before(async () => {
    dir = mkdtempSync(path.join(tmpdir(), "peerchat-signed-removals-"));
    const room = (roomKey, fields) => ({
      roomKey, name: "Room", bio: "", link: "", avatar: null,
      createdAt: Date.now() - 120_000, joinedAt: Date.now() - 60_000,
      isPinned: false, isMuted: false, unreadCount: 0, unreadMentions: 0,
      lastMessage: null, members: {}, bans: [], ...fields,
    });
    writeFileSync(path.join(dir, "chat.json"), JSON.stringify({
      v: 1, profile: { username: "Ada" }, peerProfiles: {}, pendingDMs: {},
      rooms: {
        [THEIRS]: room(THEIRS, { isHost: false, creatorKey: CREATOR_KEY, createdBy: CREATOR_KEY.slice(0, 8), createdByName: "Cora" }),
        [MINE]: room(MINE, { isHost: true, creatorKey: DEVICE_KEY, createdBy: DEVICE_KEY.slice(0, 8), createdByName: "Ada" }),
      },
    }));
    initChat(sdk, { storagePath: path.join(dir, "chat.json") });
    await call("join", "POST", {}, THEIRS);
    await call("join", "POST", {}, MINE);
    relay = await connect();
    watcher = await connect();
  });

  after(async () => {
    for (const peer of open) {
      try { peer.transport?.close(); } catch {}
      await peer.pair.close().catch(() => {});
    }
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("takes the creator's list from somebody who is not the creator, and passes it on", async () => {
    const list = [{ id: "c0ffee11", key: "", at: Date.now(), name: "Carol" }];
    relay.send({ type: "room-bans", room: wireRoom(THEIRS), bans: list, signed: signedFor(list, 1000) });

    await eventually(async () => (await roomOf(THEIRS)).bans.length === 1, "the removal taken");
    assert.deepEqual((await roomOf(THEIRS)).bans.map((ban) => ban.id), ["c0ffee11"]);
    assert.deepEqual(await notices(THEIRS), ["Carol was removed from the room by Cora"]);
    // On to everyone else here, signature and all, but not back to the relay.
    const passed = await eventually(() => watcher.lists(THEIRS).find((frame) => frame.signed?.v === 1000), "the list passed on");
    assert.equal(checkSignedRemovals({ topic: wireRoom(THEIRS), creatorKey: CREATOR_KEY, bans: passed.bans, signed: passed.signed }), true);
    assert.equal(relay.lists(THEIRS).some((frame) => frame.signed?.v === 1000), false);
  });

  it("ignores a list somebody changed, an older one, a forged one, and an unsigned one", async () => {
    const list = [{ id: "c0ffee11", key: "", at: Date.now(), name: "Carol" }];
    const later = signedFor(list, 2000);
    // Carol taken off with the creator's signature still on.
    relay.send({ type: "room-bans", room: wireRoom(THEIRS), bans: [], signed: later });
    // An old list from before Carol, signed, replayed.
    relay.send({ type: "room-bans", room: wireRoom(THEIRS), bans: [], signed: signedFor([], 999) });
    // Signed by somebody else.
    relay.send({ type: "room-bans", room: wireRoom(THEIRS), bans: [], signed: signedFor([], 3000, crypto.keyPair()) });
    // Unsigned, which only ever counted from the creator's own connection.
    relay.send({ type: "room-bans", room: wireRoom(THEIRS), bans: [] });
    await sleep(400);
    assert.deepEqual((await roomOf(THEIRS)).bans.map((ban) => ban.id), ["c0ffee11"]);
  });

  it("lets somebody back in when a newer list says so", async () => {
    relay.send({ type: "room-bans", room: wireRoom(THEIRS), bans: [], signed: signedFor([], 4000) });
    await eventually(async () => (await roomOf(THEIRS)).bans.length === 0, "the newer list taken");
  });

  it("signs the list of a room made here, so it can be passed on", async () => {
    const removed = await request("remove-room-member", "POST", { roomKey: MINE, peerId: "deadbeef" });
    assert.equal(removed.status, 200);
    const sent = await eventually(() => watcher.lists(MINE).find((frame) => frame.bans?.some((ban) => ban.id === "deadbeef")), "the new list");
    assert.equal(checkSignedRemovals({ topic: wireRoom(MINE), creatorKey: DEVICE_KEY, bans: sent.bans, signed: sent.signed }), true);

    // And again, later, when someone is let back in.
    await request("restore-room-member", "POST", { roomKey: MINE, peerId: "deadbeef" });
    const after = await eventually(() => watcher.lists(MINE).find((frame) => frame.signed?.v > sent.signed.v), "the list after");
    assert.deepEqual(after.bans, []);
    assert.equal(checkSignedRemovals({ topic: wireRoom(MINE), creatorKey: DEVICE_KEY, bans: after.bans, signed: after.signed }), true);
  });
});
