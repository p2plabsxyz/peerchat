// A declined message request came back: the inviter kept the request as
// waiting and sent it again each time the other person connected, so after
// every restart they were asked again, and the inviter's chat said it was
// waiting for an answer it had already had. Mirrors peersky-mobile, which
// keeps a decline.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import SecretStream from "@hyperswarm/secret-stream";

import { deriveTopic, handleChatRequest, initChat } from "../p2p.js";
import { attachChatTransport } from "../transport.js";
import { securePair, topicsFrame, wireRoom } from "./helpers.mjs";

const DM = "d1".repeat(32);
const BOB = SecretStream.keyPair(Buffer.alloc(32, 21));
const full = (keyPair) => keyPair.publicKey.toString("hex");
const short = (keyPair) => full(keyPair).slice(0, 8);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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
  publicKey: Buffer.alloc(32, 7),
  corestore: { get: ({ name }) => feeds.get(name) || feeds.set(name, fakeFeed()).get(name) },
  join() {},
  async leave() {},
  swarm,
};

async function request(action, method, body, roomKey) {
  const qs = `hyper://chat?action=${action}${roomKey ? `&roomKey=${roomKey}` : ""}`;
  const res = await handleChatRequest({ url: qs, method, json: async () => body ?? {} }, sdk);
  return { status: res.status, body: JSON.parse(await res.text()) };
}
const call = async (action, method, body, roomKey) => (await request(action, method, body, roomKey)).body;
const findRoom = async (roomKey) => (await call("get-rooms", "GET")).rooms.find((room) => room.roomKey === roomKey);
const until = async (check, label) => {
  for (let i = 0; i < 100; i++) {
    const value = await check();
    if (value) return value;
    await sleep(50);
  }
  throw new Error(`timed out waiting for ${label}`);
};

// Bob's device: connects, proves nothing (a request is waiting on him, not a
// room) and hands back what it is sent.
async function connectBob() {
  const pair = await securePair({ clientKeyPair: BOB });
  const frames = [];
  swarm.emit("connection", pair.serverStream, { topics: [deriveTopic(DM)] });
  let buffer = "";
  const transport = await new Promise((opened) => {
    const t = attachChatTransport(pair.clientStream, (raw) => {
      buffer += raw.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop();
      for (const line of lines) if (line) try { frames.push(JSON.parse(line)); } catch {}
    }, { onopen: () => opened(t) });
  });
  await until(() => frames.some((f) => f.type === "topics"), "our proofs");
  transport.send(topicsFrame(pair.clientStream, []));
  return {
    frames,
    send: (frame) => transport.send(JSON.stringify(frame) + "\n"),
    close: async () => {
      try { transport.close(); } catch {}
      await pair.close().catch(() => {});
    },
  };
}

describe("a declined message request", () => {
  let dir;

  before(async () => {
    dir = mkdtempSync(path.join(tmpdir(), "peerchat-dm-decline-"));
    writeFileSync(path.join(dir, "chat.json"), JSON.stringify({
      v: 1, profile: { username: "Test Ada", bio: "", at: 1000 }, peerProfiles: {}, pendingDMs: {},
      rooms: {
        [DM]: {
          roomKey: DM, name: "Test Bob", isHost: false, isDM: true, dmWith: short(BOB), dmWithKey: full(BOB),
          bio: "", link: "", avatar: null, createdAt: Date.now() - 60_000, createdBy: "07070707", createdByName: "Test Ada",
          isPinned: false, isMuted: false, unreadCount: 0, unreadMentions: 0, lastMessage: null, members: {},
          pendingAcceptance: true,
        },
      },
    }));
    initChat(sdk, { storagePath: path.join(dir, "chat.json") });
    await sleep(200);
  });

  after(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });

  it("goes out when the other person connects", async () => {
    const bob = await connectBob();
    await until(() => bob.frames.some((f) => f.type === "dm-invite" && f.roomKey === DM), "the request");

    // As a peer sends it: the room by its topic, never its key.
    bob.send({ type: "dm-reject", room: wireRoom(DM), fromId: short(BOB), fromUsername: "Test Bob" });
    const declined = await until(async () => {
      const found = await findRoom(DM);
      return found?.rejected ? found : null;
    }, "the decline");
    assert.equal(declined.pendingAcceptance, false);
    const sent = await request("send", "POST", { message: "hello?" }, DM);
    assert.equal(sent.status, 403);
    assert.match(sent.body.error, /declined/);
    await bob.close();
  });

  it("is not sent again when they reconnect, and stays declined across a restart", async () => {
    await sleep(300);
    const bob = await connectBob();
    await sleep(500);
    assert.equal(bob.frames.filter((f) => f.type === "dm-invite").length, 0, "no second request");
    await bob.close();
    await sleep(1200);
    const saved = JSON.parse(readFileSync(path.join(dir, "chat.json"), "utf8"));
    assert.equal(saved.rooms[DM].rejected, true);
    assert.equal(saved.rooms[DM].pendingAcceptance, false);
  });

  it("can be asked again from their profile", async () => {
    const bob = await connectBob();
    await sleep(200);
    const asked = await call("join-dm", "POST", { toId: short(BOB), toKey: full(BOB), toUsername: "Test Bob" });
    assert.equal(asked.roomKey, DM);
    await until(() => bob.frames.some((f) => f.type === "dm-invite" && f.roomKey === DM), "the request asked again");
    const room = await findRoom(DM);
    assert.equal(room.rejected, false);
    assert.equal(room.pendingAcceptance, true);
    await bob.close();
  });

  it("is shown in the chat, which asks again through Message", () => {
    const app = readFileSync(new URL("../app.js", import.meta.url), "utf8");
    assert.match(app, /declined your message request\. Open their profile and press Message to ask again\./);
    assert.match(app, /if \(existing\?\.blockedByPeer \|\| existing\?\.rejected\) \{/);
    assert.match(app, /es\.addEventListener\("dm-rejected"[\s\S]{0,400}room\.rejected = true;/);
  });
});
