// Leaving a direct chat used to tell the other person nothing, so they went on
// writing into a chat nobody read. Now they are told, now or when they come
// online, and their chat says so and takes no more messages until the person
// who left comes back. Mirrors peersky-mobile's peerchat-service tests.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import SecretStream from "@hyperswarm/secret-stream";

import { deriveTopic, handleChatRequest, initChat } from "../p2p.js";
import { attachChatTransport } from "../transport.js";
import { securePair, topicsFrame, wireRoom } from "./helpers.mjs";

const GROUP = "e1".repeat(32);
const DM = "e2".repeat(32);
// Sorts after any new key, for the last test.
const LEFT_DM = "ff".repeat(32);
const TWIN_DM = "e4".repeat(32);
const BOB = SecretStream.keyPair(Buffer.alloc(32, 11));
// Another of Ada's devices.
const TWIN = SecretStream.keyPair(Buffer.alloc(32, 12));
const full = (keyPair) => keyPair.publicKey.toString("hex");
const short = (keyPair) => full(keyPair).slice(0, 8);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const swarm = new EventEmitter();
swarm.flush = async () => {};
const joined = [];
const left = [];
function fakeFeed() {
  const feed = new EventEmitter();
  const entries = [];
  Object.defineProperty(feed, "length", { get: () => entries.length });
  feed.ready = async () => {};
  feed.get = async (index) => structuredClone(entries[index]);
  feed.append = async (entry) => { entries.push(structuredClone(entry)); feed.emit("append"); };
  return feed;
}
const feeds = new Map();
const sdk = {
  publicKey: Buffer.alloc(32, 7),
  corestore: { get: ({ name }) => feeds.get(name) || feeds.set(name, fakeFeed()).get(name) },
  join(topic) { joined.push(Buffer.from(topic).toString("hex")); },
  async leave(topic) { left.push(Buffer.from(topic).toString("hex")); },
  swarm,
};

async function request(action, method, body, roomKey) {
  const qs = `hyper://chat?action=${action}${roomKey ? `&roomKey=${roomKey}` : ""}`;
  const res = await handleChatRequest({ url: qs, method, json: async () => body ?? {} }, sdk);
  return { status: res.status, body: JSON.parse(await res.text()) };
}
const call = async (action, method, body, roomKey) => (await request(action, method, body, roomKey)).body;
const findRoom = async (roomKey) => (await call("get-rooms", "GET")).rooms.find((room) => room.roomKey === roomKey);
const until = async (check, label) => {
  for (let i = 0; i < 100; i++) {
    const value = await check();
    if (value) return value;
    await sleep(50);
  }
  throw new Error(`timed out waiting for ${label}`);
};

// A device of somebody's that connects, proves the rooms given and hands back
// what it is sent.
async function connect(keyPair, roomKeys) {
  const pair = await securePair({ clientKeyPair: keyPair });
  const frames = [];
  swarm.emit("connection", pair.serverStream, { topics: roomKeys.map((roomKey) => deriveTopic(roomKey)) });
  let buffer = "";
  const transport = await new Promise((opened) => {
    const t = attachChatTransport(pair.clientStream, (raw) => {
      buffer += raw.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop();
      for (const line of lines) if (line) try { frames.push(JSON.parse(line)); } catch {}
    }, { onopen: () => opened(t) });
  });
  await until(() => frames.some((f) => f.type === "topics"), "our proofs on the new connection");
  transport.send(topicsFrame(pair.clientStream, roomKeys));
  return {
    frames,
    send: (frame) => transport.send(JSON.stringify(frame) + "\n"),
    close: async () => {
      try { transport.close(); } catch {}
      await pair.close().catch(() => {});
    },
  };
}

// What the page hears, as it hears it.
async function pageEvents() {
  const res = await handleChatRequest({ url: "hyper://chat?action=receive-all", method: "GET", json: async () => ({}) }, sdk);
  const events = [];
  const reader = res.body.getReader();
  let buffer = "";
  (async () => {
    for (;;) {
      const { done, value } = await reader.read().catch(() => ({ done: true }));
      if (done) return;
      buffer += Buffer.from(value).toString();
      const frames = buffer.split("\n\n");
      buffer = frames.pop();
      for (const frame of frames) {
        const name = /^event: (.*)$/m.exec(frame)?.[1];
        const data = /^data: (.*)$/m.exec(frame)?.[1];
        if (name) try { events.push({ name, data: JSON.parse(data) }); } catch {}
      }
    }
  })();
  return { events, close: () => reader.cancel().catch(() => {}) };
}

function room(roomKey, name, extra = {}) {
  return {
    roomKey, name, isHost: true, bio: "", link: "", avatar: null,
    createdAt: Date.now() - 60_000, createdBy: "07070707", createdByName: "ada",
    isPinned: false, isMuted: false, unreadCount: 0, unreadMentions: 0,
    lastMessage: null, members: {}, ...extra,
  };
}

describe("leaving a direct chat", () => {
  let dir;
  let bob;

  before(async () => {
    dir = mkdtempSync(path.join(tmpdir(), "peerchat-dm-left-"));
    const dm = (roomKey) => room(roomKey, "bob", {
      isHost: false, isDM: true, dmWith: short(BOB), dmWithKey: full(BOB), pendingAcceptance: false,
    });
    writeFileSync(path.join(dir, "chat.json"), JSON.stringify({
      v: 1, profile: { username: "ada", bio: "", at: 1000 }, peerProfiles: {}, pendingDMs: {},
      link: { key: "cd".repeat(32) }, siblings: [short(TWIN)],
      rooms: { [GROUP]: room(GROUP, "Launch crew"), [DM]: dm(DM), [LEFT_DM]: dm(LEFT_DM), [TWIN_DM]: dm(TWIN_DM) },
    }));
    initChat(sdk, { storagePath: path.join(dir, "chat.json") });
    await sleep(200);

    const pair = await securePair({ clientKeyPair: BOB });
    bob = { pair, frames: [], transport: null };
    swarm.emit("connection", pair.serverStream, { topics: [GROUP, DM, LEFT_DM, TWIN_DM].map((roomKey) => deriveTopic(roomKey)) });
    let buffer = "";
    await new Promise((opened) => {
      bob.transport = attachChatTransport(pair.clientStream, (raw) => {
        buffer += raw.toString();
        const lines = buffer.split("\n");
        buffer = lines.pop();
        for (const line of lines) if (line) try { bob.frames.push(JSON.parse(line)); } catch {}
      }, { onopen: opened });
    });
    bob.send = (frame) => bob.transport.send(typeof frame === "string" ? frame : JSON.stringify(frame) + "\n");
    await until(() => bob.frames.some((f) => f.type === "topics"), "our proofs");
    bob.send(topicsFrame(pair.clientStream, [GROUP, DM, LEFT_DM, TWIN_DM]));
    await until(async () => (await call("net-status", "GET")).peers[0]?.rooms.length === 4, "the rooms to open");
  });

  after(async () => {
    try { bob?.transport?.close(); } catch {}
    await bob?.pair.close().catch(() => {});
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("takes a leave only about the device it came from", async () => {
    // In a group, somebody naming somebody else used to make them look gone.
    bob.send({ type: "leave", room: wireRoom(DM), peerId: "0a0b0c0d", username: "bob", ts: Date.now() });
    await sleep(300);
    assert.equal((await findRoom(DM)).leftByPeer, false);
  });

  it("closes the chat when the other person leaves, and says so", async () => {
    const at = Date.now() - 1000;
    bob.send({ type: "leave", room: wireRoom(DM), peerId: short(BOB), username: "bob", id: `${wireRoom(DM)}-${short(BOB)}-left-${at}`, ts: at });
    const closed = await until(async () => {
      const found = await findRoom(DM);
      return found?.leftByPeer ? found : null;
    }, "the leave");
    assert.equal(closed.leftByName, "bob");

    const sent = await request("send", "POST", { message: "still there?" }, DM);
    assert.equal(sent.status, 403);
    assert.match(sent.body.error, /left the chat/);
    const history = (await call("get-history", "GET", null, DM)).messages || [];
    assert.ok(history.some((m) => m.type === "system" && /bob left/.test(m.message ?? m.text)), "a line in the chat");
  });

  it("opens the chat again when they come back", async () => {
    const back = Date.now();
    bob.send({ type: "join", room: wireRoom(DM), peerId: short(BOB), username: "bob", ts: back });
    await until(async () => (await findRoom(DM))?.leftByPeer === false, "the join");
    // A leave from before that, from one of Bob's devices that left with
    // him, is old news.
    bob.send({ type: "leave", room: wireRoom(DM), peerId: short(BOB), username: "bob", id: `${wireRoom(DM)}-${short(BOB)}-left-${back - 1}`, ts: back - 1 });
    await sleep(300);
    assert.equal((await findRoom(DM)).leftByPeer, false);
    const sent = await request("send", "POST", { message: "welcome back" }, DM);
    assert.equal(sent.status, 200);
  });

  it("tells the other person when you leave, and again whenever they prove the chat", async () => {
    bob.frames.length = 0;
    const res = await request("delete-room", "POST", {}, LEFT_DM);
    assert.equal(res.status, 200);
    const leave = await until(() => bob.frames.find((f) => f.type === "leave" && f.room === wireRoom(LEFT_DM)), "our leave");
    assert.equal(await findRoom(LEFT_DM), undefined);
    // Its topic stays joined, so the leave can still reach them.
    assert.equal(left.includes(wireRoom(LEFT_DM)), false);

    // Bob's other device comes online later, on a connection of its own.
    const later = await connect(BOB, [LEFT_DM]);
    try {
      const again = await until(() => later.frames.find((f) => f.type === "leave" && f.room === wireRoom(LEFT_DM)), "the leave again");
      assert.equal(again.id, leave.id);
      assert.equal(again.ts, leave.ts);
      const proof = later.frames.find((f) => f.type === "topics" && f.rooms.some((entry) => entry.topic === wireRoom(LEFT_DM)));
      assert.ok(proof && later.frames.indexOf(proof) < later.frames.indexOf(again), "our proof for it goes first");
    } finally {
      await later.close();
    }
  });

  it("leaves a direct chat here when another of your devices left it", async () => {
    bob.frames.length = 0;
    const page = await pageEvents();
    const twin = await connect(TWIN, [TWIN_DM]);
    try {
      await until(async () => (await call("net-status", "GET")).peers.some((p) => p.rooms.length === 1), "the twin's proof");
      twin.send({ type: "leave", room: wireRoom(TWIN_DM), peerId: short(TWIN), username: "ada", ts: Date.now() });
      await until(async () => (await findRoom(TWIN_DM)) === undefined, "the chat left here");
      await until(() => page.events.find((e) => e.name === "room-left" && e.data.roomKey === TWIN_DM), "the page told");
      // Bob hears it from here too, and its topic stays joined for his devices.
      await until(() => bob.frames.find((f) => f.type === "leave" && f.room === wireRoom(TWIN_DM)), "the leave to Bob");
      assert.equal(left.includes(wireRoom(TWIN_DM)), false);
    } finally {
      page.close();
      await twin.close();
    }
  });

  // Ada left a chat with Bob and later pressed Message on him, which starts a
  // new one. Bob still has the old one and offers it back.
  it("opens the chat you left when they offer it back, not a second one", async () => {
    assert.equal((await request("delete-room", "POST", {}, DM)).status, 200);
    const { roomKey: fresh } = await call("join-dm", "POST", { toId: short(BOB), toUsername: "bob" });
    assert.ok(fresh && fresh !== DM && fresh !== LEFT_DM);
    await until(() => bob.frames.find((f) => f.type === "dm-invite" && f.roomKey === fresh), "our request");
    bob.frames.length = 0;
    const page = await pageEvents();

    try {
      bob.send({ type: "dm-invite", roomKey: LEFT_DM, fromId: short(BOB), fromUsername: "bob" });
      const offer = await until(async () => (await call("get-rooms", "GET")).pendingDMs?.[LEFT_DM], "the offer");
      assert.equal(offer.fromUsername, "bob");
      assert.equal(await findRoom(fresh), undefined, "the new one, with nothing in it, gives way");
      // The page showing it closes it.
      await until(() => page.events.find((e) => e.name === "room-left" && e.data.roomKey === fresh), "the page told");
      await sleep(300);
      assert.equal(bob.frames.some((f) => f.type === "dm-invite"), false, "and is not offered back");
    } finally {
      page.close();
    }
  });
});
