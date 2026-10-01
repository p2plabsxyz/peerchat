// Blocking closes direct messages and nothing else. These pin both halves: the
// HTTP actions the UI drives, and the wire behaviour a blocked peer sees.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { createHash } from "node:crypto";

import { handleChatRequest, initChat, deriveTopic } from "../p2p.js";
import { attachChatTransport } from "../transport.js";
import { securePair, topicsFrame, wireRoom } from "./helpers.mjs";

const ROOM = "aa".repeat(32);
const DM_ROOM = "bb".repeat(32);
// A second key so the last case is a fresh request, not a re-open of DM_ROOM.
const DM_ROOM_2 = "cc".repeat(32);

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

async function request(action, method, body, roomKey) {
  const qs = `hyper://chat?action=${action}${roomKey ? `&roomKey=${roomKey}` : ""}`;
  const res = await handleChatRequest({ url: qs, method, json: async () => body ?? {} }, sdk);
  return { status: res.status, body: JSON.parse(await res.text()) };
}

const call = async (action, method, body, roomKey) => (await request(action, method, body, roomKey)).body;

const findRoom = async (roomKey) =>
  (await call("get-rooms", "GET")).rooms.find((room) => room.roomKey === roomKey);

describe("blocking a peer", () => {
  let dir, storagePath, pair, transport, peerId;
  const frames = [];
  const waiters = [];

  const onFrame = (frame) => {
    frames.push(frame);
    for (let i = waiters.length - 1; i >= 0; i--) {
      if (waiters[i].match(frame)) waiters.splice(i, 1)[0].resolve(frame);
    }
  };

  const nextFrame = (match, label, timeoutMs = 30_000) => {
    const hit = frames.find(match);
    if (hit) return Promise.resolve(hit);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timed out waiting for ${label}`)), timeoutMs);
      waiters.push({ match, resolve: (f) => { clearTimeout(timer); resolve(f); } });
    });
  };

  before(async () => {
    dir = mkdtempSync(path.join(tmpdir(), "peerchat-blocking-"));
    storagePath = path.join(dir, "chat.json");
    writeFileSync(storagePath, JSON.stringify({
      v: 1, profile: { username: "tester" }, peerProfiles: {}, pendingDMs: {},
      rooms: {
        [ROOM]: {
          roomKey: ROOM, name: "Room", isHost: true, bio: "", link: "", avatar: null,
          createdAt: Date.now(), createdBy: "07070707", createdByName: "me",
          isPinned: false, isMuted: false, unreadCount: 0, unreadMentions: 0,
          lastMessage: null, members: {},
        },
      },
    }));
    initChat(sdk, { storagePath });
    await new Promise((r) => setTimeout(r, 200));

    pair = await securePair();
    swarm.emit("connection", pair.serverStream, { topics: [deriveTopic(ROOM)] });

    let buffer = "";
    const opened = new Promise((r) => {
      transport = attachChatTransport(pair.clientStream, (raw) => {
        buffer += raw.toString();
        const lines = buffer.split("\n");
        buffer = lines.pop();
        for (const line of lines) {
          if (!line) continue;
          try { onFrame(JSON.parse(line)); } catch {}
        }
      }, { onopen: r });
    });
    await opened;
    // In the room they share, the way a peer holding its key gets in.
    transport.send(topicsFrame(pair.clientStream, [ROOM]));

    for (let i = 0; i < 100 && !peerId; i++) {
      const status = await call("net-status", "GET");
      if (status.peers[0]?.rooms.length) peerId = status.peers[0].id;
      if (!peerId) await new Promise((r) => setTimeout(r, 50));
    }
    assert.ok(peerId, "peer never activated");
  });

  after(async () => {
    try { transport?.close(); } catch {}
    await pair?.close();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  // Minted by join-dm rather than known up front, and shared by the tests
  // below the one that opens it.
  let ourDmRoom = "";

  it("refuses to block yourself", async () => {
    const me = await call("get-profile", "GET");
    const res = await request("block-peer", "POST", { peerId: me.id });
    assert.equal(res.status, 400);
    assert.match(res.body.error, /cannot block yourself/);
  });

  it("drops a request the blocked peer already had waiting", async () => {
    transport.send(JSON.stringify({
      type: "dm-invite", roomKey: DM_ROOM, fromId: peerId,
      fromUsername: "Blocked Bob", toId: (await call("get-profile", "GET")).id,
    }) + "\n");

    let pending = {};
    for (let i = 0; i < 100; i++) {
      pending = (await call("get-rooms", "GET")).pendingDMs || {};
      if (pending[DM_ROOM]) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.ok(pending[DM_ROOM], "invite never arrived");

    const blocked = await call("block-peer", "POST", { peerId, username: "Blocked Bob" });
    assert.equal(blocked.blockedPeers.length, 1);
    assert.equal(blocked.blockedPeers[0].username, "Blocked Bob");
    assert.deepEqual(blocked.pendingDMs, {});
  });

  it("tells the blocked peer instead of leaving the request hanging", async () => {
    frames.length = 0;
    transport.send(JSON.stringify({
      type: "dm-invite", roomKey: DM_ROOM, fromId: peerId,
      fromUsername: "Blocked Bob", toId: (await call("get-profile", "GET")).id,
    }) + "\n");

    const notice = await nextFrame((f) => f.type === "dm-blocked", "dm-blocked");
    // Named by topic like every room, not by the key they sent.
    assert.equal(notice.room, wireRoom(DM_ROOM));
    assert.equal(notice.roomKey, undefined);
    assert.deepEqual((await call("get-rooms", "GET")).pendingDMs, {});
  });

  it("refuses to open a direct message with a blocked peer", async () => {
    const res = await request("join-dm", "POST", { toId: peerId, toUsername: "Blocked Bob" });
    assert.equal(res.status, 403);
    assert.match(res.body.error, /Unblock/);
  });

  it("closes an already accepted conversation both ways", async () => {
    // Open the direct room first, the way it would exist before a block.
    await call("unblock-peer", "POST", { peerId });
    const opened = await request("join-dm", "POST", { toId: peerId, toUsername: "Blocked Bob" });
    assert.equal(opened.status, 200);
    ourDmRoom = opened.body.roomKey;

    // Minted here, not computed from the two peer ids. Both of those are
    // public, so a derived key was one anybody who knew them could work out,
    // join the topic with, and read the conversation and its media.
    assert.match(ourDmRoom, /^[a-f0-9]{64}$/);
    assert.notEqual(ourDmRoom, DM_ROOM);
    const me = (await call("get-profile", "GET")).id;
    const derivable = createHash("sha256").update([me, peerId].sort().join(":dm:")).digest("hex");
    assert.notEqual(ourDmRoom, derivable);

    const before = await request("send", "POST", { message: "before the block" }, ourDmRoom);
    assert.equal(before.status, 200);

    await call("block-peer", "POST", { peerId, username: "Blocked Bob" });
    const after = await request("send", "POST", { message: "after the block" }, ourDmRoom);
    assert.equal(after.status, 403);
    assert.match(after.body.error, /Unblock/);
  });

  it("lets the blocked sender ask again, so an unblock can reach them", async () => {
    await call("unblock-peer", "POST", { peerId });

    // This is what our side looks like after they block us.
    transport.send(JSON.stringify({ type: "dm-blocked", room: wireRoom(ourDmRoom), fromId: peerId }) + "\n");
    let room;
    for (let i = 0; i < 100; i++) {
      room = await findRoom(ourDmRoom);
      if (room?.blockedByPeer) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.equal(room?.blockedByPeer, true, "dm-blocked never landed");

    // Without this an unblock on their side could never reach us again.
    const retry = await request("join-dm", "POST", { toId: peerId, toUsername: "Blocked Bob" });
    assert.equal(retry.status, 200);
    // The same conversation, not a second one beside it.
    assert.equal(retry.body.roomKey, ourDmRoom);
    const reopened = await findRoom(ourDmRoom);
    assert.equal(reopened.blockedByPeer, false, "asking again clears it");
    assert.equal(reopened.pendingAcceptance, true, "and the request goes back out");

    await call("block-peer", "POST", { peerId, username: "Blocked Bob" });
  });

  it("leaves the shared room alone", async () => {
    const status = await call("net-status", "GET");
    assert.deepEqual(status.peers[0].rooms, [ROOM], "the peer is still in the room we share");
  });

  it("reports the block list on both read endpoints and on disk", async () => {
    assert.equal((await call("get-profile", "GET")).blockedPeers.length, 1);
    assert.equal((await call("get-rooms", "GET")).blockedPeers.length, 1);
    const onDisk = JSON.parse(readFileSync(storagePath, "utf8"));
    assert.equal(onDisk.blockedPeers[peerId].username, "Blocked Bob");
  });

  it("unblocks once, then reports there is nothing to unblock", async () => {
    const unblocked = await call("unblock-peer", "POST", { peerId });
    assert.deepEqual(unblocked.blockedPeers, []);
    const again = await request("unblock-peer", "POST", { peerId });
    assert.equal(again.status, 404);
    assert.match(again.body.error, /not blocked/);
  });

  it("accepts a request again after the unblock", async () => {
    frames.length = 0;
    transport.send(JSON.stringify({
      type: "dm-invite", roomKey: DM_ROOM_2, fromId: peerId,
      fromUsername: "Blocked Bob", toId: (await call("get-profile", "GET")).id,
    }) + "\n");

    await new Promise((r) => setTimeout(r, 300));
    // The unblock took effect, so no refusal goes back.
    assert.equal(frames.some((f) => f.type === "dm-blocked"), false);

    // We already had a conversation open with them, so there are two keys for
    // one conversation. Keys are random, so the lower one is an answer both
    // sides reach alone, and whoever holds the other gives it up.
    const rooms = await call("get-rooms", "GET");
    const mine = rooms.rooms.filter((room) => room.isDM && room.dmWith === peerId);
    const waiting = Object.values(rooms.pendingDMs || {}).filter((dm) => dm.fromId === peerId);
    assert.equal(mine.length + waiting.length, 1, "one conversation with them, not two");
    assert.equal(
      mine[0]?.roomKey || waiting[0]?.roomKey,
      DM_ROOM_2 < ourDmRoom ? DM_ROOM_2 : ourDmRoom,
    );
  });
});
