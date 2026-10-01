// A room's topic is public: DHT nodes see it on its way past. So knowing a
// topic must get a peer nothing, and a room's key must never cross the wire
// except to hand it to the one person it is meant for. These run the real chat
// code over a real Noise connection.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { randomBytes } from "node:crypto";
import SecretStream from "@hyperswarm/secret-stream";

import { deriveTopic, encryptMsg, handleChatRequest, initChat } from "../p2p.js";
import { attachChatTransport, CHAT_PROTOCOL } from "../transport.js";
import { checkRoomProof, roomProof } from "../lib/room-proof.js";
import { securePair, topicsFrame, wireRoom } from "./helpers.mjs";

const ROOM = "aa".repeat(32);
const OTHER = "bb".repeat(32);
const DM_BOUND_ELSEWHERE = "c1".repeat(32);
const DM_UNBOUND = "c2".repeat(32);
const DM_ACCEPTED = "c3".repeat(32);
const DM_FROM_PEER = "c4".repeat(32);
const DM_ACCEPT_FROM_WRONG_KEY = "c5".repeat(32);
const KEYS = [ROOM, OTHER, DM_BOUND_ELSEWHERE, DM_UNBOUND, DM_ACCEPTED, DM_FROM_PEER, DM_ACCEPT_FROM_WRONG_KEY];

const person = (seed) => SecretStream.keyPair(Buffer.alloc(32, seed));
const ALICE = person(1);
const BOB = person(2);
const CAROL = person(3);
const ERIN = person(4);
const FRANK = person(5);
const GRACE = person(6);
const HEIDI = person(7);
const full = (keyPair) => keyPair.publicKey.toString("hex");
const short = (keyPair) => full(keyPair).slice(0, 8);

// Frames that would tell a peer about a room it is in.
const ROOM_FRAMES = new Set(["room-meta", "room-bans", "members-list", "join", "profile", "sync", "sync-system", "sync-reaction"]);

const swarm = new EventEmitter();
swarm.flush = async () => {};
const feeds = new Map();
function fakeFeed() {
  const feed = new EventEmitter();
  const entries = [];
  Object.defineProperty(feed, "length", { get: () => entries.length });
  feed.entries = entries;
  feed.ready = async () => {};
  feed.get = async (index) => structuredClone(entries[index]);
  feed.append = async (entry) => { entries.push(structuredClone(entry)); feed.emit("append"); };
  return feed;
}
const sdk = {
  publicKey: Buffer.alloc(32, 7),
  corestore: {
    get({ name }) {
      if (!feeds.has(name)) feeds.set(name, fakeFeed());
      return feeds.get(name);
    },
  },
  join() {},
  swarm,
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

async function call(action, method, body, roomKey) {
  const qs = `hyper://chat?action=${action}${roomKey ? `&roomKey=${roomKey}` : ""}`;
  const res = await handleChatRequest({ url: qs, method, json: async () => body ?? {} }, sdk);
  return JSON.parse(await res.text());
}

function room(roomKey, name, extra = {}) {
  return {
    roomKey, name, isHost: true, bio: "", link: "", avatar: null,
    createdAt: Date.now(), createdBy: "07070707", createdByName: "ada",
    isPinned: false, isMuted: false, unreadCount: 0, unreadMentions: 0,
    lastMessage: null, members: {}, ...extra,
  };
}

function dm(roomKey, keyPair, extra = {}) {
  return room(roomKey, "them", { isHost: false, isDM: true, dmWith: short(keyPair), ...extra });
}

const open = [];

// A peer connecting the way the swarm hands one over, found under the given
// rooms' topics, which is all anyone watching the DHT would know.
async function connect({ keyPair, foundUnder = [ROOM] } = {}) {
  const pair = await securePair(keyPair ? { clientKeyPair: keyPair } : {});
  const peer = { pair, frames: [], lines: [], transport: null };
  open.push(peer);
  swarm.emit("connection", pair.serverStream, { topics: foundUnder.map((roomKey) => deriveTopic(roomKey)) });
  let buffer = "";
  await new Promise((opened) => {
    peer.transport = attachChatTransport(pair.clientStream, (raw) => {
      buffer += raw.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop();
      for (const line of lines) {
        if (!line) continue;
        peer.lines.push(line);
        try { peer.frames.push(JSON.parse(line)); } catch {}
      }
    }, { onopen: opened });
  });
  peer.send = (frame) => peer.transport.send(typeof frame === "string" ? frame : JSON.stringify(frame) + "\n");
  return peer;
}

function roomFramesFor(peer, roomKey) {
  const topic = wireRoom(roomKey);
  return peer.frames.filter((frame) =>
    ROOM_FRAMES.has(frame.type) && (frame.room === topic || frame.roomKey === roomKey || frame.type === "profile"),
  );
}

function assertNoKeysOnTheWire(peer, allowed = []) {
  for (const line of peer.lines) {
    for (const key of KEYS) {
      if (allowed.includes(key)) continue;
      assert.equal(line.includes(key), false, `a frame carried a room key: ${line.slice(0, 120)}`);
    }
  }
}

describe("room proofs", () => {
  it("match the vector PeerSky Mobile pins", () => {
    assert.equal(
      roomProof("0f".repeat(32), "0e".repeat(64), "0d".repeat(32)),
      "08ad4e5c5831d8c8edb20824f5e8b1a06ebef6d751b3a8642c2a766cc2ad22ce",
    );
  });

  it("are only good for the key, the connection and the sender they were made for", () => {
    const handshake = "0e".repeat(64);
    const sender = "0d".repeat(32);
    const proof = roomProof(ROOM, handshake, sender);
    assert.equal(checkRoomProof(ROOM, handshake, sender, proof), true);
    assert.equal(checkRoomProof(OTHER, handshake, sender, proof), false);
    assert.equal(checkRoomProof(ROOM, "0c".repeat(64), sender, proof), false);
    assert.equal(checkRoomProof(ROOM, handshake, "0b".repeat(32), proof), false);
    assert.equal(checkRoomProof(ROOM, handshake, sender, ""), false);
    assert.equal(checkRoomProof(ROOM, handshake, sender, proof.toUpperCase()), false);
    assert.equal(roomProof(ROOM, "", sender), "");
    assert.equal(roomProof("not a key", handshake, sender), "");
  });

  it("come with a new version of the chat channel, so older builds never half talk", () => {
    assert.equal(CHAT_PROTOCOL, "peersky-chat/2");
  });
});

describe("a room on the wire", () => {
  let dir;

  before(async () => {
    dir = mkdtempSync(path.join(tmpdir(), "peerchat-room-proof-"));
    const storagePath = path.join(dir, "chat.json");
    writeFileSync(storagePath, JSON.stringify({
      v: 1, profile: { username: "ada", bio: "", at: 1000 }, peerProfiles: {}, pendingDMs: {},
      rooms: {
        [ROOM]: room(ROOM, "Launch crew"),
        [OTHER]: room(OTHER, "Other room"),
        [DM_BOUND_ELSEWHERE]: dm(DM_BOUND_ELSEWHERE, ALICE, { pendingAcceptance: true, dmWithKey: full(BOB) }),
        [DM_UNBOUND]: dm(DM_UNBOUND, CAROL, { pendingAcceptance: true }),
        [DM_ACCEPTED]: dm(DM_ACCEPTED, CAROL, { pendingAcceptance: false, dmWithKey: full(CAROL) }),
        [DM_ACCEPT_FROM_WRONG_KEY]: dm(DM_ACCEPT_FROM_WRONG_KEY, FRANK, { pendingAcceptance: true, dmWithKey: full(GRACE) }),
      },
    }));
    initChat(sdk, { storagePath });
    await sleep(200);
  });

  after(async () => {
    for (const peer of open) {
      try { peer.transport?.close(); } catch {}
      await peer.pair.close().catch(() => {});
    }
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  const saved = () => JSON.parse(readFileSync(path.join(dir, "chat.json"), "utf8"));

  it("gives a peer that only knows the topic nothing at all", async () => {
    const eve = await connect();
    // What this device says first: the rooms it is in, by topic, each with a
    // proof made for this connection. No key.
    const topics = await eventually(() => eve.frames.find((frame) => frame.type === "topics"), "the topics frame");
    const own = topics.rooms.find((entry) => entry.topic === wireRoom(ROOM));
    assert.ok(own);
    assert.equal(checkRoomProof(ROOM, eve.pair.clientStream.handshakeHash, eve.pair.serverStream.publicKey, own.proof), true);

    // The topic alone, the way a build before proofs said it, then a made-up
    // proof, then a join naming the room as if already in.
    eve.send({ type: "topics", topics: [wireRoom(ROOM)] });
    eve.send({ type: "topics", rooms: [{ topic: wireRoom(ROOM), proof: "00".repeat(32) }] });
    eve.send({ type: "join", room: wireRoom(ROOM), peerId: "0e0e0e0e", username: "eve", ts: 1 });
    await sleep(800);

    assert.deepEqual(roomFramesFor(eve, ROOM), []);
    assertNoKeysOnTheWire(eve);
  });

  it("opens nothing for a proof made on another connection, or bounced back", async () => {
    const mallory = await connect();
    const theirs = await eventually(() => mallory.frames.find((frame) => frame.type === "topics"), "the topics frame");
    // A proof made for some other connection with this key, and this device's
    // own proof sent straight back to it.
    const elsewhere = roomProof(ROOM, randomBytes(64), mallory.pair.clientStream.publicKey);
    const bounced = theirs.rooms.find((entry) => entry.topic === wireRoom(ROOM)).proof;
    mallory.send({ type: "topics", rooms: [{ topic: wireRoom(ROOM), proof: elsewhere }] });
    mallory.send({ type: "topics", rooms: [{ topic: wireRoom(ROOM), proof: bounced }] });
    await sleep(800);

    assert.deepEqual(roomFramesFor(mallory, ROOM), []);
    assertNoKeysOnTheWire(mallory);
  });

  it("opens the room to a peer holding its key, and its key still never crosses the wire", async () => {
    const member = await connect();
    member.send(topicsFrame(member.pair.clientStream, [ROOM]));

    const meta = await eventually(() => member.frames.find((frame) => frame.type === "room-meta"), "the room's details");
    assert.equal(meta.room, wireRoom(ROOM));
    assert.equal(meta.roomKey, undefined);
    assert.equal(meta.name, "Launch crew");
    const join = await eventually(() => member.frames.find((frame) => frame.type === "join"), "this device's join");
    assert.equal(join.room, wireRoom(ROOM));

    // Their own join and a message, naming the room the same way.
    const memberId = member.pair.clientStream.publicKey.toString("hex").slice(0, 8);
    member.send({ type: "join", room: wireRoom(ROOM), peerId: memberId, username: "bea", ts: Date.now() });
    const id = randomBytes(16).toString("hex");
    member.send({ room: wireRoom(ROOM), id, sender: memberId, sn: "bea", ts: Date.now(), ...encryptMsg("hi from bea", ROOM) });
    const history = await eventually(async () => {
      const { messages } = await call("get-history", "GET", null, ROOM);
      return messages?.find((message) => message.id === id);
    }, "the message in the room");
    assert.equal(history.message, "hi from bea");

    // Being in one room says nothing about another this device is in.
    assert.deepEqual(roomFramesFor(member, OTHER).filter((frame) => frame.type !== "profile"), []);
    assertNoKeysOnTheWire(member);
  });

  it("says a new member's arrival once, with the profile ahead of the join as rooms now open", async () => {
    const zed = await connect();
    zed.send(topicsFrame(zed.pair.clientStream, [OTHER]));
    await eventually(() => zed.frames.find((frame) => frame.type === "room-meta" && frame.room === wireRoom(OTHER)), "the room");
    const zedId = zed.pair.clientStream.publicKey.toString("hex").slice(0, 8);
    zed.send({ type: "profile", peerId: zedId, username: "zed", bio: "", avatar: null, rooms: [wireRoom(OTHER)] });
    zed.send({ type: "join", room: wireRoom(OTHER), peerId: zedId, username: "zed", ts: Date.now() });
    const notes = await eventually(async () => {
      const { messages } = await call("get-history", "GET", null, OTHER);
      const joined = messages.filter((message) => message.type === "system" && message.text === "zed joined");
      return joined.length ? joined : null;
    }, "the arrival");
    await sleep(300);
    const { messages } = await call("get-history", "GET", null, OTHER);
    assert.equal(messages.filter((message) => message.type === "system" && message.text === "zed joined").length, 1);
    assert.equal(notes.length, 1);
  });

  it("re-sends a waiting invite only to the key it is bound to, never just to a matching short id", async () => {
    // Alice has the short id the invite was written for, but it is bound to
    // Bob's key, so a key ground to match the short id gets nothing either.
    const alice = await connect({ keyPair: ALICE });
    await sleep(800);
    assert.equal(alice.frames.some((frame) => frame.type === "dm-invite"), false);
    assertNoKeysOnTheWire(alice);
  });

  it("binds a waiting invite to the first key it goes to, and never re-sends an accepted one", async () => {
    const carol = await connect({ keyPair: CAROL });
    const invite = await eventually(() => carol.frames.find((frame) => frame.type === "dm-invite"), "the waiting invite");
    // The one place a key goes over the wire: to the person it is for.
    assert.equal(invite.roomKey, DM_UNBOUND);
    await sleep(300);
    assert.equal(carol.frames.filter((frame) => frame.type === "dm-invite").length, 1);
    assertNoKeysOnTheWire(carol, [DM_UNBOUND]);
    await eventually(() => saved().rooms[DM_UNBOUND]?.dmWithKey === full(CAROL), "the invite bound to Carol's key");
  });

  it("starts a conversation with the one key behind a short id, and binds it", async () => {
    const erin = await connect({ keyPair: ERIN });
    erin.send(topicsFrame(erin.pair.clientStream, [ROOM]));
    await eventually(() => erin.frames.find((frame) => frame.type === "room-meta"), "the room");

    const { roomKey } = await call("join-dm", "POST", { toId: short(ERIN), toUsername: "erin" });
    const invite = await eventually(() => erin.frames.find((frame) => frame.type === "dm-invite"), "the invite");
    assert.equal(invite.roomKey, roomKey);
    await eventually(() => saved().rooms[roomKey]?.dmWithKey === full(ERIN), "the conversation bound to Erin's key");
  });

  it("binds an accepted invite to the key it came from, and answers by topic", async () => {
    const heidi = await connect({ keyPair: HEIDI });
    heidi.send({
      type: "dm-invite", roomKey: DM_FROM_PEER, fromId: short(HEIDI), fromUsername: "heidi",
      fromAvatar: null, fromBio: "", toId: "07070707",
    });
    await eventually(async () => {
      const state = saved();
      return state.pendingDMs?.[DM_FROM_PEER];
    }, "the request");
    await call("accept-dm", "POST", { roomKey: DM_FROM_PEER });
    const accept = await eventually(() => heidi.frames.find((frame) => frame.type === "dm-accept"), "the answer");
    assert.equal(accept.room, wireRoom(DM_FROM_PEER));
    assert.equal(accept.roomKey, undefined);
    await eventually(() => saved().rooms[DM_FROM_PEER]?.dmWithKey === full(HEIDI), "the conversation bound to Heidi's key");
  });

  it("ignores an answer from a key the conversation is not bound to", async () => {
    const frank = await connect({ keyPair: FRANK });
    frank.send({ type: "dm-accept", room: wireRoom(DM_ACCEPT_FROM_WRONG_KEY), fromId: short(FRANK), fromUsername: "frank" });
    await sleep(600);
    assert.equal(saved().rooms[DM_ACCEPT_FROM_WRONG_KEY].pendingAcceptance, true);
  });

  it("keeps the first message of a conversation, sent the moment it is accepted", async () => {
    // On a real network the flush after joining takes seconds. The proof used
    // to go out before it and the feed open after, so a message sent straight
    // back had nowhere to go.
    const NEW_DM = "dd".repeat(32);
    const IVY = person(8);
    const ivy = await connect({ keyPair: IVY });
    ivy.send({
      type: "dm-invite", roomKey: NEW_DM, fromId: short(IVY), fromUsername: "ivy",
      fromAvatar: null, fromBio: "", toId: "07070707",
    });
    await eventually(() => saved().pendingDMs?.[NEW_DM], "the request");

    let release = () => {};
    swarm.flush = () => new Promise((resolve) => { release = resolve; });
    try {
      const accepting = call("accept-dm", "POST", { roomKey: NEW_DM });
      await eventually(() => ivy.frames.some((frame) =>
        frame.type === "topics" && frame.rooms.some((entry) => entry.topic === wireRoom(NEW_DM))), "the conversation's proof");

      const id = randomBytes(16).toString("hex");
      ivy.send(topicsFrame(ivy.pair.clientStream, [NEW_DM]));
      ivy.send({ room: wireRoom(NEW_DM), id, sender: short(IVY), sn: "ivy", ts: Date.now(), ...encryptMsg("first!", NEW_DM) });
      const kept = await eventually(async () => {
        const { messages } = await call("get-history", "GET", null, NEW_DM);
        return messages?.find((message) => message.id === id);
      }, "the first message");
      assert.equal(kept.message, "first!");

      release();
      await accepting;
    } finally {
      swarm.flush = async () => {};
      release();
    }
  });
});
