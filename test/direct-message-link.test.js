// A personal link carries the whole key, so the request it starts goes to that
// key alone, even while another connected key starts the same way. An older
// link, or a member picked from a list, has only the peer id, and while two
// keys share it the request waits.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";

import { deriveTopic, handleChatRequest, initChat } from "../p2p.js";
import { attachChatTransport } from "../transport.js";
import { securePair } from "./helpers.mjs";

const GROUP = "e1".repeat(32);
const PEER_ID = "ab12cd34";
// Two keys that start the same way, as one made to match somebody's would.
const BOB = `${PEER_ID}${"11".repeat(28)}`;
const MALLORY = `${PEER_ID}${"22".repeat(28)}`;

const swarm = new EventEmitter();
swarm.flush = async () => {};
const feeds = new Map();
function fakeFeed() {
  const feed = new EventEmitter();
  const entries = [];
  Object.defineProperty(feed, "length", { get: () => entries.length });
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

async function call(action, method, body) {
  const res = await handleChatRequest({ url: `hyper://chat?action=${action}`, method, json: async () => body ?? {} }, sdk);
  return { status: res.status, body: JSON.parse(await res.text()) };
}

// A peer connected under the group's topic, whose key the handshake gives as
// the one asked for. Making two real keys that start the same way would take
// billions of tries.
async function connect(key) {
  const pair = await securePair();
  pair.serverStream.remotePublicKey = Buffer.from(key, "hex");
  const peer = { pair, frames: [], transport: null };
  swarm.emit("connection", pair.serverStream, { topics: [deriveTopic(GROUP)] });
  let buffer = "";
  await new Promise((opened) => {
    peer.transport = attachChatTransport(pair.clientStream, (raw) => {
      buffer += raw.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop();
      for (const line of lines) if (line) try { peer.frames.push(JSON.parse(line)); } catch {}
    }, { onopen: opened });
  });
  // Our proofs go out once the peer is in, so they say it is.
  for (let i = 0; i < 100 && !peer.frames.some((f) => f.type === "topics"); i++) await sleep(50);
  return peer;
}

const invites = (peer) => peer.frames.filter((f) => f.type === "dm-invite");

describe("a request from a personal link", () => {
  let dir;
  let bob;
  let mallory;

  before(async () => {
    dir = mkdtempSync(path.join(tmpdir(), "peerchat-dm-link-"));
    writeFileSync(path.join(dir, "chat.json"), JSON.stringify({
      v: 1, profile: { username: "ada", bio: "", at: 1000 }, peerProfiles: {}, pendingDMs: {},
      rooms: {
        [GROUP]: {
          roomKey: GROUP, name: "Launch crew", isHost: true, bio: "", link: "", avatar: null,
          createdAt: Date.now(), createdBy: "07070707", createdByName: "ada",
          isPinned: false, isMuted: false, unreadCount: 0, unreadMentions: 0,
          lastMessage: null, members: {},
        },
      },
    }));
    initChat(sdk, { storagePath: path.join(dir, "chat.json") });
    await sleep(200);
    bob = await connect(BOB);
    mallory = await connect(MALLORY);
  });

  after(async () => {
    for (const peer of [bob, mallory]) {
      try { peer?.transport?.close(); } catch {}
      await peer?.pair.close().catch(() => {});
    }
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("gives your own link the whole key your id starts", async () => {
    const { body } = await call("get-profile", "GET");
    assert.equal(body.key, "07".repeat(32));
    assert.equal(body.key.slice(0, 8), body.id);
  });

  it("waits with only the peer id while two keys share it", async () => {
    // Both are in, so it is the shared id that holds it back.
    for (const peer of [bob, mallory]) assert.ok(peer.frames.some((f) => f.type === "topics"));
    const { status, body } = await call("join-dm", "POST", { toId: PEER_ID, toUsername: "Bob" });
    assert.equal(status, 200);
    await sleep(300);
    assert.equal(invites(bob).length + invites(mallory).length, 0);
    const { body: list } = await call("get-rooms", "GET");
    assert.equal(list.rooms.find((room) => room.roomKey === body.roomKey).dmWithKey, null);
  });

  it("goes to the key the link names, and nobody else", async () => {
    const { status, body } = await call("join-dm", "POST", { toKey: BOB.toUpperCase(), toUsername: "Bob" });
    assert.equal(status, 200);
    for (let i = 0; i < 60 && !invites(bob).length; i++) await sleep(50);
    assert.equal(invites(bob).length, 1);
    assert.equal(invites(bob)[0].roomKey, body.roomKey);
    await sleep(200);
    assert.equal(invites(mallory).length, 0);

    const { body: list } = await call("get-rooms", "GET");
    const dms = list.rooms.filter((room) => room.isDM);
    assert.equal(dms.length, 1, "the request that was waiting, not a second one");
    assert.equal(dms[0].dmWith, PEER_ID);
    assert.equal(dms[0].dmWithKey, BOB);
  });

  it("does not open someone else's conversation for a key that starts the same", async () => {
    const { status, body } = await call("join-dm", "POST", { toKey: MALLORY, toUsername: "Bob" });
    assert.equal(status, 409);
    assert.match(body.error, /someone else with this id/);
    await sleep(200);
    assert.equal(invites(mallory).length, 0);
    const { body: list } = await call("get-rooms", "GET");
    assert.equal(list.rooms.find((room) => room.isDM).dmWithKey, BOB);
  });
});
