// Removing somebody, over a real connection, from the side that removed them.
// The source assertions next door say the wiring is there; these say what the
// creator's own screen is handed and what the removed peer is actually sent.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";

import { handleChatRequest, initChat, deriveTopic } from "../p2p.js";
import { attachChatTransport } from "../transport.js";
import { securePair, topicsFrame, wireRoom } from "./helpers.mjs";

const ROOM = "ad".repeat(32);
const OTHER_ROOM = "ae".repeat(32);
// A room the peer made and this device joined, for the other side of a removal.
const THEIR_ROOM = "af".repeat(32);

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
  (await call("get-rooms", "GET")).rooms.find((room) => room.roomKey === roomKey);

describe("removing somebody over a real connection", () => {
  let dir, pair, transport, peerId;
  const frames = [];

  const settle = () => new Promise((r) => setTimeout(r, 250));

  before(async () => {
    dir = mkdtempSync(path.join(tmpdir(), "peerchat-removal-"));
    const room = (roomKey, name) => ({
      roomKey, name, isHost: true, bio: "", link: "", avatar: null,
      createdAt: Date.now(), createdBy: "09090909", createdByName: "Creator",
      isPinned: false, isMuted: false, unreadCount: 0, unreadMentions: 0,
      lastMessage: null, members: {}, bans: [],
    });
    writeFileSync(path.join(dir, "chat.json"), JSON.stringify({
      v: 1, profile: { username: "Creator" }, peerProfiles: {}, pendingDMs: {},
      rooms: {
        [ROOM]: room(ROOM, "Room"),
        [OTHER_ROOM]: room(OTHER_ROOM, "Other room"),
        [THEIR_ROOM]: { ...room(THEIR_ROOM, "Theirs"), isHost: false, createdBy: "", createdByName: "" },
      },
    }));
    initChat(sdk, { storagePath: path.join(dir, "chat.json") });
    await call("join", "POST", {}, ROOM);
    await call("join", "POST", {}, OTHER_ROOM);
    await call("join", "POST", {}, THEIR_ROOM);

    pair = await securePair();
    swarm.emit("connection", pair.serverStream, {
      topics: [deriveTopic(ROOM), deriveTopic(OTHER_ROOM), deriveTopic(THEIR_ROOM)],
    });

    let buffer = "";
    const opened = new Promise((r) => {
      transport = attachChatTransport(pair.clientStream, (raw) => {
        buffer += raw.toString();
        const lines = buffer.split("\n");
        buffer = lines.pop();
        for (const line of lines) {
          if (line) { try { frames.push(JSON.parse(line)); } catch {} }
        }
      }, { onopen: r });
    });
    await opened;

    // Prove the rooms, and a join so the room knows them as a member.
    transport.send(topicsFrame(pair.clientStream, [ROOM, OTHER_ROOM, THEIR_ROOM]));
    for (let i = 0; i < 100 && !peerId; i++) {
      peerId = (await call("net-status", "GET")).peers[0]?.id;
      if (!peerId) await new Promise((r) => setTimeout(r, 50));
    }
    assert.ok(peerId, "peer never activated");
    for (const roomKey of [ROOM, OTHER_ROOM]) {
      transport.send(JSON.stringify({
        type: "join", room: wireRoom(roomKey), peerId, username: "Bob",
        id: `${wireRoom(roomKey)}-${peerId}-join`, ts: Date.now(),
      }) + "\n");
    }
    await settle();
  });

  after(async () => {
    try { transport?.close(); } catch {}
    await pair?.close();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("takes them out of the member list the creator is looking at", async () => {
    assert.ok((await roomOf(ROOM)).members[peerId], "they have to be in it first");

    const removed = await request("remove-room-member", "POST", { roomKey: ROOM, peerId });
    assert.equal(removed.status, 200);

    // What the member list filters on. Held only as a deleted entry it came
    // straight back with the next member list somebody relayed.
    const room = await roomOf(ROOM);
    assert.deepEqual(room.bans.map((ban) => ban.id), [peerId]);
    assert.equal(room.members[peerId], undefined);

    // And it stays gone when the room hears about them again.
    transport.send(JSON.stringify({
      type: "members-list", room: wireRoom(ROOM), members: { [peerId]: { username: "Bob", joinedAt: Date.now() } },
    }) + "\n");
    await settle();
    assert.equal((await roomOf(ROOM)).members[peerId], undefined);
  });

  it("tells them, by name, and leaves their other rooms alone", async () => {
    const bans = frames.filter((f) => f.type === "room-bans" && f.room === wireRoom(ROOM));
    assert.ok(bans.length, "the removal never reached them");
    assert.deepEqual(bans.at(-1).bans.map((ban) => ban.id), [peerId]);
    // With their name, for whoever in the room never met them.
    assert.equal(bans.at(-1).bans[0].name, "Bob");

    // The connection carries both rooms, so it stays up.
    assert.equal(pair.clientStream.destroyed, false);
    assert.ok((await roomOf(OTHER_ROOM)).members[peerId], "still in the room they were not removed from");

    const { messages } = await call("get-history", "GET", null, ROOM);
    const notice = messages.find((message) => message.moderationNotice);
    assert.match(notice.text, /^Bob was removed from the room by Creator$/);
  });

  it("stops reading anything they send to that room", async () => {
    const before = (await call("get-history", "GET", null, ROOM)).messages.length;
    transport.send(JSON.stringify({
      room: wireRoom(ROOM), id: "after-removal", sender: peerId,
      sn: "Bob", ts: Date.now(), ct: "00", iv: "00", tag: "00",
    }) + "\n");
    await settle();
    assert.equal((await call("get-history", "GET", null, ROOM)).messages.length, before);
  });

  it("lets them back in, and says so", async () => {
    await request("restore-room-member", "POST", { roomKey: ROOM, peerId });
    assert.deepEqual((await roomOf(ROOM)).bans, []);

    transport.send(JSON.stringify({
      type: "members-list", room: wireRoom(ROOM), members: { [peerId]: { username: "Bob", joinedAt: Date.now() } },
    }) + "\n");
    await settle();
    assert.ok((await roomOf(ROOM)).members[peerId], "back in the list");
  });

  // The other side of it. Leaving a room and rejoining gave a fresh record with
  // no removals in it, and the list that would have said otherwise arrived
  // before the creator key it has to be checked against, so it was dropped and
  // the room read as open again.
  it("stays shut to somebody who left and rejoined", async () => {
    const theirKey = pair.clientStream.publicKey.toString("hex").toLowerCase();
    const me = (await call("get-profile", "GET")).id;
    const bans = () => JSON.stringify({
      type: "room-bans", room: wireRoom(THEIR_ROOM),
      bans: [{ id: me, key: "09".repeat(32), at: Date.now() }],
    }) + "\n";
    const meta = () => JSON.stringify({
      type: "room-meta", room: wireRoom(THEIR_ROOM), name: "Theirs", bio: "", link: "",
      createdAt: Date.now(), createdBy: peerId, creatorKey: theirKey, createdByName: "Bob",
    }) + "\n";

    // With nothing on record about who made the room, a removal is a claim.
    transport.send(bans());
    await settle();
    assert.equal((await roomOf(THEIR_ROOM)).removedByCreator, false);

    // With the creator key on record it is a fact, and the composer is shut.
    transport.send(meta());
    await settle();
    transport.send(bans());
    await settle();
    assert.equal((await roomOf(THEIR_ROOM)).removedByCreator, true);

    // Leaving takes the record with it, and rejoining is met with the same two
    // frames in the same order, so the room is shut again.
    await call("delete-room", "POST", {}, THEIR_ROOM);
    assert.equal(await roomOf(THEIR_ROOM), undefined);
    // Rejoining waits for the room's name to arrive, so the metadata goes out
    // while it waits rather than after it.
    const rejoined = call("join", "POST", {}, THEIR_ROOM);
    await settle();
    transport.send(meta());
    await rejoined;
    transport.send(bans());
    await settle();
    assert.equal((await roomOf(THEIR_ROOM)).removedByCreator, true);
  });

  // Somebody removed while this device was in the room, who never connected to
  // it. It used to say "c0ffee11 was removed" with nothing else to go on.
  it("names somebody this device never met, as the creator knew them", async () => {
    const theirKey = pair.clientStream.publicKey.toString("hex").toLowerCase();
    transport.send(JSON.stringify({
      type: "room-meta", room: wireRoom(THEIR_ROOM), name: "Theirs", bio: "", link: "",
      createdAt: Date.now(), createdBy: peerId, creatorKey: theirKey, createdByName: "Bob",
    }) + "\n");
    await settle();
    transport.send(JSON.stringify({
      type: "room-bans", room: wireRoom(THEIR_ROOM),
      bans: [{ id: "c0ffee11", key: "", at: Date.now(), name: "Carol" }],
    }) + "\n");
    await settle();
    const { messages } = await call("get-history", "GET", null, THEIR_ROOM);
    const notice = messages.filter((message) => message.moderationNotice).at(-1);
    assert.match(notice.text, /^Carol was removed from the room by Bob$/);
  });

  // A device that joins a room is handed the creator's whole removal list.
  // Every entry in it became a notice, so a newcomer's first sight of P2P
  // Republic was the names of everyone ever removed from it.
  it("tells a newcomer nothing about removals from before it joined", async () => {
    const notices = async () => (await call("get-history", "GET", null, THEIR_ROOM)).messages
      .filter((message) => message.moderationNotice)
      .map((message) => message.text);
    const shown = await notices();
    transport.send(JSON.stringify({
      type: "room-bans", room: wireRoom(THEIR_ROOM),
      bans: [
        { id: "c0ffee11", key: "", at: Date.now(), name: "Carol" },
        // A day before this device joined, and one from before removals had a time.
        { id: "d00d0001", key: "", at: Date.now() - 86_400_000, name: "Dave" },
        { id: "d00d0002", key: "", name: "Erin" },
      ],
    }) + "\n");
    await settle();
    assert.deepEqual(await notices(), shown);
    // They are still removed, only not announced.
    assert.deepEqual((await roomOf(THEIR_ROOM)).bans.map((ban) => ban.id).sort(), ["c0ffee11", "d00d0001", "d00d0002"]);
  });
});
