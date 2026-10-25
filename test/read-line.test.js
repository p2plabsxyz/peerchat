// The New Messages line went above messages already read: a chat's read time
// moved only when the chat was opened, so everything that arrived while it was
// on screen, your own messages too, counted as new the next time. And a chat
// left open in a hidden or closed tab took its messages as read, with nobody
// looking.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";

import { handleChatRequest, initChat } from "../p2p.js";

const ROOM = "c3".repeat(32);
const OTHER = "c4".repeat(32);
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

async function call(action, method, body, roomKey) {
  const qs = `hyper://chat?action=${action}${roomKey ? `&roomKey=${roomKey}` : ""}`;
  const res = await handleChatRequest({ url: qs, method, json: async () => body ?? {} }, sdk);
  return JSON.parse(await res.text());
}
const findRoom = async (roomKey) => (await call("get-rooms", "GET")).rooms.find((room) => room.roomKey === roomKey);

function room(roomKey, name) {
  return {
    roomKey, name, isHost: true, bio: "", link: "", avatar: null,
    createdAt: Date.now() - 60_000, createdBy: "05050505", createdByName: "Test Ada",
    isPinned: false, isMuted: false, unreadCount: 0, unreadMentions: 0, lastMessage: null, members: {},
    lastReadTs: 1000,
  };
}

describe("the New Messages line", () => {
  let dir;

  before(async () => {
    dir = mkdtempSync(path.join(tmpdir(), "peerchat-read-line-"));
    writeFileSync(path.join(dir, "chat.json"), JSON.stringify({
      v: 1, profile: { username: "Test Ada", bio: "", at: 1000 }, peerProfiles: {}, pendingDMs: {},
      rooms: { [ROOM]: room(ROOM, "Test Room"), [OTHER]: room(OTHER, "Test Other") },
    }));
    initChat(sdk, { storagePath: path.join(dir, "chat.json") });
    await sleep(200);
  });

  after(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });

  it("goes after what was on screen when a chat is left for another", async () => {
    await call("set-active", "POST", {}, ROOM);
    await call("mark-read", "POST", {}, ROOM);
    const opened = (await findRoom(ROOM)).lastReadTs;
    await sleep(30);
    const before = Date.now();
    await call("set-active", "POST", {}, OTHER);
    const left = (await findRoom(ROOM)).lastReadTs;
    assert.ok(left > opened && left >= before, "read up to when it was left");
  });

  it("goes after what was on screen when the tab is hidden or closed", async () => {
    await sleep(30);
    const before = Date.now();
    await call("set-active", "POST", {});
    assert.ok((await findRoom(OTHER)).lastReadTs >= before);
  });

  it("is driven by whether the chat is on screen", () => {
    const app = readFileSync(new URL("../app.js", import.meta.url), "utf8");
    assert.match(app, /\} else if \(S\.activeRoom\) \{\s+chat\.setActive\(null\)\.catch\(\(\) => \{\}\);/);
    assert.match(app, /chat\.setActive\(roomKey\)\.then\(\(\) => chat\.markRead\(roomKey\)\)/);
    assert.match(app, /if \(rk !== S\.activeRoom \|\| document\.visibilityState !== "visible"\) \{/);
  });
});
