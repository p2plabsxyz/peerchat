// A direct message is two people, either of whom can block the other, so the
// group filters stay out of it: threats, the word list and adult domain links
// all pass. Groups keep every filter. The spam limit holds in both.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { randomBytes } from "node:crypto";
import SecretStream from "@hyperswarm/secret-stream";

import { deriveTopic, encryptMsg, handleChatRequest, initChat } from "../p2p.js";
import { attachChatTransport } from "../transport.js";
import {
  MAX_MSGS_PER_WINDOW,
  checkContent,
  checkMessage,
  resetAll,
  setAdultDomains,
  setBadWords,
} from "../moderation.js";
import { securePair, topicsFrame, wireRoom } from "./helpers.mjs";

const GROUP = "d1".repeat(32);
const DM = "d2".repeat(32);
const CAROL = SecretStream.keyPair(Buffer.alloc(32, 9));
const full = (keyPair) => keyPair.publicKey.toString("hex");
const short = (keyPair) => full(keyPair).slice(0, 8);

const TEXT = "kys, you ass. see pornhub.com";
const DIRECT = { abuseFilter: true, nsfwFilter: true, spamRateLimit: 10, directMessage: true };

describe("filters in a direct message", () => {
  before(() => {
    resetAll();
    setBadWords(new Set(["ass"]));
    setAdultDomains(new Set(["pornhub.com"]));
  });

  it("let threats, the word list and adult domain links through", () => {
    assert.deepEqual(checkContent(TEXT, DIRECT), { flagged: false, reason: "" });
    assert.equal(checkContent("you ass", DIRECT).flagged, false);
    assert.equal(checkContent("pornhub.com", DIRECT).flagged, false);
    assert.equal(checkMessage("0a0a0a0a", DM, TEXT, 1000, { roomModeration: DIRECT }).allowed, true);
  });

  it("stay on in a group", () => {
    assert.equal(checkContent("kys", null).flagged, true);
    assert.equal(checkContent("you ass", null).flagged, true);
    assert.equal(checkContent("see pornhub.com", null).flagged, true);
    // A room's own settings cannot turn the adult domain list off.
    assert.equal(checkContent("see pornhub.com", { abuseFilter: false, nsfwFilter: false }).flagged, true);
  });

  it("still count spam", () => {
    resetAll();
    let last;
    for (let i = 0; i < MAX_MSGS_PER_WINDOW; i++) {
      last = checkMessage("0b0b0b0b", DM, "hello", 2000 + i, { roomModeration: DIRECT });
    }
    assert.equal(last.allowed, false);
    assert.match(last.reason, /spam/);
  });
});

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
  swarm,
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function call(action, method, body, roomKey) {
  const qs = `hyper://chat?action=${action}${roomKey ? `&roomKey=${roomKey}` : ""}`;
  const res = await handleChatRequest({ url: qs, method, json: async () => body ?? {} }, sdk);
  return JSON.parse(await res.text());
}
const history = async (roomKey) => (await call("get-history", "GET", null, roomKey)).messages || [];

function room(roomKey, name, extra = {}) {
  return {
    roomKey, name, isHost: true, bio: "", link: "", avatar: null,
    createdAt: Date.now(), createdBy: "07070707", createdByName: "ada",
    isPinned: false, isMuted: false, unreadCount: 0, unreadMentions: 0,
    lastMessage: null, members: {}, ...extra,
  };
}

describe("a message with a threat, a slur and an adult link, from a peer", () => {
  let dir;
  let carol;

  before(async () => {
    dir = mkdtempSync(path.join(tmpdir(), "peerchat-dm-filters-"));
    writeFileSync(path.join(dir, "chat.json"), JSON.stringify({
      v: 1, profile: { username: "ada", bio: "", at: 1000 }, peerProfiles: {}, pendingDMs: {},
      rooms: {
        [GROUP]: room(GROUP, "Launch crew"),
        [DM]: room(DM, "carol", { isHost: false, isDM: true, dmWith: short(CAROL), dmWithKey: full(CAROL), pendingAcceptance: false }),
      },
    }));
    initChat(sdk, { storagePath: path.join(dir, "chat.json") });
    await sleep(200);
    // The real lists load from disk; these keep the test to two words.
    setBadWords(new Set(["ass"]));
    setAdultDomains(new Set(["pornhub.com"]));
    resetAll();

    const pair = await securePair({ clientKeyPair: CAROL });
    carol = { pair, frames: [], transport: null };
    swarm.emit("connection", pair.serverStream, { topics: [deriveTopic(GROUP), deriveTopic(DM)] });
    let buffer = "";
    await new Promise((opened) => {
      carol.transport = attachChatTransport(pair.clientStream, (raw) => {
        buffer += raw.toString();
        const lines = buffer.split("\n");
        buffer = lines.pop();
        for (const line of lines) if (line) try { carol.frames.push(JSON.parse(line)); } catch {}
      }, { onopen: opened });
    });
    carol.send = (frame) => carol.transport.send(typeof frame === "string" ? frame : JSON.stringify(frame) + "\n");
    for (let i = 0; i < 100 && !carol.frames.some((f) => f.type === "topics"); i++) await sleep(50);
    carol.send(topicsFrame(pair.clientStream, [GROUP, DM]));
    for (let i = 0; i < 100 && carol.frames.filter((f) => f.type === "room-meta").length < 2; i++) await sleep(50);
    carol.send({ type: "join", room: wireRoom(GROUP), peerId: short(CAROL), username: "carol", ts: Date.now() });
    await sleep(200);
  });

  after(async () => {
    try { carol?.transport?.close(); } catch {}
    await carol?.pair.close().catch(() => {});
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("lands in a direct message", async () => {
    const id = randomBytes(16).toString("hex");
    carol.send({ room: wireRoom(DM), id, sender: short(CAROL), sn: "carol", ts: Date.now(), ...encryptMsg(TEXT, DM) });
    let found;
    for (let i = 0; i < 60 && !found; i++) {
      found = (await history(DM)).find((m) => m.id === id);
      if (!found) await sleep(50);
    }
    assert.ok(found, "the message is in the conversation");
    assert.equal(found.message ?? found.text, TEXT);
  });

  it("is held back in a group, with a notice in its place", async () => {
    const id = randomBytes(16).toString("hex");
    carol.send({ room: wireRoom(GROUP), id, sender: short(CAROL), sn: "carol", ts: Date.now(), ...encryptMsg(TEXT, GROUP) });
    let notice;
    for (let i = 0; i < 60 && !notice; i++) {
      notice = (await history(GROUP)).find((m) => m.type === "system" && m.moderationNotice);
      if (!notice) await sleep(50);
    }
    assert.ok(notice, "a moderation notice");
    assert.equal((await history(GROUP)).some((m) => m.id === id), false);
  });
});
