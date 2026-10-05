// Whether someone is away: their PeerSky in the background or their computer
// idle, or a phone with PeerChat in the background. Only someone in a room with
// us hears ours or can set theirs, and it runs over a real Noise connection.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import SecretStream from "@hyperswarm/secret-stream";

import { deriveTopic, handleChatRequest, initChat, setPresenceIdle } from "../p2p.js";
import { attachChatTransport } from "../transport.js";
import { securePair, topicsFrame } from "./helpers.mjs";

const ROOM = "aa".repeat(32);
const BEA = SecretStream.keyPair(Buffer.alloc(32, 2));
const shortId = (stream) => stream.publicKey.toString("hex").slice(0, 8);

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

async function eventually(check, label) {
  for (let i = 0; i < 100; i++) {
    const value = await check();
    if (value) return value;
    await sleep(50);
  }
  throw new Error(`timed out waiting for ${label}`);
}

async function idleIds() {
  const res = await handleChatRequest({ url: "hyper://chat?action=get-rooms", method: "GET", json: async () => ({}) }, sdk);
  const data = JSON.parse(await res.text());
  return { online: data.onlinePeers, idle: data.idlePeers };
}

const open = [];

async function connect({ keyPair } = {}) {
  const pair = await securePair(keyPair ? { clientKeyPair: keyPair } : {});
  const peer = { pair, frames: [], transport: null };
  open.push(peer);
  swarm.emit("connection", pair.serverStream, { topics: [deriveTopic(ROOM)] });
  let buffer = "";
  await new Promise((opened) => {
    peer.transport = attachChatTransport(pair.clientStream, (raw) => {
      buffer += raw.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop();
      for (const line of lines) {
        if (!line) continue;
        try { peer.frames.push(JSON.parse(line)); } catch {}
      }
    }, { onopen: opened });
  });
  peer.send = (frame) => peer.transport.send(typeof frame === "string" ? frame : JSON.stringify(frame) + "\n");
  peer.presence = () => peer.frames.filter((frame) => frame.type === "presence").map((frame) => frame.state);
  await eventually(() => peer.frames.find((frame) => frame.type === "topics"), "the topics frame");
  return peer;
}

describe("idle", () => {
  let dir;

  before(async () => {
    dir = mkdtempSync(path.join(tmpdir(), "peerchat-idle-"));
    const storagePath = path.join(dir, "chat.json");
    writeFileSync(storagePath, JSON.stringify({
      v: 1, profile: { username: "ada", bio: "", at: 1000 }, peerProfiles: {}, pendingDMs: {},
      rooms: {
        [ROOM]: {
          roomKey: ROOM, name: "Launch crew", isHost: true, bio: "", link: "", avatar: null,
          createdAt: Date.now(), createdBy: "07070707", createdByName: "ada",
          isPinned: false, isMuted: false, unreadCount: 0, unreadMentions: 0, lastMessage: null, members: {},
        },
      },
    }));
    initChat(sdk, { storagePath });
    await sleep(200);
  });

  after(async () => {
    setPresenceIdle(false);
    for (const peer of open) {
      try { peer.transport?.close(); } catch {}
      await peer.pair.close().catch(() => {});
    }
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("is nothing to a peer that only knows the topic, either way", async () => {
    const eve = await connect();
    eve.send({ type: "presence", state: "idle" });
    setPresenceIdle(true);
    setPresenceIdle(false);
    await sleep(500);

    assert.deepEqual(eve.presence(), []);
    const { online, idle } = await idleIds();
    assert.ok(online.includes(shortId(eve.pair.clientStream)));
    assert.deepEqual(idle, []);
  });

  it("goes to a member once the room opens, and again each time it changes", async () => {
    const member = await connect();
    member.send(topicsFrame(member.pair.clientStream, [ROOM]));
    await eventually(() => member.presence().length === 1, "where this device is, as the room opens");
    assert.deepEqual(member.presence(), ["active"]);

    setPresenceIdle(true);
    setPresenceIdle(true);
    await eventually(() => member.presence().length === 2, "away");
    setPresenceIdle(false);
    await eventually(() => member.presence().length === 3, "back");
    await sleep(200);
    assert.deepEqual(member.presence(), ["active", "idle", "active"]);
  });

  it("shows a member who says they are away as idle, until they say otherwise", async () => {
    const bea = await connect({ keyPair: BEA });
    const id = shortId(bea.pair.clientStream);
    bea.send(topicsFrame(bea.pair.clientStream, [ROOM]));
    await eventually(() => bea.presence().length, "the room opening");

    bea.send({ type: "presence", state: "idle" });
    await eventually(async () => (await idleIds()).idle.includes(id), "bea away");
    bea.send({ type: "presence", state: "active" });
    await eventually(async () => !(await idleIds()).idle.includes(id), "bea back");
    bea.send({ type: "presence", state: "idle" });
    await eventually(async () => (await idleIds()).idle.includes(id), "bea away again");

    // A new connection starts as here: an older build never says either way,
    // and a newer one says again as the room opens on it.
    bea.transport.close();
    await bea.pair.close().catch(() => {});
    const again = await connect({ keyPair: BEA });
    await eventually(async () => (await idleIds()).online.includes(id), "bea online again");
    assert.equal((await idleIds()).idle.includes(id), false);
    again.send(topicsFrame(again.pair.clientStream, [ROOM]));
    await eventually(() => again.presence().length, "the room opening again");
    again.send({ type: "presence", state: "idle" });
    await eventually(async () => (await idleIds()).idle.includes(id), "bea away on the new connection");
  });

  it("stops listening to a peer that will not stop saying it", async () => {
    const noisy = await connect();
    const id = shortId(noisy.pair.clientStream);
    noisy.send(topicsFrame(noisy.pair.clientStream, [ROOM]));
    await eventually(() => noisy.presence().length, "the room opening");

    for (let i = 0; i < 30; i++) noisy.send({ type: "presence", state: "active" });
    noisy.send({ type: "presence", state: "idle" });
    await sleep(800);
    assert.equal((await idleIds()).idle.includes(id), false);
  });
});

describe("idle on screen", async () => {
  const { readFile } = await import("node:fs/promises");
  const { buildDirectory, collapseMembers } = await import("../lib/members.js");
  const app = await readFile(new URL("../app.js", import.meta.url), "utf8");
  const css = await readFile(new URL("../styles.css", import.meta.url), "utf8");

  it("is one person here on one device and away on another: here", () => {
    const collapsed = collapseMembers([
      { id: "aaaaaaaa", username: "Bea", online: true, idle: true, self: false },
      { id: "bbbbbbbb", username: "Bea", online: true, idle: false, self: false },
    ]);
    assert.deepEqual(collapsed.map((member) => member.id), ["bbbbbbbb"]);

    const found = buildDirectory({
      members: { aaaaaaaa: { username: "Bea" }, cccccccc: { username: "Cal" } },
      onlinePeers: new Set(["aaaaaaaa", "cccccccc"]),
      idlePeers: new Set(["aaaaaaaa", "dddddddd"]),
    });
    assert.deepEqual(found.map((person) => [person.username, person.idle]), [["Bea", true], ["Cal", false]]);
  });

  it("draws a yellow dot and says Idle, while a group's count stays who is online", () => {
    assert.match(css, /\.online-dot\.idle\s+\{ background: #f0b232; \}/);
    assert.match(app, /const PRESENCE_LABELS = \{ online: "Online", idle: "Idle", offline: "Offline" \};/);
    assert.match(app, /es\.addEventListener\("peer-idle"/);
    assert.match(app, /S\.idlePeers = new Set\(data\.idlePeers \|\| \[\]\);/);
    // The member list, the user card and the people search all ask the same.
    assert.match(app, /<span class="online-dot \$\{peerPresence\(dmId\)\}">/);
    assert.match(app, /const dot = isOn \? \(isIdle \? "idle" : "online"\) : "offline";/);
    assert.match(app, /renderUserStatus\(senderId\);/);
    assert.match(app, /idlePeers: S\.idlePeers,/);
    // The header counts people online, away or not.
    assert.match(app, /return Object\.keys\(room\.members \|\| \{\}\)\.filter\(id => \(id === S\.profile\?\.id\) \|\| S\.onlinePeers\.has\(id\)\)\.length;/);
  });
});
