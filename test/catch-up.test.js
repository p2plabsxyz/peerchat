// Catching up after being away, as tested by hand with a phone and three
// desktops, here with four desktops over real connections. Each runs its own
// copy of p2p.js (see desktops.mjs) with its own key, Hyperswarm and DHT node
// on a hyperdht testnet bound to 127.0.0.1 with no public bootstrap nodes, so
// nothing leaves this machine. A desktop that quits and comes back starts a
// fresh copy over what it saved. B makes the room, one whose message keys
// rotate every hour.
//
// Round 1: A and D quit. B and C chat, then B goes offline and C stays on,
// idle. A comes back with only C there and has to get every message, B's too,
// which can only come through C. D comes back and gets them all as well.
//
// Round 2: A and D go offline, B comes back, B and C exchange two messages and
// B leaves. D comes back with only C there and has to get both.
//
// C can hand on B's messages as B's because every message is signed by its
// author and every desktop keeps the signature. PeerSky Mobile runs the same
// story with phones in test/protocol/peerchat-catch-up.test.mjs.
//
// A desktop quits as PeerSky quits, closing its swarm, so the others log
// "connection reset by peer" each time, as they would in real use.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import b4a from "b4a";
import crypto from "hypercore-crypto";
import HyperDHT from "hyperdht";
import createTestnet from "hyperdht/testnet.js";
import Hyperswarm from "hyperswarm";

import { PRE_JOINED_ROOM_KEY } from "../rooms.js";
import { roomRotates } from "../lib/key-chain.js";
import { readSignedMessage } from "../lib/message-signature.js";
import { wireRoom } from "./helpers.mjs";
import { chatCaller, loadDesktop, memoryStore, writeChatFile } from "./desktops.mjs";

const WAIT_MS = 20_000;
// p2p.js saves two seconds after a change. A desktop that quit starts again
// no sooner than that, so the copy that quit has nothing left to write over
// what the new one saves.
const SAVE_DELAY_MS = 2_500;
const REPUBLIC = wireRoom(PRE_JOINED_ROOM_KEY);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));

let testnet = null;
let root = "";
let roomKey = "";
let republicJoins = 0;
let a, b, c, d;
const round1 = [];
const round2 = [];

function makeDevice(letter) {
  const keyPair = crypto.keyPair();
  const device = {
    letter,
    name: `Device ${letter}`,
    keyPair,
    id: b4a.toString(keyPair.publicKey, "hex").slice(0, 8),
    storagePath: path.join(root, `${letter}.json`),
    logs: new Map(),
    starts: 0,
    stoppedAt: 0,
    online: false,
  };
  writeChatFile(device.storagePath, device.name);
  return device;
}

// A desktop starting up, with the key, rooms and messages it had before.
async function start(device) {
  await sleep(device.stoppedAt + SAVE_DELAY_MS - Date.now());
  const dht = new HyperDHT({ bootstrap: testnet.bootstrap, host: "127.0.0.1", ephemeral: true });
  assert.ok(dht.bootstrapNodes.length > 0);
  for (const node of dht.bootstrapNodes) assert.equal(node.host, "127.0.0.1");
  const swarm = new Hyperswarm({ keyPair: device.keyPair, dht });
  const sdk = {
    publicKey: device.keyPair.publicKey,
    swarm,
    corestore: memoryStore(device.logs, device.keyPair),
    join: (topic, opts) => {
      if (b4a.toString(topic, "hex") === REPUBLIC) {
        republicJoins++;
        throw new Error("P2P Republic is off limits here");
      }
      return swarm.join(topic, opts);
    },
    leave: (topic) => swarm.leave(topic),
  };
  device.starts += 1;
  const mod = await loadDesktop(`catch-up-${device.letter}${device.starts}`);
  mod.initChat(sdk, { storagePath: device.storagePath, keyPair: device.keyPair });
  Object.assign(device, { mod, sdk, swarm, dht, online: true, call: chatCaller(mod, sdk) });
}

// Quit, or gone offline: its connections go, and what it saved stays.
async function stop(device) {
  device.online = false;
  for (const node of device.dht.toArray()) assert.equal(node.host, "127.0.0.1");
  await device.swarm.destroy();
  await device.dht.destroy();
  device.stoppedAt = Date.now();
}

async function waitFor(check, what) {
  const until = Date.now() + WAIT_MS;
  while (!(await check())) {
    if (Date.now() > until) throw new Error(`Timed out waiting for ${typeof what === "function" ? await what() : what}`);
    await sleep(50);
  }
}

// Who a desktop is in the room with right now, by id.
async function roomPeers(device) {
  const { peers } = await device.call("net-status", "GET");
  return [...new Set(peers.filter((peer) => peer.rooms.includes(roomKey)).map((peer) => peer.id))].sort();
}
const idsOf = (...list) => list.map((device) => device.id).sort();
const sameIds = (left, right) => left.join() === right.join();

async function roomOf(device) {
  const { rooms } = await device.call("get-rooms", "GET");
  return rooms.find((room) => room.roomKey === roomKey);
}

async function shown(device) {
  const { messages = [] } = await device.call("get-history", "GET", null, roomKey);
  return messages.filter((message) => message.type !== "system" && message.type !== "reaction");
}
const stored = (device) => device.logs.get(`chat-${roomKey}`) || [];

// Waits until a desktop shows all of these, then checks each one reads as its
// author's, as written, and is stored as below.
async function expectMessages(device, messages) {
  let list = [];
  const missing = () => messages.filter((sent) => !list.some((message) => message.id === sent.id));
  await waitFor(async () => {
    list = await shown(device);
    return missing().length === 0;
  }, () => `${device.name} to show ${missing().map((sent) => `"${sent.text}"`).join(", ")}`);
  for (const sent of messages) {
    const message = list.find((candidate) => candidate.id === sent.id);
    assert.equal(message.message, sent.text);
    assert.equal(message.sender, sent.by.id, `"${sent.text}" on ${device.name} should be ${sent.by.name}'s`);
    assert.equal(message.senderName, sent.by.name);
  }
  expectStoredOnce(device, messages);
}

// Each stored once, sealed with an hour's key, and still carrying its author's
// signature, which is what lets the desktop hand it on.
function expectStoredOnce(device, messages) {
  for (const sent of messages) {
    const copies = stored(device).filter((entry) => entry.id === sent.id);
    assert.equal(copies.length, 1, `${device.name} stored "${sent.text}" ${copies.length} times`);
    assert.ok(Number.isSafeInteger(copies[0].e), `"${sent.text}" should be sealed with an hour's key`);
    assert.equal(readSignedMessage(copies[0], wireRoom(roomKey))?.authorId, sent.by.id);
  }
}

// One message, and the other side has it before anything else is said.
async function say(from, to, text) {
  const reply = await from.call("send", "POST", { message: text }, roomKey);
  assert.ok(reply.sent?.id, reply.error);
  const sent = { id: reply.sent.id, by: from, text };
  await expectMessages(to, [sent]);
  return sent;
}

describe("catching up through the one desktop still on", () => {
  before(async () => {
    root = mkdtempSync(path.join(tmpdir(), "peerchat-catch-up-"));
    testnet = await createTestnet(4, { host: "127.0.0.1" });
    for (const node of testnet.nodes) assert.equal(node.address().host, "127.0.0.1");
    for (const node of testnet.bootstrap) assert.equal(node.host, "127.0.0.1");

    [a, b, c, d] = ["A", "B", "C", "D"].map(makeDevice);
    for (const device of [a, b, c, d]) await start(device);
    roomKey = (await b.call("create-key", "POST", { name: "Catch up" })).roomKey;
    assert.ok(roomRotates(roomKey));
    await b.call("join", "POST", {}, roomKey);
    // One at a time, as people do. Joined all at once, each looks the room up
    // before the others have announced it, and they only find B.
    for (const device of [a, c, d]) await device.call("join", "POST", {}, roomKey);

    // Everyone in the room with everyone, with the room's key chain, and
    // knowing when each of the others joined, which decides the history each
    // is sent.
    const all = [a, b, c, d];
    const others = (device) => all.filter((other) => other !== device);
    const state = async (device) => {
      const room = await roomOf(device);
      const knows = others(device).filter((other) => Number.isFinite(room?.members?.[other.id]?.joinedAt));
      return { peers: await roomPeers(device), rotates: room?.rotates === true, knows };
    };
    const ready = async (device) => {
      const { peers, rotates, knows } = await state(device);
      return sameIds(peers, idsOf(...others(device))) && rotates && knows.length === 3;
    };
    await waitFor(async () => (await Promise.all(all.map(ready))).every(Boolean), async () =>
      "all four to be in the room together; " + (await Promise.all(all.map(async (device) => {
        const { peers, rotates, knows } = await state(device);
        return `${device.name} is with ${peers.length}, knows ${knows.length} join times${rotates ? "" : ", has no key chain"}`;
      }))).join("; "));
  }, { timeout: 60_000 });

  after(async () => {
    for (const device of [a, b, c, d]) {
      if (!device?.online) continue;
      device.online = false;
      await device.swarm.destroy().catch(() => {});
      await device.dht.destroy().catch(() => {});
      device.stoppedAt = Date.now();
    }
    await testnet?.destroy();
    // The last saves land before the folder goes.
    await sleep(Math.max(...[a, b, c, d].map((device) => device?.stoppedAt || 0)) + SAVE_DELAY_MS - Date.now());
    if (root) rmSync(root, { recursive: true, force: true });
  });

  it("round 1: A comes back with only C on and gets every message, B's through C", { timeout: 60_000 }, async () => {
    await Promise.all([stop(a), stop(d)]);
    await waitFor(async () => sameIds(await roomPeers(b), idsOf(c)) && sameIds(await roomPeers(c), idsOf(b)), "B and C to see A and D go");

    for (let n = 1; n <= 3; n++) {
      round1.push(await say(b, c, `Round 1, message ${n} from B`));
      round1.push(await say(c, b, `Round 1, message ${n} from C`));
    }
    await stop(b);
    c.mod.setPresenceIdle(true);
    await waitFor(async () => (await roomPeers(c)).length === 0, "C to see B go");

    await start(a);
    await expectMessages(a, round1);
    assert.deepEqual(await roomPeers(a), idsOf(c));
  });

  it("round 1: D comes back and gets them all too", { timeout: 60_000 }, async () => {
    await start(d);
    await expectMessages(d, round1);
  });

  it("round 2: D comes back with only C on and gets the two messages B and C exchanged while it was away", { timeout: 60_000 }, async () => {
    await Promise.all([stop(a), stop(d)]);
    await waitFor(async () => (await roomPeers(c)).length === 0, "C to see A and D go");

    await start(b);
    await waitFor(async () => sameIds(await roomPeers(b), idsOf(c)) && sameIds(await roomPeers(c), idsOf(b)), "B and C to meet again");
    round2.push(await say(b, c, "Round 2 from B"));
    round2.push(await say(c, b, "Round 2 from C"));
    await stop(b);
    await waitFor(async () => (await roomPeers(c)).length === 0, "C to see B go");

    await start(d);
    await expectMessages(d, [...round1, ...round2]);
    assert.deepEqual(await roomPeers(d), idsOf(c));
  });

  it("stores a message only once when history brings it again", () => {
    // B came back to history it already had, and D was sent round 1 by both
    // A and C.
    expectStoredOnce(a, round1);
    expectStoredOnce(b, [...round1, ...round2]);
    expectStoredOnce(c, [...round1, ...round2]);
    expectStoredOnce(d, [...round1, ...round2]);
  });

  it("never joined P2P Republic", async () => {
    assert.equal(republicJoins, 0);
    for (const device of [a, b, c, d]) {
      const { rooms } = await device.call("get-rooms", "GET");
      assert.equal(rooms.some((room) => room.roomKey === PRE_JOINED_ROOM_KEY), false);
    }
  });
});
