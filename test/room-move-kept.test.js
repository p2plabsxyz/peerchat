// A room that moved stays joined for two weeks after the move, for anyone who
// missed it to hear where it went, and is left after that, at start or while
// PeerChat runs, with its record and history kept. A room a line of moves
// only passed through is never joined, at start either.
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
import { securePair, topicsFrame, wireRoom } from "./helpers.mjs";

const pair = (n) => crypto.keyPair(Buffer.alloc(32, n));
const keyOf = (keyPair) => keyPair.publicKey.toString("hex");
const DEVICE = pair(111);
const CREATOR = pair(112);
const ALICE = pair(113);
const DAY = 24 * 60 * 60_000;

const joinedTopics = [];
const leftTopics = [];
const swarm = new EventEmitter();
swarm.flush = async () => {};
const feeds = new Map();
function fakeFeed(entries = []) {
  const feed = new EventEmitter();
  feed.entries = entries;
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
  leave: async (topic) => { leftTopics.push(topic.toString("hex")); },
  swarm,
};

const call = async (action, method, body, roomKey) => {
  const qs = `hyper://chat?action=${action}${roomKey ? `&roomKey=${roomKey}` : ""}`;
  const res = await handleChatRequest({ url: qs, method, json: async () => body ?? {} }, sdk);
  return JSON.parse(await res.text());
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function eventually(check, label) {
  for (let i = 0; i < 100; i++) {
    const value = await check();
    if (value) return value;
    await sleep(50);
  }
  throw new Error(`timed out waiting for ${label}`);
}

const made = () => makeCreatorRoomKey(keyOf(CREATOR));
const moveOf = (from, to, at) => signMove({
  fromTopic: wireRoom(from.roomKey), topicOf: wireRoom, to: to.roomKey, proof: to.creatorProof,
  chain: newKeyChain(at), at, keyPair: CREATOR,
});
// Moved over two weeks ago, under two weeks ago, and two weeks ago in a moment.
const OLD = made();
const OLD_NEXT = made();
const RECENT = made();
const RECENT_NEXT = made();
const EXPIRING = made();
const EXPIRING_NEXT = made();
// A line that passed through one room on the way.
const START = made();
const PASSED = made();
const END = made();
let dir, opened;

before(async () => {
  dir = mkdtempSync(path.join(tmpdir(), "peerchat-move-kept-"));
  const now = Date.now();
  const room = ({ roomKey, creatorProof }, fields = {}) => ({
    roomKey, name: "Club", bio: "", link: "", avatar: null,
    createdAt: now - 30 * DAY, joinedAt: now - 30 * DAY,
    isHost: false, isPinned: false, isMuted: false, unreadCount: 0, unreadMentions: 0,
    lastMessage: null, members: {}, bans: [],
    creatorKey: keyOf(CREATOR), creatorProof, createdBy: keyOf(CREATOR).slice(0, 8), createdByName: "Cora",
    ...fields,
  });
  const moved = (from, to, at, fields = {}) => ({
    [from.roomKey]: room(from, { movedTo: moveOf(from, to, at), ...fields }),
    [to.roomKey]: room(to, { movedFrom: from.roomKey }),
  });
  const startMove = moveOf(START, PASSED, now - DAY);
  const passedMove = moveOf(PASSED, END, now - DAY);
  writeFileSync(path.join(dir, "chat.json"), JSON.stringify({
    v: 1, profile: { username: "Ada" }, peerProfiles: {}, pendingDMs: {},
    rooms: {
      ...moved(OLD, OLD_NEXT, now - 15 * DAY),
      ...moved(RECENT, RECENT_NEXT, now - 13 * DAY),
      ...moved(EXPIRING, EXPIRING_NEXT, now - 14 * DAY + 800),
      [START.roomKey]: room(START, { movedTo: startMove }),
      [PASSED.roomKey]: room(PASSED, { movedFrom: START.roomKey, movedTo: passedMove, passedThrough: true }),
      [END.roomKey]: room(END, { movedFrom: PASSED.roomKey }),
    },
  }));
  // What was said in the old room before it moved.
  feeds.set(`chat-${OLD.roomKey}`, fakeFeed([{ id: "said-before", sender: "0a0a0a0a", sn: "Ben", message: "Said before the move", ts: now - 20 * DAY }]));
  opened = now;
  initChat(sdk, { storagePath: path.join(dir, "chat.json"), keyPair: DEVICE });
  await eventually(() => joinedTopics.includes(wireRoom(END.roomKey)), "the rooms joined at start");
});

after(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

describe("a room that moved, at start", () => {
  it("is joined within two weeks of the move", () => {
    for (const { roomKey } of [RECENT, EXPIRING, START]) assert.ok(joinedTopics.includes(wireRoom(roomKey)));
    for (const { roomKey } of [OLD_NEXT, RECENT_NEXT, EXPIRING_NEXT, END]) assert.ok(joinedTopics.includes(wireRoom(roomKey)));
  });

  it("is not joined after them, and its history still shows in the room it went to", async () => {
    assert.equal(joinedTopics.includes(wireRoom(OLD.roomKey)), false);
    const messages = (await call("get-history", "GET", null, OLD_NEXT.roomKey)).messages || [];
    const before = messages.find((message) => message.message === "Said before the move");
    assert.ok(before);
    assert.equal(before.roomKey, OLD.roomKey);
    assert.equal((await call("get-rooms", "GET")).movedRooms[OLD.roomKey], OLD_NEXT.roomKey);
  });

  it("is never joined when a line of moves only passed through it", () => {
    assert.equal(joinedTopics.includes(wireRoom(PASSED.roomKey)), false);
    assert.equal(feeds.has(`chat-${PASSED.roomKey}`), false);
  });
});

describe("a room that moved, while PeerChat runs", () => {
  it("is left when its two weeks are up, with its record kept", async () => {
    await eventually(() => leftTopics.includes(wireRoom(EXPIRING.roomKey)), "the room left");
    assert.ok(Date.now() - opened >= 700);
    assert.equal(leftTopics.includes(wireRoom(RECENT.roomKey)), false);
    assert.equal((await call("get-rooms", "GET")).movedRooms[EXPIRING.roomKey], EXPIRING_NEXT.roomKey);
    // Somebody who turns up with its key now hears nothing, and this device
    // no longer says it is in it. Found under no topic, as a connection this
    // side did not dial arrives.
    const peer = await securePair({ clientKeyPair: ALICE });
    const frames = [];
    swarm.emit("connection", peer.serverStream, { topics: [] });
    let transport;
    await new Promise((ready) => {
      transport = attachChatTransport(peer.clientStream, (raw) => {
        for (const line of raw.toString().split("\n")) if (line) { try { frames.push(JSON.parse(line)); } catch {} }
      }, { onopen: ready });
    });
    transport.send(JSON.stringify({ ...JSON.parse(topicsFrame(peer.clientStream, [EXPIRING.roomKey, RECENT_NEXT.roomKey])), pass: true, move: true }) + "\n");
    await eventually(() => frames.some((frame) => frame.room === wireRoom(RECENT_NEXT.roomKey)), "a room still joined opening");
    await sleep(200);
    assert.equal(frames.some((frame) => frame.room === wireRoom(EXPIRING.roomKey)), false);
    const proofs = frames.filter((frame) => frame.type === "topics").flatMap((frame) => frame.rooms.map((entry) => entry.topic));
    assert.ok(proofs.includes(wireRoom(RECENT.roomKey)));
    assert.equal(proofs.includes(wireRoom(EXPIRING.roomKey)), false);
    try { transport.close(); } catch {}
    await peer.close();
  });
});
