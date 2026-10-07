// A chat between a person's own devices asked for nothing and went by the
// other device's name: the phone got a message request from its own desktop,
// and the desktop showed the chat as "ada@mobile" instead of You.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { randomBytes } from "node:crypto";
import SecretStream from "@hyperswarm/secret-stream";

import { deriveTopic, encryptMsg, exportChatTransfer, handleChatRequest, initChat } from "../p2p.js";
import { attachChatTransport } from "../transport.js";
import { makeProfileProof } from "../lib/device-link.js";
import { securePair, topicsFrame, wireRoom } from "./helpers.mjs";

const ROOM = "aa".repeat(32);
const DM = "d3".repeat(32);
const EARLY_DM = "d4".repeat(32);
const STRANGER_DM = "d5".repeat(32);
const PHONE = SecretStream.keyPair(Buffer.alloc(32, 31));
const SECOND = SecretStream.keyPair(Buffer.alloc(32, 32));
const STRANGER = SecretStream.keyPair(Buffer.alloc(32, 33));
const full = (keyPair) => keyPair.publicKey.toString("hex");
const short = (keyPair) => full(keyPair).slice(0, 8);
const DESKTOP_ID = "07070707";

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
  async leave() {},
  swarm,
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function call(action, method, body, roomKey) {
  const qs = `hyper://chat?action=${action}${roomKey ? `&roomKey=${roomKey}` : ""}`;
  const res = await handleChatRequest({ url: qs, method, json: async () => body ?? {} }, sdk);
  return JSON.parse(await res.text());
}

async function eventually(check, label) {
  for (let i = 0; i < 100; i++) {
    const value = await check();
    if (value) return value;
    await sleep(50);
  }
  throw new Error(`timed out waiting for ${label}`);
}

describe("a chat with your own device", () => {
  let dir, link;
  const devices = [];

  async function connect(keyPair) {
    const pair = await securePair({ clientKeyPair: keyPair });
    const device = { pair, frames: [], transport: null };
    swarm.emit("connection", pair.serverStream, { topics: [deriveTopic(ROOM)] });
    let buffer = "";
    await new Promise((opened) => {
      device.transport = attachChatTransport(pair.clientStream, (raw) => {
        buffer += raw.toString();
        const lines = buffer.split("\n");
        buffer = lines.pop();
        for (const line of lines) if (line) try { device.frames.push(JSON.parse(line)); } catch {}
      }, { onopen: opened });
    });
    device.send = (frame) => device.transport.send(JSON.stringify(frame) + "\n");
    device.transport.send(topicsFrame(pair.clientStream, [ROOM]));
    device.prove = (label) => device.send({
      type: "profile", peerId: short(keyPair), username: `ada@${label}`, bio: "", avatar: null,
      rooms: [wireRoom(ROOM)], device: label,
      link: makeProfileProof(link, { username: "ada", bio: "", avatar: null, at: 1000 }, full(keyPair)),
    });
    device.invite = (roomKey) => device.send({
      type: "dm-invite", roomKey, fromId: short(keyPair), fromUsername: "ada@mobile",
      fromAvatar: null, fromBio: "", toId: DESKTOP_ID,
    });
    devices.push(device);
    return device;
  }

  before(async () => {
    dir = mkdtempSync(path.join(tmpdir(), "peerchat-own-dm-"));
    writeFileSync(path.join(dir, "chat.json"), JSON.stringify({
      v: 1, profile: { username: "ada", bio: "", at: 1000 }, peerProfiles: {}, pendingDMs: {},
      rooms: {
        [ROOM]: {
          roomKey: ROOM, name: "Room", isHost: true, bio: "", link: "", avatar: null,
          createdAt: Date.now(), createdBy: DESKTOP_ID, createdByName: "ada",
          isPinned: false, isMuted: false, unreadCount: 0, unreadMentions: 0, lastMessage: null, members: {},
        },
      },
    }));
    initChat(sdk, { storagePath: path.join(dir, "chat.json") });
    await sleep(200);
    link = exportChatTransfer({ targetType: "mobile" }).link;
  });

  after(async () => {
    for (const device of devices) {
      try { device.transport.close(); } catch {}
      await device.pair.close();
    }
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("opens without a request when your phone asks, and is called You", async () => {
    const phone = await connect(PHONE);
    phone.prove("mobile");
    await eventually(async () => (await call("get-profile", "GET")).siblings.includes(short(PHONE)), "the phone proven");
    phone.invite(DM);
    await eventually(() => phone.frames.find((f) => f.type === "dm-accept" && f.room === wireRoom(DM)), "the answer");
    const state = await call("get-rooms", "GET");
    const dm = state.rooms.find((r) => r.roomKey === DM);
    assert.equal(dm.name, "You");
    assert.equal(dm.pendingAcceptance, false);
    assert.equal(state.pendingDMs[DM], undefined);
  });

  it("opens one your device asked for before it proved it was yours", async () => {
    const second = await connect(SECOND);
    second.invite(EARLY_DM);
    await eventually(async () => (await call("get-rooms", "GET")).pendingDMs[EARLY_DM], "the request");
    second.prove("desktop2");
    await eventually(() => second.frames.find((f) => f.type === "dm-accept" && f.room === wireRoom(EARLY_DM)), "the answer");
    const state = await call("get-rooms", "GET");
    assert.equal(state.rooms.find((r) => r.roomKey === EARLY_DM)?.name, "You");
    assert.equal(state.pendingDMs[EARLY_DM], undefined);
  });

  it("still asks when someone else asks", async () => {
    const stranger = await connect(STRANGER);
    stranger.invite(STRANGER_DM);
    await eventually(async () => (await call("get-rooms", "GET")).pendingDMs[STRANGER_DM], "the request");
    await sleep(300);
    assert.equal(stranger.frames.some((f) => f.type === "dm-accept"), false);
  });

  it("does not count what you wrote on your phone as unread", async () => {
    const phone = devices[0];
    phone.send({ room: wireRoom(ROOM), id: randomBytes(16).toString("hex"), sender: short(PHONE), sn: "ada@mobile", ts: Date.now(), ...encryptMsg("from my phone", ROOM) });
    await eventually(async () => ((await call("get-history", "GET", null, ROOM)).messages || []).some((m) => m.message === "from my phone"), "the message");
    assert.equal((await call("get-rooms", "GET")).rooms.find((r) => r.roomKey === ROOM).unreadCount, 0);
  });

  it("keeps You on the page when the other device answers or updates its profile", () => {
    const app = readFileSync(new URL("../app.js", import.meta.url), "utf8");
    const p2p = readFileSync(new URL("../p2p.js", import.meta.url), "utf8");
    const payload = p2p.slice(p2p.indexOf("function roomUpdatePayload("), p2p.indexOf("function emitRoomUpdate("));
    assert.match(payload, /name: shownRoomName\(roomKey, room\)/);
    const accepted = app.slice(app.indexOf('es.addEventListener("dm-accepted"'), app.indexOf('es.addEventListener("dm-blocked"'));
    assert.match(accepted, /room\.name = isOwnId\(fromId\) \? "You" : fromUsername/);
    const refresh = app.slice(app.indexOf("function refreshActiveChatForPeer("), app.indexOf("async function refreshActiveRoom("));
    assert.match(refresh, /isOwnId\(peerId\) \? "You" : username/);
  });
});
