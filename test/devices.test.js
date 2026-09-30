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
import { securePair } from "./helpers.mjs";

const ROOM = "aa".repeat(32);
const PHONE_ROOM = "cc".repeat(32);
const PHONE_DM = "dd".repeat(32);

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
  let dir, storagePath, pair, transport, link;
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
    await pair?.close();
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
    // The other side says which rooms it shares, as a peer does.
    transport.send(JSON.stringify({ type: "topics", topics: [deriveTopic(ROOM).toString("hex")] }) + "\n");

    const profile = await eventually(() => frames.find((f) => f.type === "profile"), "a profile");
    assert.equal(profile.username, "ada");
    assert.equal(profile.device, "");
    assert.equal(profile.link.id, linkId(link));
    assert.equal(checkProfileProof(link, profile.link, profile.avatar), true);
  });

  it("takes a newer name from the phone, and tells its peers", async () => {
    frames.length = 0;
    const at = Date.now();
    transport.send(JSON.stringify({
      type: "profile", peerId: "0b0b0b0b", username: "adele@mobile", bio: "new bio", avatar: null, rooms: [ROOM],
      device: "mobile", link: makeProfileProof(link, { username: "adele", bio: "new bio", avatar: null, at }),
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
      type: "profile", peerId: "0b0b0b0b", username: "mallory", bio: "", avatar: null, rooms: [ROOM],
      link: makeProfileProof(createLink("desktop"), { username: "mallory", bio: "", avatar: null, at: Date.now() + 60_000 }),
    }) + "\n");
    transport.send(JSON.stringify({
      type: "profile", peerId: "0b0b0b0b", username: "ada@mobile", bio: "", avatar: null, rooms: [ROOM],
      link: makeProfileProof(link, { username: "ada", bio: "", avatar: null, at: 5 }),
    }) + "\n");
    await new Promise((r) => setTimeout(r, 400));
    assert.equal((await call("get-profile", "GET")).username, "adele");
  });

  it("sends the phone the room's history since the person joined, not since it connected", async () => {
    const room = (await call("get-rooms", "GET")).rooms.find((r) => r.roomKey === ROOM);
    const [phoneId] = Object.keys(room.members || {});
    assert.ok(room.members[phoneId].joinedAt > 1000);
    transport.send(JSON.stringify({ type: "join", roomKey: ROOM, peerId: "0b0b0b0b", username: "adele@mobile", ts: 1000, id: "join-1" }) + "\n");
    await eventually(async () => {
      const r = (await call("get-rooms", "GET")).rooms.find((x) => x.roomKey === ROOM);
      return r.members[phoneId]?.joinedAt === 1000;
    }, "the earlier join time");
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
