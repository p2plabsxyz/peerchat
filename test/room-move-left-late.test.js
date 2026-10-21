// A room that moved is left when its two weeks are up while PeerChat runs. Its
// timer gave up when it went off before the room had finished joining, or a
// moment before the clock said two weeks, and the room stayed joined until the
// next start. A busy CI machine hit the first: room-move-kept timed out.
import { describe, it, before, after } from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import crypto from "hypercore-crypto";

import { initChat } from "../p2p.js";
import { makeCreatorRoomKey, signMove } from "../lib/room-move.js";
import { newKeyChain } from "../lib/key-chain.js";
import { wireRoom } from "./helpers.mjs";

const pair = (n) => crypto.keyPair(Buffer.alloc(32, n));
const keyOf = (keyPair) => keyPair.publicKey.toString("hex");
const DEVICE = pair(121);
const CREATOR = pair(122);
const DAY = 24 * 60 * 60_000;

const leftTopics = [];
const swarm = new EventEmitter();
swarm.flush = async () => {};
const feeds = new Map();
function fakeFeed({ opensIn = 0 } = {}) {
  const feed = new EventEmitter();
  feed.entries = [];
  Object.defineProperty(feed, "length", { get: () => feed.entries.length });
  feed.ready = () => new Promise((resolve) => setTimeout(resolve, opensIn));
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
  leave: async (topic) => { leftTopics.push(topic.toString("hex")); },
  swarm,
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function eventually(check, label) {
  for (let i = 0; i < 100; i++) {
    if (await check()) return;
    await sleep(50);
  }
  throw new Error(`timed out waiting for ${label}`);
}

const made = () => makeCreatorRoomKey(keyOf(CREATOR));
const moveOf = (from, to, at) => signMove({
  fromTopic: wireRoom(from.roomKey), topicOf: wireRoom, to: to.roomKey, proof: to.creatorProof,
  chain: newKeyChain(at), at, keyPair: CREATOR,
});
// Its feed takes longer to open than its two weeks have left.
const SLOW = made();
const SLOW_NEXT = made();
// Its timer goes off before the wall clock says two weeks.
const EARLY = made();
const EARLY_NEXT = made();
let dir;
const realNow = Date.now;

before(async () => {
  dir = mkdtempSync(path.join(tmpdir(), "peerchat-move-left-late-"));
  const now = Date.now();
  const room = ({ roomKey, creatorProof }, fields = {}) => ({
    roomKey, name: "Club", bio: "", link: "", avatar: null,
    createdAt: now - 30 * DAY, joinedAt: now - 30 * DAY,
    isHost: false, isPinned: false, isMuted: false, unreadCount: 0, unreadMentions: 0,
    lastMessage: null, members: {}, bans: [],
    creatorKey: keyOf(CREATOR), creatorProof, createdBy: keyOf(CREATOR).slice(0, 8), createdByName: "Cora",
    ...fields,
  });
  const moved = (from, to, at) => ({
    [from.roomKey]: room(from, { movedTo: moveOf(from, to, at) }),
    [to.roomKey]: room(to, { movedFrom: from.roomKey }),
  });
  writeFileSync(path.join(dir, "chat.json"), JSON.stringify({
    v: 1, profile: { username: "Ada" }, peerProfiles: {}, pendingDMs: {},
    rooms: {
      ...moved(SLOW, SLOW_NEXT, now - 14 * DAY + 300),
      ...moved(EARLY, EARLY_NEXT, now - 14 * DAY + 300),
    },
  }));
  feeds.set(`chat-${SLOW.roomKey}`, fakeFeed({ opensIn: 1000 }));
  // The wall clock runs 3% slow next to the clock timers keep, as it can when
  // it is being corrected or was set back.
  const from = realNow();
  Date.now = () => { const t = realNow(); return t - Math.floor((t - from) * 0.03); };
  initChat(sdk, { storagePath: path.join(dir, "chat.json"), keyPair: DEVICE });
});

after(() => {
  Date.now = realNow;
  if (dir) rmSync(dir, { recursive: true, force: true });
});

describe("a room that moved, when its two weeks run out while PeerChat runs", () => {
  it("is left once it has joined, when they ran out while it was joining", async () => {
    await eventually(() => leftTopics.includes(wireRoom(SLOW.roomKey)), "the slow room left");
  });

  it("is left when its timer goes off before the clock says two weeks", async () => {
    await eventually(() => leftTopics.includes(wireRoom(EARLY.roomKey)), "the room left");
  });
});
