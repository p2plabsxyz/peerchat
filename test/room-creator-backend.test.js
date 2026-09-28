import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { initChat, handleChatRequest } from "../p2p.js";

/**
 * The backend answering the page, driven for real.
 *
 * The source assertions next door say the wiring is there. These say what the
 * renderer is actually handed, because that is what decides whether a Remove
 * button is drawn at all: the member list comes from get-rooms, and nothing on
 * screen can tell you made a room unless that says so.
 */
const CREATOR_KEY = "a1".repeat(32);
const JOINED_ROOM = "b2".repeat(32);
const LEGACY_ROOM = "c3".repeat(32);

// Nothing here reaches the network, so a stub holds the surface initChat wires
// itself to. The feed is real enough to append to and read back, which is what
// a removal notice has to survive.
class FakeFeed extends EventEmitter {
  entries = [];
  get length() { return this.entries.length; }
  async ready() {}
  async get(index) { return this.entries[index]; }
  async append(entry) { this.entries.push(entry); this.emit("append"); }
}

const feeds = new Map();
const sdk = {
  publicKey: Buffer.from(CREATOR_KEY, "hex"),
  swarm: Object.assign(new EventEmitter(), { flush: async () => {} }),
  localSwarm: null,
  join() {},
  leave() {},
  corestore: {
    get({ name }) {
      if (!feeds.has(name)) feeds.set(name, new FakeFeed());
      return feeds.get(name);
    },
  },
};

// Some actions read the room key from the query string and some from the body,
// so both go out, the way chat-api.js sends them.
const api = async (action, body = {}) =>
  handleChatRequest(
    new Request(
      `hyper://chat?action=${action}${body.roomKey ? `&roomKey=${body.roomKey}` : ""}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      },
    ),
    sdk,
  ).then((res) => res.json().then((data) => ({ status: res.status, data })));

const rooms = async () =>
  handleChatRequest(new Request("hyper://chat?action=get-rooms"), sdk).then((res) => res.json());

const roomNamed = async (roomKey) =>
  (await rooms()).rooms.find((room) => room.roomKey === roomKey);

const history = async (roomKey) =>
  handleChatRequest(new Request(`hyper://chat?action=get-history&roomKey=${roomKey}`), sdk)
    .then((res) => res.json());

describe("what the renderer is told about a room's creator", () => {
  before(() => {
    const path = join(mkdtempSync(join(tmpdir(), "peerchat-")), "rooms.json");
    writeFileSync(path, JSON.stringify({
      profile: { username: "Creator" },
      rooms: {
        // Somebody else's room, joined.
        [JOINED_ROOM]: { roomKey: JOINED_ROOM, isHost: false, creatorKey: "", members: {} },
        // A room made here before creator keys existed, so it has none on
        // record. The device that made it is the only one that can fill it in.
        [LEGACY_ROOM]: { roomKey: LEGACY_ROOM, isHost: true, members: {} },
      },
    }), "utf8");
    initChat(sdk, { storagePath: path });
  });

  it("says you made the room you made", async () => {
    const { data } = await api("create-key", { name: "Mine" });
    const mine = await roomNamed(data.roomKey);

    // Without this the button is never drawn, whatever the backend allows.
    assert.equal(mine.isCreator, true);
    assert.deepEqual(mine.bans, []);
  });

  it("says you did not make a room you joined", async () => {
    const joined = await roomNamed(JOINED_ROOM);

    assert.equal(joined.isHost, false);
    // Learned from the creator when they announce it, never assumed. Assuming
    // it would have had everyone who joined a room believe they made it.
    assert.equal(joined.isCreator, false);
  });

  it("fills in a creator key for a room made here before there were any", async () => {
    const legacy = await roomNamed(LEGACY_ROOM);

    assert.equal(legacy.isCreator, true);
  });

  it("removes somebody, keeps them removed, and lets them back", async () => {
    const { data } = await api("create-key", { name: "Mine" });
    const roomKey = data.roomKey;

    const removed = await api("remove-room-member", { roomKey, peerId: "deadbeef" });
    assert.equal(removed.status, 200);
    assert.deepEqual(removed.data.bans.map((ban) => ban.id), ["deadbeef"]);

    // The ban rides along with the room, which is what the member list filters
    // on. Held only in memory it came straight back with the next member list
    // somebody relayed.
    assert.deepEqual((await roomNamed(roomKey)).bans.map((ban) => ban.id), ["deadbeef"]);

    await api("restore-room-member", { roomKey, peerId: "deadbeef" });
    assert.deepEqual((await roomNamed(roomKey)).bans, []);
  });

  it("says it out loud in the room, so a removal is not silent", async () => {
    const { data } = await api("create-key", { name: "Mine" });
    const roomKey = data.roomKey;
    await api("join", { roomKey });

    await api("remove-room-member", { roomKey, peerId: "deadbeef" });

    const { messages } = await history(roomKey);
    const notice = messages.find((message) => message.moderationNotice);
    assert.ok(notice, "the room has to show what happened");
    assert.match(notice.text ?? notice.message, /was removed from the room by its creator/);
  });

  it("refuses a removal that is not the creator's, and refuses removing yourself", async () => {
    const { data } = await api("create-key", { name: "Mine" });

    const self = await api("remove-room-member", {
      roomKey: data.roomKey,
      peerId: CREATOR_KEY.slice(0, 8),
    });
    assert.equal(self.status, 400);
    assert.match(self.data.error, /cannot remove yourself/);

    const refused = await api("remove-room-member", { roomKey: JOINED_ROOM, peerId: "deadbeef" });
    assert.equal(refused.status, 403);
    assert.match(refused.data.error, /Only the person who made this room/);
  });
});
