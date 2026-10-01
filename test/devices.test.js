// One person on two devices, over a real connection: the name this device
// sends, a rename taken from the person's other device and from nobody else,
// and a transfer taken from a phone.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";

import { deriveTopic, exportChatTransfer, handleChatRequest, importChatTransfer, initChat } from "../p2p.js";
import { attachChatTransport } from "../transport.js";
import { createLink, linkId, makeProfileProof, makeTransfer, checkProfileProof } from "../lib/device-link.js";
import { securePair, topicsFrame, wireRoom } from "./helpers.mjs";

const ROOM = "aa".repeat(32);
const PHONE_ROOM = "cc".repeat(32);
const PHONE_DM = "dd".repeat(32);
const SHARED_ROOM = "ee".repeat(32);
const STRANGER_ROOM = "ab".repeat(32);
const JOINED_HERE = "bc".repeat(32);
// What fake SDK below connects as, and so what its proofs are made with.
const DESKTOP_KEY = "07".repeat(32);

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
const joined = [];
const sdk = {
  publicKey: Buffer.alloc(32, 7),
  corestore: { get: () => fakeFeed() },
  join(topic) { joined.push(topic.toString("hex")); },
  swarm,
};

async function call(action, method, body, roomKey) {
  const qs = `hyper://chat?action=${action}${roomKey ? `&roomKey=${roomKey}` : ""}`;
  const res = await handleChatRequest({ url: qs, method, json: async () => body ?? {} }, sdk);
  return JSON.parse(await res.text());
}

async function eventually(check, label) {
  for (let i = 0; i < 100; i++) {
    const value = await check();
    if (value) return value;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`timed out waiting for ${label}`);
}

describe("one person on two devices", () => {
  let dir, storagePath, pair, transport, link, phoneKey, strangerPair, strangerTransport;
  const frames = [];

  before(async () => {
    dir = mkdtempSync(path.join(tmpdir(), "peerchat-devices-"));
    storagePath = path.join(dir, "chat.json");
    writeFileSync(storagePath, JSON.stringify({
      v: 1, profile: { username: "ada", bio: "", at: 1000 }, peerProfiles: {}, pendingDMs: {},
      rooms: {
        [ROOM]: {
          roomKey: ROOM, name: "Room", isHost: true, bio: "", link: "", avatar: null,
          createdAt: Date.now(), createdBy: "07070707", createdByName: "ada",
          isPinned: false, isMuted: false, unreadCount: 0, unreadMentions: 0,
          lastMessage: null, members: {},
        },
      },
    }));
    initChat(sdk, { storagePath });
    await new Promise((r) => setTimeout(r, 200));
  });

  after(async () => {
    try { transport?.close(); } catch {}
    try { strangerTransport?.close(); } catch {}
    await pair?.close();
    await strangerPair?.close();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("makes the link on the first transfer, and gives the phone its label and every room", () => {
    const transfer = exportChatTransfer({ targetType: "mobile" });
    link = transfer.link;
    assert.match(link.key, /^[0-9a-f]{64}$/);
    assert.equal(link.origin, "desktop");
    assert.equal(transfer.label, "mobile");
    assert.equal(transfer.profile.username, "ada");
    assert.deepEqual(transfer.rooms.map((room) => room.roomKey), [ROOM]);
    assert.equal(transfer.rooms[0].creatorKey, "07".repeat(32));
    // Kept, so the next transfer uses the same link, and each desktop gets a
    // label of its own even before the first one is heard from.
    const first = exportChatTransfer({ targetType: "desktop" });
    assert.equal(first.link.key, link.key);
    assert.equal(first.label, "desktop1");
    assert.equal(exportChatTransfer({ targetType: "desktop" }).label, "desktop2");
    assert.equal(exportChatTransfer({ targetType: "mobile" }).label, "mobile");
    const saved = JSON.parse(readFileSync(storagePath, "utf8")).link;
    assert.deepEqual(saved.labels, ["desktop1", "desktop2", "mobile"]);
  });

  it("sends its name without a label, with a proof the phone can check", async () => {
    pair = await securePair();
    // The phone's side of the connection, which its proofs have to be made with.
    phoneKey = pair.clientStream.publicKey.toString("hex");
    swarm.emit("connection", pair.serverStream, { topics: [deriveTopic(ROOM)] });
    let buffer = "";
    await new Promise((opened) => {
      transport = attachChatTransport(pair.clientStream, (raw) => {
        buffer += raw.toString();
        const lines = buffer.split("\n");
        buffer = lines.pop();
        for (const line of lines) {
          if (!line) continue;
          try { frames.push(JSON.parse(line)); } catch {}
        }
      }, { onopen: opened });
    });
    // The other side proves which rooms it shares, as a peer does.
    transport.send(topicsFrame(pair.clientStream, [ROOM]));

    const profile = await eventually(() => frames.find((f) => f.type === "profile"), "a profile");
    assert.equal(profile.username, "ada");
    assert.equal(profile.device, "");
    assert.equal(profile.link.id, linkId(link));
    assert.equal(checkProfileProof(link, profile.link, profile.avatar, DESKTOP_KEY), true);
    assert.equal(checkProfileProof(link, profile.link, profile.avatar, phoneKey), false);
  });

  it("takes a newer name from the phone, and tells its peers", async () => {
    frames.length = 0;
    const at = Date.now();
    transport.send(JSON.stringify({
      type: "profile", peerId: "0b0b0b0b", username: "adele@mobile", bio: "new bio", avatar: null, rooms: [wireRoom(ROOM)],
      device: "mobile", link: makeProfileProof(link, { username: "adele", bio: "new bio", avatar: null, at }, phoneKey),
    }) + "\n");

    const me = await eventually(async () => {
      const p = await call("get-profile", "GET");
      return p.username === "adele" ? p : null;
    }, "the rename");
    assert.equal(me.displayName, "adele");
    assert.equal(me.bio, "new bio");
    const resent = await eventually(() => frames.find((f) => f.type === "profile" && f.username === "adele"), "the new name sent on");
    assert.equal(resent.link.at, at);
  });

  it("ignores a rename from anyone without the link, and an older one from the phone", async () => {
    transport.send(JSON.stringify({
      type: "profile", peerId: "0b0b0b0b", username: "mallory", bio: "", avatar: null, rooms: [wireRoom(ROOM)],
      link: makeProfileProof(createLink("desktop"), { username: "mallory", bio: "", avatar: null, at: Date.now() + 60_000 }, phoneKey),
    }) + "\n");
    transport.send(JSON.stringify({
      type: "profile", peerId: "0b0b0b0b", username: "ada@mobile", bio: "", avatar: null, rooms: [wireRoom(ROOM)],
      link: makeProfileProof(link, { username: "ada", bio: "", avatar: null, at: 5 }, phoneKey),
    }) + "\n");
    await new Promise((r) => setTimeout(r, 400));
    assert.equal((await call("get-profile", "GET")).username, "adele");
  });

  it("sends the phone the room's history since the person joined, not since it connected", async () => {
    const phoneId = phoneKey.slice(0, 8);
    const joinedAt = async () => (await call("get-rooms", "GET")).rooms.find((r) => r.roomKey === ROOM).members?.[phoneId]?.joinedAt;
    // A profile says who someone is, never when they joined.
    assert.equal(await joinedAt(), undefined);
    // Its join as it connected, then the person's own earlier one, which a
    // proven device of theirs is believed about.
    const now = Date.now();
    transport.send(JSON.stringify({ type: "join", room: wireRoom(ROOM), peerId: "0b0b0b0b", username: "adele@mobile", ts: now, id: "join-0" }) + "\n");
    await eventually(async () => (await joinedAt()) === now, "the join as it connected");
    transport.send(JSON.stringify({ type: "join", room: wireRoom(ROOM), peerId: "0b0b0b0b", username: "adele@mobile", ts: 1000, id: "join-1" }) + "\n");
    await eventually(async () => (await joinedAt()) === 1000, "the earlier join time");
  });

  it("sends its profile on a connection it accepted, once a shared room is named", async () => {
    // Accepted connections name no rooms at first, so this is where the proof
    // goes out to the person's other device.
    const accepted = await securePair();
    const seen = [];
    let buf = "";
    let acceptedTransport;
    try {
      swarm.emit("connection", accepted.serverStream, { topics: [] });
      await new Promise((opened) => {
        acceptedTransport = attachChatTransport(accepted.clientStream, (raw) => {
          buf += raw.toString();
          const lines = buf.split("\n");
          buf = lines.pop();
          for (const line of lines) {
            if (!line) continue;
            try { seen.push(JSON.parse(line)); } catch {}
          }
        }, { onopen: opened });
      });
      // Only once the desktop has set the connection up, which it says with
      // its own topics, so the rooms are learned afterwards.
      await eventually(() => seen.find((f) => f.type === "topics"), "the desktop's topics");
      assert.equal(seen.some((f) => f.type === "profile"), false);
      acceptedTransport.send(topicsFrame(accepted.clientStream, [ROOM]));
      const profile = await eventually(() => seen.find((f) => f.type === "profile"), "a profile");
      assert.equal(checkProfileProof(link, profile.link, profile.avatar, DESKTOP_KEY), true);
    } finally {
      try { acceptedTransport?.close(); } catch {}
      await accepted.close();
    }
  });

  it("ignores a newer name in a proof made by another device and passed on", async () => {
    transport.send(JSON.stringify({
      type: "profile", peerId: "0b0b0b0b", username: "eve", bio: "", avatar: null, rooms: [wireRoom(ROOM)],
      link: makeProfileProof(link, { username: "eve", bio: "", avatar: null, at: Date.now() + 60_000 }, "0b".repeat(32)),
    }) + "\n");
    await new Promise((r) => setTimeout(r, 400));
    assert.equal((await call("get-profile", "GET")).username, "adele");
  });

  it("sends its rooms, with their keys, once the phone proved it is the person's", async () => {
    const offered = await eventually(() => frames.find((f) => f.type === "link-rooms"), "the rooms");
    const room = offered.rooms.find((entry) => entry.roomKey === ROOM);
    assert.ok(room);
    assert.equal(room.creatorKey, DESKTOP_KEY);
  });

  it("takes rooms from the phone and joins them", async () => {
    transport.send(JSON.stringify({ type: "link-rooms", rooms: [{ roomKey: SHARED_ROOM, name: "Shared", createdAt: 10, joinedAt: 20 }] }) + "\n");
    const room = await eventually(async () => (await call("get-rooms", "GET")).rooms.find((r) => r.roomKey === SHARED_ROOM), "the shared room");
    assert.equal(room.name, "Shared");
    assert.equal(room.isHost, false);
    assert.ok(joined.includes(deriveTopic(SHARED_ROOM).toString("hex")));
  });

  it("does not take back a room left here", async () => {
    const res = await handleChatRequest({ url: `hyper://chat?action=delete-room&roomKey=${SHARED_ROOM}`, method: "POST", json: async () => ({}) }, sdk);
    assert.equal(res.status, 200);
    transport.send(JSON.stringify({ type: "link-rooms", rooms: [{ roomKey: SHARED_ROOM, name: "Shared" }] }) + "\n");
    await new Promise((r) => setTimeout(r, 400));
    assert.equal((await call("get-rooms", "GET")).rooms.some((r) => r.roomKey === SHARED_ROOM), false);
    assert.ok(JSON.parse(readFileSync(storagePath, "utf8")).leftRooms[SHARED_ROOM] > 0);
  });

  it("sends a room joined here to the phone", async () => {
    // Not awaited: a new room waits for its name from peers for a while.
    handleChatRequest({ url: `hyper://chat?action=join&roomKey=${JOINED_HERE}`, method: "POST", json: async () => ({}) }, sdk).catch(() => {});
    const offered = await eventually(() => frames.find((f) => f.type === "link-rooms" && f.rooms.some((r) => r.roomKey === JOINED_HERE)), "the joined room");
    assert.equal(offered.rooms.length, 1);
  });

  it("takes no rooms from a connection that has not proved it is the person's, even replaying a proof", async () => {
    strangerPair = await securePair();
    swarm.emit("connection", strangerPair.serverStream, { topics: [deriveTopic(ROOM)] });
    await new Promise((opened) => {
      strangerTransport = attachChatTransport(strangerPair.clientStream, () => {}, { onopen: opened });
    });
    strangerTransport.send(topicsFrame(strangerPair.clientStream, [ROOM]));
    // The phone's own proof, seen in a shared room and passed on.
    strangerTransport.send(JSON.stringify({
      type: "profile", peerId: "0c0c0c0c", username: "adele@mobile", bio: "", avatar: null, rooms: [wireRoom(ROOM)],
      link: makeProfileProof(link, { username: "adele", bio: "new bio", avatar: null, at: Date.now() }, phoneKey),
    }) + "\n");
    strangerTransport.send(JSON.stringify({ type: "link-rooms", rooms: [{ roomKey: STRANGER_ROOM, name: "Not yours" }] }) + "\n");
    await new Promise((r) => setTimeout(r, 600));
    assert.equal((await call("get-rooms", "GET")).rooms.some((r) => r.roomKey === STRANGER_ROOM), false);
  });

  it("takes a phone's transfer: the phone's name with this desktop's label, and its rooms", async () => {
    const phoneLink = createLink("mobile");
    const result = await importChatTransfer(makeTransfer({
      link: phoneLink,
      label: "desktop",
      profile: { username: "phone person", bio: "", avatar: null, at: 10 },
      rooms: [
        { roomKey: PHONE_ROOM, name: "Phone room", isDM: false },
        { roomKey: PHONE_DM, name: "Ann", isDM: true, dmWith: "0a0b0c0d" },
        { roomKey: ROOM, name: "Room", isDM: false },
      ],
    }));
    assert.deepEqual(result, { ok: true, added: 2, label: "desktop" });
    const me = await call("get-profile", "GET");
    assert.equal(me.username, "phone person");
    assert.equal(me.device, "desktop");
    assert.equal(me.displayName, "phone person@desktop");
    const rooms = (await call("get-rooms", "GET")).rooms;
    assert.ok(rooms.find((room) => room.roomKey === PHONE_ROOM && !room.isDM));
    assert.ok(rooms.find((room) => room.roomKey === PHONE_DM && room.isDM && room.dmWith === "0a0b0c0d"));
    assert.ok(joined.includes(deriveTopic(PHONE_ROOM).toString("hex")));
    const saved = JSON.parse(readFileSync(storagePath, "utf8"));
    assert.equal(saved.device.label, "desktop");
    assert.equal(saved.link.key, phoneLink.key);
  });

  it("keeps its own label when a device on the same link sends again", async () => {
    const phoneLink = JSON.parse(readFileSync(storagePath, "utf8")).link;
    const result = await importChatTransfer(makeTransfer({ link: phoneLink, label: "desktop2", profile: { username: "phone person", at: 11 }, rooms: [] }));
    assert.equal(result.label, "desktop");
  });
});
