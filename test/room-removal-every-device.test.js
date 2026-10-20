// Removing one of somebody's devices removes them all. Each device is a member
// of its own, so removing one left the person's other devices in the room.
// A device counts as theirs only by the person key its own profile proved
// (lib/person-proof.js), so nobody can take someone else out by claiming to
// be them.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";

import { handleChatRequest, initChat, deriveTopic } from "../p2p.js";
import { attachChatTransport } from "../transport.js";
import { makePersonProof, personKey } from "../lib/person-proof.js";
import { securePair, topicsFrame, wireRoom } from "./helpers.mjs";

const ROOM = "b1".repeat(32);
const BOB_LINK = { key: "b0".repeat(32) };

const swarm = new EventEmitter();
swarm.flush = async () => {};
function fakeFeed() {
  const feed = new EventEmitter();
  feed.entries = [];
  Object.defineProperty(feed, "length", { get: () => feed.entries.length });
  feed.ready = async () => {};
  feed.get = async (index) => feed.entries[index];
  feed.append = async (entry) => { feed.entries.push(entry); feed.emit("append"); };
  return feed;
}
const feeds = new Map();
const sdk = {
  publicKey: Buffer.alloc(32, 9),
  corestore: { get: ({ name }) => feeds.get(name) || feeds.set(name, fakeFeed()).get(name) },
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
  (await call("get-rooms", "GET")).rooms.find((room) => room.roomKey === roomKey || room.movedFrom === roomKey) ||
  (await call("get-rooms", "GET")).rooms.find((room) => room.name === "Trip");
const settle = () => new Promise((r) => setTimeout(r, 300));

// A device in the room: connected, proving the room, joined, with a profile.
async function device(name, person) {
  const pair = await securePair();
  const frames = [];
  swarm.emit("connection", pair.serverStream, { topics: [deriveTopic(ROOM)] });
  let buffer = "";
  let transport = null;
  await new Promise((resolve) => {
    transport = attachChatTransport(pair.clientStream, (raw) => {
      buffer += raw.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop();
      for (const line of lines) if (line) { try { frames.push(JSON.parse(line)); } catch {} }
    }, { onopen: resolve });
  });
  const key = pair.clientStream.publicKey.toString("hex");
  const id = key.slice(0, 8);
  transport.send(topicsFrame(pair.clientStream, [ROOM]));
  for (let i = 0; i < 100; i++) {
    if ((await call("net-status", "GET")).peers.some((peer) => peer.id === id)) break;
    await new Promise((r) => setTimeout(r, 50));
  }
  transport.send(JSON.stringify({ type: "join", room: wireRoom(ROOM), peerId: id, username: name, id: `${wireRoom(ROOM)}-${id}-join`, ts: Date.now() }) + "\n");
  transport.send(JSON.stringify({ type: "profile", peerId: id, username: name, bio: "", avatar: null, rooms: [ROOM], ...(person && { person: person(key) }) }) + "\n");
  await settle();
  return { pair, transport, frames, id, key, close: async () => { try { transport.close(); } catch {} await pair.close(); } };
}

describe("removing one of somebody's devices", () => {
  let dir;
  const devices = [];
  const bobs = (key) => makePersonProof(BOB_LINK, key);

  before(async () => {
    dir = mkdtempSync(path.join(tmpdir(), "peerchat-every-device-"));
    writeFileSync(path.join(dir, "chat.json"), JSON.stringify({
      v: 1, profile: { username: "Creator" }, peerProfiles: {}, pendingDMs: {},
      rooms: {
        [ROOM]: {
          roomKey: ROOM, name: "Trip", isHost: true, bio: "", link: "", avatar: null,
          createdAt: Date.now(), createdBy: "09090909", createdByName: "Creator", creatorKey: "09".repeat(32),
          isPinned: false, isMuted: false, unreadCount: 0, unreadMentions: 0,
          lastMessage: null, members: {}, bans: [],
        },
      },
    }));
    initChat(sdk, { storagePath: path.join(dir, "chat.json") });
    await call("join", "POST", {}, ROOM);
  });

  after(async () => {
    for (const d of devices) await d.close();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("removes every one of that person's devices, each by its full key", async () => {
    const desktop = await device("Bob", bobs);
    const phone = await device("Bob@mobile", bobs);
    const stranger = await device("Carol", null);
    devices.push(desktop, phone, stranger);
    const room = await roomOf(ROOM);
    for (const d of [desktop, phone, stranger]) assert.ok(room.members[d.id], `${d.id} has to be in it first`);

    const removed = await request("remove-room-member", "POST", { roomKey: ROOM, peerId: phone.id });
    assert.equal(removed.status, 200);
    assert.deepEqual([...removed.body.removed].sort(), [desktop.id, phone.id].sort());
    const bans = new Map(removed.body.bans.map((ban) => [ban.id, ban]));
    assert.equal(bans.get(desktop.id)?.key, desktop.key);
    assert.equal(bans.get(phone.id)?.key, phone.key);
    assert.equal(bans.has(stranger.id), false, "somebody else is left alone");

    const after = await roomOf(ROOM);
    assert.equal(after.members[desktop.id], undefined);
    assert.equal(after.members[phone.id], undefined);
    assert.ok(after.members[stranger.id], "still in the room");
    await settle();
    for (const d of [desktop, phone]) {
      assert.ok(d.frames.some((f) => f.type === "room-bans" && f.bans.some((ban) => ban.id === d.id)), `${d.id} was told`);
    }
  });

  it("removes another of their devices that turns up later, once it proves whose it is", async () => {
    const tablet = await device("Bob@desktop1", bobs);
    devices.push(tablet);
    const room = await roomOf(ROOM);
    assert.ok(room.bans.some((ban) => ban.id === tablet.id && ban.key === tablet.key), "the late device went too");
    assert.equal(room.members[tablet.id], undefined);
  });

  it("does not remove somebody who only copied their person key", async () => {
    // Bob's person key with a signature made for another device: worthless.
    const copied = makePersonProof(BOB_LINK, "0d".repeat(32));
    const mallory = await device("Mallory", () => ({ key: personKey(BOB_LINK), sig: copied.sig }));
    devices.push(mallory);
    const room = await roomOf(ROOM);
    assert.equal(room.bans.some((ban) => ban.id === mallory.id), false);
    assert.ok(room.members[mallory.id]);
  });

  it("lets them back in with every one of their devices", async () => {
    const room = await roomOf(ROOM);
    const bobIds = room.bans.map((ban) => ban.id);
    assert.ok(bobIds.length >= 3);
    const restored = await request("restore-room-member", "POST", { roomKey: room.roomKey, peerId: bobIds[0] });
    assert.equal(restored.status, 200);
    assert.deepEqual(restored.body.bans, []);
  });
});
