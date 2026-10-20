// Two of one person's devices, linked, that share no room: both left P2P
// Republic, say, and the person linked them before joining anything. A room
// was the only place devices met, so these two never met, and a room made on
// one never reached the other. They meet now under a topic only the link's
// holders can work out, and prove the link on the connection.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import b4a from "b4a";
import crypto from "hypercore-crypto";
import HyperDHT from "hyperdht";
import createTestnet from "hyperdht/testnet.js";
import Hyperswarm from "hyperswarm";

import { PRE_JOINED_ROOM_KEY } from "../rooms.js";
import { checkDevicesProof, devicesProof, devicesTopic } from "../lib/device-link.js";
import { wireRoom } from "./helpers.mjs";
import { chatCaller, loadDesktop, memoryStore } from "./desktops.mjs";

const WAIT_MS = 20_000;
const REPUBLIC = wireRoom(PRE_JOINED_ROOM_KEY);
const LINK = { key: "5a".repeat(32), origin: "desktop", labels: ["desktop1"] };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));

describe("where one person's devices meet", () => {
  // Pinned, as room proofs are: PeerSky Mobile makes the same bytes
  // (backend/peerchat/device-link.mjs there).
  it("is the same topic and proof on every device", () => {
    const link = { key: "0f".repeat(32) };
    assert.equal(devicesTopic(link).toString("hex"), "a6be18025b49b2dcaf36e91189ddf158d3b1c42529d20b746e53cda4f9187cff");
    const proof = devicesProof(link, "0e".repeat(64), "0d".repeat(32));
    assert.equal(proof, "53481f782190e3a7dedc59bbddbe1fd810913b36508c00159d2d03a80ef28589");
    assert.equal(checkDevicesProof(link, "0e".repeat(64), "0d".repeat(32), proof), true);
  });

  it("takes a proof only for this link, this connection and this sender", () => {
    const link = { key: "0f".repeat(32) };
    const proof = devicesProof(link, "0e".repeat(64), "0d".repeat(32));
    assert.equal(checkDevicesProof(link, "0c".repeat(64), "0d".repeat(32), proof), false);
    assert.equal(checkDevicesProof(link, "0e".repeat(64), "0b".repeat(32), proof), false);
    assert.equal(checkDevicesProof({ key: "1f".repeat(32) }, "0e".repeat(64), "0d".repeat(32), proof), false);
    assert.equal(checkDevicesProof(link, "0e".repeat(64), "0d".repeat(32), undefined), false);
    assert.equal(devicesProof(null, "0e".repeat(64), "0d".repeat(32)), "");
    assert.equal(devicesTopic(null), null);
  });
});

describe("one person's devices with no room in common", () => {
  let testnet = null;
  let root = "";
  const devices = [];

  function makeDevice(letter, chat) {
    const keyPair = crypto.keyPair();
    const device = { letter, keyPair, storagePath: path.join(root, `${letter}.json`), logs: new Map() };
    writeFileSync(device.storagePath, JSON.stringify({
      v: 1, peerProfiles: {}, pendingDMs: {}, rooms: {},
      // Both left P2P Republic, so nothing else brings them together.
      leftRooms: { [PRE_JOINED_ROOM_KEY]: Date.now() },
      ...chat,
    }));
    devices.push(device);
    return device;
  }

  async function start(device) {
    const dht = new HyperDHT({ bootstrap: testnet.bootstrap, host: "127.0.0.1", ephemeral: true });
    const swarm = new Hyperswarm({ keyPair: device.keyPair, dht });
    const sdk = {
      publicKey: device.keyPair.publicKey,
      swarm,
      corestore: memoryStore(device.logs, device.keyPair),
      join: (topic, opts) => {
        if (b4a.toString(topic, "hex") === REPUBLIC) throw new Error("P2P Republic is off limits here");
        return swarm.join(topic, opts);
      },
      leave: (topic) => swarm.leave(topic),
    };
    const mod = await loadDesktop(`devices-meet-${device.letter}`);
    mod.initChat(sdk, { storagePath: device.storagePath, keyPair: device.keyPair });
    Object.assign(device, { mod, sdk, swarm, dht, call: chatCaller(mod, sdk) });
  }

  async function waitFor(check, what) {
    const until = Date.now() + WAIT_MS;
    while (!(await check())) {
      if (Date.now() > until) throw new Error(`Timed out waiting for ${what}`);
      await sleep(50);
    }
  }

  const roomNames = async (device) => (await device.call("get-rooms", "GET")).rooms.map((room) => room.name).sort();

  let ada, adaDesktop, stranger;

  before(async () => {
    testnet = await createTestnet(3, { host: "127.0.0.1" });
    root = mkdtempSync(path.join(tmpdir(), "peerchat-devices-meet-"));
    ada = makeDevice("a", { profile: { username: "ada" }, device: { label: "" }, link: LINK });
    adaDesktop = makeDevice("b", { profile: { username: "ada" }, device: { label: "desktop1" }, link: LINK });
    // Someone else, also in no room, with a link of their own.
    stranger = makeDevice("c", { profile: { username: "cy" }, device: { label: "" }, link: { key: "6b".repeat(32), origin: "desktop", labels: [] } });
    // One after another, as devices start. Started at the same instant,
    // each looks the topic up before the other has announced it.
    for (const device of devices) {
      await start(device);
      await device.swarm.flush();
    }
  });

  after(async () => {
    for (const device of devices) {
      await device.swarm?.destroy().catch(() => {});
      await device.dht?.destroy().catch(() => {});
    }
    await testnet?.destroy();
    rmSync(root, { recursive: true, force: true });
  });

  it("a room made on one reaches the other, and nobody else", async () => {
    assert.deepEqual(await roomNames(ada), []);
    assert.deepEqual(await roomNames(adaDesktop), []);

    const { roomKey } = await ada.call("create-key", "POST", { name: "Trip planning" });
    await ada.call("join", "POST", {}, roomKey);

    await waitFor(async () => (await roomNames(adaDesktop)).includes("Trip planning"), "the room on the other desktop");
    // The stranger saw neither device as one of theirs and got nothing.
    await sleep(500);
    assert.deepEqual(await roomNames(stranger), []);
  });

  it("a room made on the other goes back the same way", async () => {
    const { roomKey } = await adaDesktop.call("create-key", "POST", { name: "Recipes" });
    await adaDesktop.call("join", "POST", {}, roomKey);
    await waitFor(async () => (await roomNames(ada)).includes("Recipes"), "the room back on the first desktop");
    assert.deepEqual(await roomNames(stranger), []);
  });
});
