// A big room, over a real connection. Anybody can join a room, with no limit,
// so what has to stay bounded is what one device copies and sends on: who is in
// the room, how much history, and whose joins. All three used to grow with the
// room and go out again on every new connection.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";

import { handleChatRequest, initChat, deriveTopic } from "../p2p.js";
import { attachChatTransport } from "../transport.js";
import { securePair, topicsFrame, wireRoom } from "./helpers.mjs";

const ROOM = "c3".repeat(32);
const PEOPLE = 150;
const ENTRIES = 250;
const peerIdOf = (n) => n.toString(16).padStart(8, "0");

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
// A long log: chat from the start of the room, and somebody's join at the end.
const base = Date.now() - 3_600_000;
const log = Array.from({ length: ENTRIES }, (_, i) => ({
  id: `m${i + 1}`, sender: "a1a1a1a1", sn: "Ann", ct: "00", iv: "00", tag: "00", ts: base + i + 1,
}));
log.push({ id: "zed-join", type: "system", text: "Zed joined", ts: base + ENTRIES + 1 });
feeds.set("chat-" + ROOM, fakeFeed(log));
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
const roomOf = async () => (await call("get-rooms", "GET")).rooms.find((room) => room.roomKey === ROOM);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function eventually(check, label) {
  for (let i = 0; i < 100; i++) {
    const value = await check();
    if (value) return value;
    await sleep(50);
  }
  throw new Error(`timed out waiting for ${label}`);
}

describe("a big room", () => {
  let dir, pair, transport;
  const frames = [];
  const send = (frame) => transport.send(JSON.stringify(frame) + "\n");

  before(async () => {
    dir = mkdtempSync(path.join(tmpdir(), "peerchat-scale-"));
    const members = {};
    for (let n = 1; n <= PEOPLE; n++) members[peerIdOf(n)] = { username: `Person ${n}`, bio: "", avatar: null, joinedAt: base + n };
    writeFileSync(path.join(dir, "chat.json"), JSON.stringify({
      v: 1, profile: { username: "Ada" }, peerProfiles: {}, pendingDMs: {},
      rooms: {
        [ROOM]: {
          roomKey: ROOM, name: "Big room", isHost: true, bio: "", link: "", avatar: null,
          createdAt: base, joinedAt: base, createdBy: "09090909", createdByName: "Ada",
          isPinned: false, isMuted: false, unreadCount: 0, unreadMentions: 0, lastMessage: null,
          members, bans: [],
        },
      },
    }));
    initChat(sdk, { storagePath: path.join(dir, "chat.json") });
    await call("join", "POST", {}, ROOM);

    pair = await securePair();
    swarm.emit("connection", pair.serverStream, { topics: [deriveTopic(ROOM)] });
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
    transport.send(topicsFrame(pair.clientStream, [ROOM]));
    await eventually(() => frames.find((frame) => frame.type === "members-list"), "the member list");
  });

  after(async () => {
    try { transport?.close(); } catch {}
    await pair?.close();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("tells a new connection about the newest hundred people, not all of them", async () => {
    await sleep(200);
    const told = new Set();
    for (const frame of frames.filter((f) => f.type === "members-list")) {
      for (const id of Object.keys(frame.members || {})) told.add(id);
    }
    assert.equal(told.size, 100);
    assert.ok(told.has(peerIdOf(PEOPLE)), "the newest is in it");
    assert.ok(!told.has(peerIdOf(1)), "the oldest is left for others to mention");
  });

  it("takes a name and a bio from somebody else's list, not a picture or a join time", async () => {
    send({
      type: "members-list", room: wireRoom(ROOM),
      members: {
        eeee0001: { username: "Eve", bio: "hi", avatar: "data:image/png;base64,AAAA", joinedAt: 5 },
        "not an id": { username: "Mallory" },
      },
    });
    await eventually(async () => (await roomOf()).members.eeee0001, "Eve noted");
    const members = (await roomOf()).members;
    assert.deepEqual(members.eeee0001, { username: "Eve", bio: "hi" });
    assert.equal(members["not an id"], undefined);
  });

  it("sends the last of the room's log to a newcomer, without the joins it saw", async () => {
    // Joined, by their own word, before any of it: everything is theirs to have.
    const doneBefore = frames.filter((frame) => frame.type === "sync-done").length;
    send({ type: "join", room: wireRoom(ROOM), peerId: "b0b0b0b0", username: "Bob", id: `${wireRoom(ROOM)}-b0b0b0b0-join-1`, ts: 1 });
    await eventually(() => frames.filter((frame) => frame.type === "sync-done").length > doneBefore, "the history");
    const synced = frames.filter((frame) => frame.type === "sync").map((frame) => Number(frame.id.slice(1)));
    // At most the last two hundred entries of the log, which also holds the
    // joins this device saw: the newest message, none of the oldest, in order,
    // and none of the joins.
    assert.ok(synced.length <= 200 && synced.length >= 190, `${synced.length} sent`);
    assert.equal(synced.at(-1), ENTRIES);
    assert.ok(synced[0] > ENTRIES - 200, "nothing from the start of the room");
    assert.deepEqual(synced, synced.map((_, i) => synced[0] + i));
    assert.equal(frames.some((frame) => frame.type === "sync-system"), false);
  });

  it("does not take the joins and leaves in somebody else's history", async () => {
    send({ type: "sync-system", room: wireRoom(ROOM), id: "elsewhere-join", text: "Someone joined", ts: Date.now() });
    await sleep(300);
    const history = await call("get-history", "GET", null, ROOM);
    assert.equal((history.messages || []).some((message) => message.id === "elsewhere-join"), false);
  });
});
