// A desktop restored from another desktop starts with that desktop's chat
// file, under a network key of its own. The transfer left beside it gives it
// its label and the room keys the keychain here cannot open, and rooms made
// under the other key are no longer this desktop's to run.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";

import { CHAT_INCOMING, handleChatRequest, initChat } from "../p2p.js";
import { createLink, makeTransfer } from "../lib/device-link.js";

const ROOM = "aa".repeat(32);
const OTHER_KEY = "09".repeat(32);

const swarm = new EventEmitter();
swarm.flush = async () => {};
function fakeFeed() {
  const feed = new EventEmitter();
  feed.length = 0;
  feed.ready = async () => {};
  feed.get = async () => { throw new Error("empty"); };
  feed.append = async () => { feed.length++; };
  return feed;
}
const sdk = { publicKey: Buffer.alloc(32, 7), corestore: { get: () => fakeFeed() }, join() {}, swarm };

async function call(action, method) {
  const res = await handleChatRequest({ url: `hyper://chat?action=${action}`, method, json: async () => ({}) }, sdk);
  return JSON.parse(await res.text());
}

describe("a desktop restored from another desktop", () => {
  let dir;
  const link = createLink("desktop");

  before(async () => {
    dir = mkdtempSync(path.join(tmpdir(), "peerchat-restore-"));
    const storagePath = path.join(dir, "chat.json");
    writeFileSync(storagePath, JSON.stringify({
      v: 1, profile: { username: "ada", at: 1 }, peerProfiles: {}, pendingDMs: {},
      device: { label: "" }, link: { ...link, key: "not-openable-here" },
      rooms: {
        [ROOM]: {
          roomKey: "not-openable-here", name: "Room", isHost: true, creatorKey: OTHER_KEY,
          bio: "", link: "", createdAt: 1, createdBy: "09090909", createdByName: "ada",
          members: {},
        },
      },
    }));
    writeFileSync(path.join(dir, CHAT_INCOMING), JSON.stringify(makeTransfer({
      link, label: "desktop1", profile: { username: "ada", at: 1 },
      rooms: [{ roomKey: ROOM, name: "Room", creatorKey: OTHER_KEY }],
    })));
    initChat(sdk, { storagePath });
    await new Promise((r) => setTimeout(r, 200));
  });

  after(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("takes its label, the link and the room keys, and uses the transfer once", async () => {
    const me = await call("get-profile", "GET");
    assert.equal(me.device, "desktop1");
    assert.equal(me.displayName, "ada@desktop1");
    const room = (await call("get-rooms", "GET")).rooms.find((r) => r.name === "Room");
    assert.equal(room.roomKey, ROOM);
    assert.equal(existsSync(path.join(dir, CHAT_INCOMING)), false);
  });

  it("no longer runs a room made under the other desktop's key", async () => {
    const room = (await call("get-rooms", "GET")).rooms.find((r) => r.roomKey === ROOM);
    assert.equal(room.isHost, false);
  });
});
