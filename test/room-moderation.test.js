// The moderation.js unit tests cover the filter logic. These cover the wiring
// between a room's stored settings and the filters, which is where a room can
// end up with no settings at all and silently fall back to everything enabled.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { handleChatRequest, initChat } from "../p2p.js";

const ROOM_KEY = "aa".repeat(32);

// Minimal SDK. Feed-backed actions are out of scope here; room bookkeeping and
// the settings that feed the filters do not need a live corestore.
const sdk = {
  publicKey: Buffer.alloc(32, 7),
  corestore: { get() { throw new Error("no feed in tests"); } },
  join() {},
  swarm: { on() {}, flush: async () => {} },
};

let dir;

function roomFileWithoutModeration() {
  const room = {
    roomKey: ROOM_KEY,
    isHost: true,
    name: "Room From An Older Build",
    bio: "",
    link: "",
    avatar: null,
    createdAt: Date.now(),
    createdBy: "07070707",
    createdByName: "me",
    isPinned: false,
    isMuted: false,
    unreadCount: 0,
    unreadMentions: 0,
    lastMessage: null,
    members: {},
  };
  return {
    v: 1,
    profile: {},
    peerProfiles: {},
    pendingDMs: {},
    rooms: { [ROOM_KEY]: room },
  };
}

async function call(action, method, body, roomKey) {
  const qs = `hyper://chat?action=${action}${roomKey ? `&roomKey=${roomKey}` : ""}`;
  const res = await handleChatRequest(
    { url: qs, method, json: async () => body ?? {} },
    sdk
  );
  return JSON.parse(await res.text());
}

const getRoom = async (roomKey) =>
  (await call("get-rooms", "GET")).rooms.find((r) => r.roomKey === roomKey);

describe("room moderation settings", () => {
  before(() => {
    dir = mkdtempSync(path.join(tmpdir(), "peerchat-mod-"));
    writeFileSync(
      path.join(dir, "chat.json"),
      JSON.stringify(roomFileWithoutModeration())
    );
    initChat(sdk, { storagePath: path.join(dir, "chat.json") });
  });

  after(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  // Regression: a room saved before configurable moderation existed had no
  // settings field. It reported null, the UI rendered that as "Default
  // settings", and every filter read the absence as "not disabled" and stayed
  // on, so the room looked unconfigured and unconfigurable at once.
  it("backfills settings for a room saved before the feature existed", async () => {
    const room = await getRoom(ROOM_KEY);

    assert.ok(room, "the pre-existing room should still load");
    assert.notEqual(room.moderation, null, "settings must not come back null");
    assert.deepEqual(room.moderation, {
      abuseFilter: true,
      nsfwFilter: true,
      spamRateLimit: 10,
    });
  });

  it("keeps filters off on a new room created with both toggles off", async () => {
    const { roomKey } = await call("create-key", "POST", {
      name: "Filters Off",
      moderation: { abuseFilter: false, nsfwFilter: false, spamRateLimit: 10 },
    });

    const room = await getRoom(roomKey);
    assert.equal(room.moderation.abuseFilter, false);
    assert.equal(room.moderation.nsfwFilter, false);
  });

  it("defaults a new room to filters on when the client sends nothing", async () => {
    const { roomKey } = await call("create-key", "POST", { name: "No Settings" });

    const room = await getRoom(roomKey);
    assert.deepEqual(room.moderation, {
      abuseFilter: true,
      nsfwFilter: true,
      spamRateLimit: 10,
    });
  });

  it("clamps an out-of-range spam limit instead of storing it raw", async () => {
    const { roomKey } = await call("create-key", "POST", {
      name: "Silly Limit",
      moderation: { spamRateLimit: 9999 },
    });

    const room = await getRoom(roomKey);
    assert.equal(room.moderation.spamRateLimit, 50);
  });

  it("never reports null settings for any room", async () => {
    const { rooms } = await call("get-rooms", "GET");

    assert.ok(rooms.length > 1, "expected several rooms from earlier cases");
    for (const room of rooms) {
      assert.notEqual(
        room.moderation,
        null,
        `${room.name} came back with null settings`
      );
    }
  });
});
