// A desktop restored from another desktop has a copy of its store, so a feed
// opened by the same name is the same hypercore. Writing it from both would
// fork it and hypercore would freeze it. A device whose network key is not its
// store's own keeps its feeds under that key, starting from the copy.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";

import { handleChatRequest, initChat } from "../p2p.js";

const ROOM = "aa".repeat(32);
const OWN_KEY = Buffer.alloc(32, 3);

function fakeFeed(entries = []) {
  const feed = new EventEmitter();
  feed.entries = entries;
  Object.defineProperty(feed, "length", { get: () => feed.entries.length });
  feed.ready = async () => {};
  feed.get = async (i) => structuredClone(feed.entries[i]);
  feed.append = async (entry) => { feed.entries.push(structuredClone(entry)); feed.emit("append"); };
  feed.close = async () => {};
  return feed;
}

function fakeSdk({ networkKey, feeds }) {
  const swarm = new EventEmitter();
  swarm.flush = async () => {};
  return {
    publicKey: networkKey,
    swarm,
    join() {},
    corestore: {
      createKeyPair: async () => ({ publicKey: OWN_KEY, secretKey: Buffer.alloc(64) }),
      get: ({ name }) => {
        if (!feeds.has(name)) feeds.set(name, fakeFeed());
        return feeds.get(name);
      },
    },
  };
}

describe("room feeds on a desktop with a network key of its own", () => {
  let dir;
  const feeds = new Map();
  const networkKey = Buffer.alloc(32, 9);
  const copiedName = `chat-${ROOM}`;
  const ownName = `chat-${ROOM}-${networkKey.toString("hex").slice(0, 16)}`;

  before(async () => {
    dir = mkdtempSync(path.join(tmpdir(), "peerchat-feeds-"));
    const storagePath = path.join(dir, "chat.json");
    writeFileSync(storagePath, JSON.stringify({
      v: 1, profile: { username: "ada", at: 1 }, peerProfiles: {}, pendingDMs: {},
      device: { label: "desktop1" },
      rooms: { [ROOM]: { roomKey: ROOM, name: "Room", isHost: false, createdAt: 1, createdBy: "03030303", members: {} } },
    }));
    // What the other desktop had written before the copy.
    feeds.set(copiedName, fakeFeed([{ id: "m1", type: "system", text: "ada joined", ts: 5 }]));
    initChat(fakeSdk({ networkKey, feeds }), { storagePath });
    await new Promise((r) => setTimeout(r, 300));
  });

  after(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("starts its own feed from what the copied one held", () => {
    assert.deepEqual(feeds.get(ownName).entries.map((entry) => entry.id), ["m1"]);
  });

  it("writes only its own feed", async () => {
    const res = await handleChatRequest({
      url: `hyper://chat?action=send&roomKey=${ROOM}`,
      method: "POST",
      json: async () => ({ message: "hello from desktop1" }),
    }, null);
    assert.equal(res.status, 200);
    assert.equal(feeds.get(copiedName).entries.length, 1);
    assert.ok(feeds.get(ownName).entries.length > 1);
  });
});
