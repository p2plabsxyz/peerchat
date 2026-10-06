// Phones announced themselves before they had a name, with their id where the
// name belongs, and desktops wrote "ac368f46 joined" into the room for good.
// A join from someone without a name is not news now, and old lines read with
// the name the person has since.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import SecretStream from "@hyperswarm/secret-stream";

import { deriveTopic, handleChatRequest, initChat } from "../p2p.js";
import { attachChatTransport } from "../transport.js";
import { nameNotice } from "../lib/notice-names.js";
import { buildDirectory } from "../lib/members.js";
import { securePair, topicsFrame, wireRoom } from "./helpers.mjs";

const ROOM = "aa".repeat(32);
const NEWCOMER = SecretStream.keyPair(Buffer.alloc(32, 3));
const LEAVER = SecretStream.keyPair(Buffer.alloc(32, 4));
const shortId = (keyPair) => keyPair.publicKey.toString("hex").slice(0, 8);

describe("an id where a name belongs", () => {
  const names = { ac368f46: "Sam", "7bb2c919": "7bb2c919" };
  const nameFor = (id) => names[id] || "";

  it("reads with the name the person has since", () => {
    assert.equal(nameNotice("ac368f46 joined", nameFor), "Sam joined");
    assert.equal(nameNotice("ac368f46 left", nameFor), "Sam left");
    assert.equal(nameNotice("ac368f46 was removed from the room by Alice", nameFor), "Sam was removed from the room by Alice");
  });

  it("leaves out a join or leave from someone who never took a name", () => {
    assert.equal(nameNotice("fe5a73d9 joined", nameFor), null);
    assert.equal(nameNotice("fe5a73d9 left", nameFor), null);
    // A name that is only the id again is none either.
    assert.equal(nameNotice("7bb2c919 joined", nameFor), null);
    // A removal still happened, so it stays, without the id.
    assert.equal(nameNotice("fe5a73d9 was removed from the room by Alice", nameFor), "Someone was removed from the room by Alice");
  });

  it("keeps everything else as written", () => {
    assert.equal(nameNotice("Gus joined", nameFor), "Gus joined");
    assert.equal(nameNotice("jack Sparrow joined", nameFor), "jack Sparrow joined");
    assert.equal(nameNotice("Final warning for Bob (spam)", nameFor), "Final warning for Bob (spam)");
    // Somebody may really be called eight hex letters.
    assert.equal(nameNotice("deadbeef joined", nameFor, (name) => name === "deadbeef"), "deadbeef joined");
  });

  it("finds nobody by their id alone", () => {
    const found = buildDirectory({
      members: { ac368f46: { username: "Sam" }, fe5a73d9: {}, "7bb2c919": { username: "7bb2c919" } },
    });
    assert.deepEqual(found.map((person) => person.username), ["Sam"]);
  });
});

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

async function call(action, method, body, roomKey) {
  const qs = `hyper://chat?action=${action}${roomKey ? `&roomKey=${roomKey}` : ""}`;
  const res = await handleChatRequest({ url: qs, method, json: async () => body ?? {} }, sdk);
  return JSON.parse(await res.text());
}
const members = async () => ((await call("get-rooms", "GET")).rooms || []).find((room) => room.roomKey === ROOM)?.members || {};
const systemTexts = async () =>
  ((await call("get-history", "GET", null, ROOM)).messages || []).filter((m) => m.type === "system").map((m) => m.text);

const open = [];
async function connect(keyPair) {
  const pair = await securePair({ clientKeyPair: keyPair });
  const peer = { pair, transport: null, frames: [] };
  open.push(peer);
  swarm.emit("connection", pair.serverStream, { topics: [deriveTopic(ROOM)] });
  let buffer = "";
  await new Promise((opened) => {
    peer.transport = attachChatTransport(pair.clientStream, (raw) => {
      buffer += raw.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop();
      for (const line of lines) if (line) try { peer.frames.push(JSON.parse(line)); } catch {}
    }, { onopen: opened });
  });
  peer.send = (frame) => peer.transport.send(typeof frame === "string" ? frame : JSON.stringify(frame) + "\n");
  for (let i = 0; i < 100 && !peer.frames.some((f) => f.type === "topics"); i++) await sleep(50);
  peer.send(topicsFrame(pair.clientStream, [ROOM]));
  for (let i = 0; i < 100 && !peer.frames.some((f) => f.type === "room-meta"); i++) await sleep(50);
  return peer;
}

describe("a join without a name", () => {
  let dir;

  before(async () => {
    dir = mkdtempSync(path.join(tmpdir(), "peerchat-notice-names-"));
    writeFileSync(path.join(dir, "chat.json"), JSON.stringify({
      v: 1, profile: { username: "ada", bio: "", at: 1000 }, peerProfiles: {}, pendingDMs: {},
      rooms: {
        [ROOM]: {
          roomKey: ROOM, name: "P2P Republic", isHost: true, bio: "", link: "", avatar: null,
          createdAt: Date.now(), createdBy: "07070707", createdByName: "ada",
          isPinned: false, isMuted: false, unreadCount: 0, unreadMentions: 0, lastMessage: null,
          members: { [shortId(LEAVER)]: { username: shortId(LEAVER), joinedAt: 1 } },
        },
      },
    }));
    initChat(sdk, { storagePath: path.join(dir, "chat.json") });
    await sleep(200);
  });

  after(async () => {
    for (const peer of open) {
      try { peer.transport?.close(); } catch {}
      await peer.pair.close().catch(() => {});
    }
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("is no member and no line, until they join again with a name", async () => {
    const peer = await connect(NEWCOMER);
    const id = shortId(NEWCOMER);
    // What a phone sent while onboarding: its id as its name.
    peer.send({ type: "join", room: wireRoom(ROOM), peerId: id, username: id, ts: Date.now() - 5000 });
    await sleep(400);
    assert.equal((await members())[id], undefined);
    assert.deepEqual((await systemTexts()).filter((t) => t.includes("joined")), []);

    peer.send({ type: "join", room: wireRoom(ROOM), peerId: id, username: "Sam", ts: Date.now() - 5000 });
    for (let i = 0; i < 60 && !(await systemTexts()).includes("Sam joined"); i++) await sleep(50);
    assert.ok((await systemTexts()).includes("Sam joined"));
    assert.equal((await members())[id]?.username, "Sam");
  });

  it("leaves no line when the one leaving never had a name", async () => {
    const peer = await connect(LEAVER);
    const id = shortId(LEAVER);
    peer.send({ type: "leave", room: wireRoom(ROOM), peerId: id, username: "", ts: Date.now() });
    await sleep(400);
    assert.deepEqual((await systemTexts()).filter((t) => t.endsWith(" left")), []);
  });
});

describe("on screen", async () => {
  const { readFile } = await import("node:fs/promises");
  const app = await readFile(new URL("../app.js", import.meta.url), "utf8");
  const css = await readFile(new URL("../styles.css", import.meta.url), "utf8");

  it("draws system lines through the names, in the list and as they arrive", () => {
    assert.match(app, /el\.textContent = systemText\(m\);/);
    assert.match(app, /const text = systemText\(msg\);\s+if \(!text\) return true;/);
    assert.match(app, /if \(m\.type === "system"\) return \(systemText\(m\) \|\| ""\)\.toLowerCase\(\)\.includes\(q\);/);
  });

  it("lists nobody by their id", () => {
    assert.match(app, /const memberName = nameForPeer\(id\);\s+if \(!self && !memberName\) continue;/);
    assert.match(app, /if \(!username\) return;\s+S\.peerProfiles\[peerId\] = \{ username,/);
  });

  it("says Online, Idle or Offline over a direct message, and counts people in a group", () => {
    assert.match(app, /if \(room\?\.isDM && room\.dmWith\) \{\s+const presence = peerPresence\(room\.dmWith\);\s+el\.textContent = PRESENCE_LABELS\[presence\];/);
    assert.match(app, /function refreshPresence\(peerId\) \{\s+updateRoomPeerCount\(S\.activeRoom\);/);
    assert.match(css, /#chat-room-peers\[data-presence="idle"\] \{ color: #f0b232; \}/);
  });
});
