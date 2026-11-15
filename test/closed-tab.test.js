// A chat left open in a PeerSky Desktop tab that was then closed took what
// came in as read: the tab went before its page could say so, so the backend
// still had the chat on screen, and the home page's count missed it. Now the
// page sends an id of its own with its message stream and with the chat it
// shows, and the backend lets go of that chat when the page's stream ends.
import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";

import { encryptMsg, handleChatRequest, initChat } from "../p2p.js";

const ROOM = "c5".repeat(32);
const BEN = "0b".repeat(32);
const TAB_A = "a1".repeat(16);
const TAB_B = "b2".repeat(16);
const swarm = new EventEmitter();
swarm.flush = async () => {};
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
  publicKey: Buffer.alloc(32, 5),
  corestore: { get: ({ name }) => feeds.get(name) || feeds.set(name, fakeFeed()).get(name) },
  join() {},
  async leave() {},
  swarm,
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function call(action, roomKey, page) {
  const qs = `hyper://chat?action=${action}${roomKey ? `&roomKey=${roomKey}` : ""}${page ? `&page=${page}` : ""}`;
  const res = await handleChatRequest({ url: qs, method: action === "get-rooms" ? "GET" : "POST", json: async () => ({}) }, sdk);
  return JSON.parse(await res.text());
}
const unread = async () => (await call("get-rooms")).rooms.find((room) => room.roomKey === ROOM).unreadCount;

// A page's message stream, as PeerSky Desktop serves it. Closing a tab cancels
// it, as close() does here. Any left open by a failed check are closed after
// it, or their heartbeats would keep the run going.
const streams = new Set();
async function openStream(page) {
  const res = await handleChatRequest({ url: `hyper://chat?action=receive-all&page=${page}`, method: "GET", json: async () => ({}) }, sdk);
  const reader = res.body.getReader();
  await reader.read();
  const stream = {
    async close() {
      streams.delete(stream);
      await reader.cancel();
      await sleep(20);
    },
  };
  streams.add(stream);
  return stream;
}

// A message from somebody else, as it lands in the room's feed.
let sent = 0;
async function arrives() {
  sent++;
  await feeds.get(`chat-${ROOM}`).append({ id: `closed-tab-${sent}`, sender: BEN, sn: "Test Ben", ts: Date.now(), ...encryptMsg(`hello ${sent}`, ROOM) });
  await sleep(30);
}

describe("a chat left open in a tab", () => {
  let dir;

  before(async () => {
    dir = mkdtempSync(path.join(tmpdir(), "peerchat-closed-tab-"));
    writeFileSync(path.join(dir, "chat.json"), JSON.stringify({
      v: 1, profile: { username: "Test Ada", bio: "", at: 1000 }, peerProfiles: {}, pendingDMs: {},
      rooms: {
        [ROOM]: {
          roomKey: ROOM, name: "Test Room", isHost: true, bio: "", link: "", avatar: null,
          createdAt: Date.now() - 60_000, createdBy: "05050505", createdByName: "Test Ada",
          isPinned: false, isMuted: false, unreadCount: 0, unreadMentions: 0, lastMessage: null, members: {},
          lastReadTs: 1000,
        },
      },
    }));
    initChat(sdk, { storagePath: path.join(dir, "chat.json") });
    await sleep(200);
  });

  after(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });

  beforeEach(async () => {
    await call("set-active");
    await call("mark-read", ROOM);
  });

  afterEach(async () => {
    for (const stream of [...streams]) await stream.close();
  });

  it("takes what comes in as read while its page is there", async () => {
    const tab = await openStream(TAB_A);
    await call("set-active", ROOM, TAB_A);
    await arrives();
    assert.equal(await unread(), 0);
    await tab.close();
  });

  it("counts what comes in as unread once its tab is closed", async () => {
    const tab = await openStream(TAB_A);
    await call("set-active", ROOM, TAB_A);
    await sleep(10);
    const before = Date.now();
    await tab.close();
    await arrives();
    await arrives();
    assert.equal(await unread(), 2);
    const room = (await call("get-rooms")).rooms.find((one) => one.roomKey === ROOM);
    assert.ok(room.lastReadTs >= before, "read up to when the tab closed");
  });

  it("stays on screen while its page opens its stream again", async () => {
    const first = await openStream(TAB_A);
    await call("set-active", ROOM, TAB_A);
    const again = await openStream(TAB_A);
    await first.close();
    await arrives();
    assert.equal(await unread(), 0);
    await again.close();
    await arrives();
    assert.equal(await unread(), 1);
  });

  it("is not let go of by another tab hiding its own", async () => {
    const shown = await openStream(TAB_A);
    const hidden = await openStream(TAB_B);
    await call("set-active", ROOM, TAB_A);
    // The other tab goes behind, and says it shows nothing.
    await call("set-active", null, TAB_B);
    await hidden.close();
    await arrives();
    assert.equal(await unread(), 0);
    await call("set-active", null, TAB_A);
    await arrives();
    assert.equal(await unread(), 1);
    await shown.close();
  });

  // PeerSky Desktop finds out that a tab's page went only when it next writes
  // to it, so a page's stream gets a line the page never sees every two
  // seconds, where the heartbeat comes every fifteen.
  it("is written to often enough to find a closed tab within seconds", async () => {
    const res = await handleChatRequest({ url: `hyper://chat?action=receive-all&page=${TAB_A}`, method: "GET", json: async () => ({}) }, sdk);
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    const started = Date.now();
    let text = "";
    try {
      while (!/(^|\n):\n\n/.test(text) && Date.now() - started < 4000) {
        const { value } = await reader.read();
        text += decoder.decode(value);
      }
      assert.match(text, /(^|\n):\n\n/);
      assert.ok(Date.now() - started < 3000, "within three seconds");
    } finally {
      await reader.cancel();
    }
  });

  it("is sent with the page's id, and said again when the stream comes back", () => {
    const api = readFileSync(new URL("../chat-api.js", import.meta.url), "utf8");
    assert.match(api, /receiveAllUrl: \(\) => `\$\{chatUrl\("receive-all"\)\}&page=\$\{PAGE\}`,/);
    assert.match(api, /setActive: \(roomKey\) => apiRequest\("set-active", \{ roomKey, post: true, page: true \}\),/);
    const app = readFileSync(new URL("../app.js", import.meta.url), "utf8");
    const open = app.slice(app.indexOf("es.onopen = async () => {"), app.indexOf("es.onerror"));
    assert.match(open, /if \(S\.activeRoom && chatOnScreen\(\)\) await chat\.setActive\(S\.activeRoom\)\.catch\(\(\) => \{\}\);\n\s+refreshActiveRoom\(\);/);
  });
});
