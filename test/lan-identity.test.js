// On the local network, hyperdht-mdns 2 connects with a key made up for that
// network, so the connection says nothing about who is on the other end.
// PeerSky passes in its identityGate: who someone is gets proven inside the
// channel, and only to someone who shares a room or the person's device link.
// Here real desktops meet that way. Skipped where the installed hyperdht-mdns
// has no gate.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import SecretStream from "@hyperswarm/secret-stream";
import HyperDHTmDNS from "@p2plabs/hyperdht-mdns";

import { chatCaller, loadDesktop, memoryStore } from "./desktops.mjs";
import { securePair } from "./helpers.mjs";

const gate = HyperDHTmDNS.identityGate;
const GROUP = "c1".repeat(32);
const LINK = { key: "c2".repeat(32), origin: "desktop", labels: [] };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function room(roomKey, name, createdBy) {
  return {
    roomKey, name, isHost: false, bio: "", link: "", avatar: null,
    createdAt: Date.now() - 60_000, createdBy, createdByName: "ada",
    isPinned: false, isMuted: false, unreadCount: 0, unreadMentions: 0, lastMessage: null, members: {},
  };
}

describe("PeerChat on the local network", { skip: typeof gate !== "function" && "hyperdht-mdns has no identityGate" }, () => {
  let root = "";
  const devices = [];
  const pairs = [];

  // A desktop whose internet swarm has nobody to ask: what it hears comes
  // over the local network, from connect() below.
  async function start(letter, chat, { slow = 0 } = {}) {
    const keyPair = SecretStream.keyPair();
    const device = { letter, keyPair, id: keyPair.publicKey.toString("hex").slice(0, 8), storagePath: path.join(root, `${letter}.json`), logs: new Map(), gates: [] };
    writeFileSync(device.storagePath, JSON.stringify({ v: 1, peerProfiles: {}, pendingDMs: {}, rooms: {}, leftRooms: {}, ...chat }));
    const swarm = new EventEmitter();
    swarm.flush = async () => {};
    const sdk = {
      publicKey: keyPair.publicKey,
      swarm,
      corestore: memoryStore(device.logs, keyPair),
      join: () => ({ flushed: async () => true, destroy: async () => {}, refresh: async () => {} }),
      leave: async () => {},
    };
    // A slow gate finishes after the other side's, which then opens the chat
    // channel first.
    const recording = (...args) => gate(...args).then((result) => new Promise((resolve) => setTimeout(() => {
      device.gates.push(result);
      resolve(result);
    }, slow)));
    const mod = await loadDesktop(`lan-identity-${letter}`);
    mod.initChat(sdk, { storagePath: device.storagePath, keyPair, identityGate: recording });
    Object.assign(device, { mod, sdk, swarm, call: chatCaller(mod, sdk) });
    devices.push(device);
    return device;
  }

  // The two ends of a local network connection, each with a key made up for
  // the network, as hyperdht-mdns hands them to the app.
  async function connect(left, right) {
    const pair = await securePair();
    pairs.push(pair);
    left.swarm.emit("connection", pair.clientStream, { lan: true, ephemeral: true });
    right.swarm.emit("connection", pair.serverStream, { lan: true, ephemeral: true });
    return pair;
  }

  async function waitFor(check, what) {
    const until = Date.now() + 15_000;
    while (!(await check())) {
      if (Date.now() > until) throw new Error(`Timed out waiting for ${what}`);
      await sleep(50);
    }
  }

  const peersOf = async (device) => (await device.call("net-status", "GET")).peers;

  let ada, adaDesktop, bob, cy;

  before(async () => {
    root = mkdtempSync(path.join(tmpdir(), "peerchat-lan-identity-"));
    ada = await start("a", { profile: { username: "ada" }, device: { label: "" }, link: LINK, rooms: { [GROUP]: room(GROUP, "Launch crew", "") } });
    // Another of Ada's devices, in no room.
    adaDesktop = await start("b", { profile: { username: "ada" }, device: { label: "desktop1" }, link: LINK });
    bob = await start("c", { profile: { username: "bob" }, rooms: { [GROUP]: room(GROUP, "Launch crew", "") } });
    // Someone else on the same Wi-Fi, in no room with anyone here.
    cy = await start("d", { profile: { username: "cy" }, rooms: { ["c3".repeat(32)]: room("c3".repeat(32), "Elsewhere", "") } });
    await sleep(200);
  });

  after(async () => {
    for (const pair of pairs) await pair.close().catch(() => {});
    rmSync(root, { recursive: true, force: true });
  });

  it("two people in a room know each other by the key they proved, and the room opens", async () => {
    const pair = await connect(ada, bob);
    await waitFor(async () => (await peersOf(ada)).some((p) => p.id === bob.id && p.rooms.length === 1), "Bob in the room at Ada's");
    await waitFor(async () => (await peersOf(bob)).some((p) => p.id === ada.id && p.rooms.length === 1), "Ada in the room at Bob's");
    const connectionIds = [pair.clientStream.publicKey, pair.serverStream.publicKey].map((key) => key.toString("hex").slice(0, 8));
    for (const peer of [...await peersOf(ada), ...await peersOf(bob)]) assert.equal(connectionIds.includes(peer.id), false);

    // A message goes across, as its author's.
    const sent = await ada.call("send", "POST", { message: "Over the Wi-Fi" }, GROUP);
    assert.ok(sent.id || sent.ok !== false);
    await waitFor(async () => ((await bob.call("get-history", "GET", null, GROUP)).messages || [])
      .some((m) => (m.message ?? m.text) === "Over the Wi-Fi" && (m.sender ?? m.peerId) === ada.id), "the message at Bob's, from Ada");
  });

  it("another of the person's devices is known through the link, with no room in common", async () => {
    await connect(ada, adaDesktop);
    await waitFor(async () => (await peersOf(adaDesktop)).some((p) => p.id === ada.id), "Ada at her desktop");
    await waitFor(async () => (await peersOf(ada)).some((p) => p.id === adaDesktop.id), "the desktop at Ada's");
  });

  it("the room opens when one side finishes proving well before the other", async () => {
    const roomKey = "c4".repeat(32);
    const dee = await start("e", { profile: { username: "dee" }, rooms: { [roomKey]: room(roomKey, "Night shift", "") } });
    const eve = await start("f", { profile: { username: "eve" }, rooms: { [roomKey]: room(roomKey, "Night shift", "") } }, { slow: 300 });
    await connect(dee, eve);
    await waitFor(async () => (await peersOf(dee)).some((p) => p.id === eve.id && p.rooms.length === 1), "Eve in the room at Dee's");
    await waitFor(async () => (await peersOf(eve)).some((p) => p.id === dee.id && p.rooms.length === 1), "Dee in the room at Eve's");
  });

  it("a stranger learns nothing and gets nothing", async () => {
    const before = cy.gates.length;
    await connect(cy, bob);
    await waitFor(() => cy.gates.length > before, "Cy's gate");
    await sleep(300);
    assert.equal(cy.gates.at(-1), null, "Cy does not learn who Bob is");
    assert.equal(bob.gates.at(-1), null, "and Bob does not learn who Cy is");
    assert.equal((await peersOf(bob)).some((p) => p.id === cy.id), false);
    assert.equal((await peersOf(cy)).length, 0);
  });
});
