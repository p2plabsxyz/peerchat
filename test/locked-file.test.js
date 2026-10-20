// The PeerChat file on a desktop: room keys were locked one by one, but each
// was also its room's name in the list, in the clear, and a room's hourly key
// chain was not locked at all. Now the whole file is locked with the system's
// safe storage, in the form PeerSky's own locked files take.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { loadDesktop } from "./desktops.mjs";

const ROOM = "ab".repeat(32);
const CHAIN_SECRET = "cd".repeat(32);
const LINK_KEY = "ef".repeat(32);

// Stands in for the Keychain, DPAPI or the keyring: what it locks only it
// opens. Each "computer" has a secret of its own.
function safeStorage(secret = "this-computer", backend = "keychain") {
  const pad = Buffer.from(secret);
  const xor = (bytes) => Buffer.from(bytes.map((b, i) => b ^ pad[i % pad.length]));
  return {
    isEncryptionAvailable: () => true,
    getSelectedStorageBackend: () => backend,
    encryptString: (text) => Buffer.concat([Buffer.from("v10"), xor(Buffer.from(text, "utf8"))]),
    decryptString: (bytes) => {
      const body = xor(bytes.subarray(3)).toString("utf8");
      if (bytes.subarray(0, 3).toString() !== "v10" || !body.startsWith("{") && !/^[0-9a-f]+$/.test(body)) throw new Error("Not this computer's");
      return body;
    },
  };
}

function fakeSdk() {
  const swarm = new EventEmitter();
  swarm.flush = async () => {};
  const feed = () => {
    const f = new EventEmitter();
    f.length = 0;
    f.ready = async () => {};
    f.get = async () => { throw new Error("empty"); };
    f.append = async () => { f.length++; };
    return f;
  };
  return { publicKey: Buffer.alloc(32, 7), corestore: { get: () => feed() }, join() {}, swarm };
}

function chatFile(dir) {
  const storagePath = path.join(dir, "peersky-chat-rooms.json");
  writeFileSync(storagePath, JSON.stringify({
    v: 1,
    profile: { username: "ada" },
    peerProfiles: {},
    pendingDMs: {},
    link: { key: LINK_KEY, origin: "desktop", labels: ["mobile"] },
    rooms: {
      [ROOM]: {
        roomKey: ROOM, name: "Trip planning", isHost: true, createdAt: 1, members: {},
        chain: { first: 1, secret: CHAIN_SECRET },
      },
    },
  }));
  return storagePath;
}

let n = 0;
async function start(storagePath, store) {
  const mod = await loadDesktop(`locked-${++n}`);
  mod.initChat(fakeSdk(), { storagePath, ...(store ? { safeStorage: store } : {}) });
  return mod;
}

async function rooms(mod, sdk = fakeSdk()) {
  const res = await mod.handleChatRequest({ url: "hyper://chat?action=get-rooms", method: "GET", json: async () => ({}) }, sdk);
  const body = JSON.parse(await res.text());
  return Array.isArray(body.rooms) ? body.rooms : Object.values(body.rooms || body);
}

describe("the PeerChat file, locked whole", () => {
  it("locks a file from before at the first start: no room key, key chain, link or room name shows", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "peerchat-locked-"));
    const storagePath = chatFile(dir);
    const store = safeStorage();
    await start(storagePath, store);
    const onDisk = readFileSync(storagePath, "utf8");
    assert.ok(JSON.parse(onDisk)["peersky-sealed"] === 1);
    for (const secret of [ROOM, CHAIN_SECRET, LINK_KEY, "Trip planning"]) assert.ok(!onDisk.includes(secret), secret);

    // The next start opens it, every room and the link as they were.
    const again = await start(storagePath, store);
    const list = await rooms(again);
    assert.equal(list.length, 1);
    assert.equal(list[0].roomKey, ROOM);
    assert.equal(list[0].name, "Trip planning");
  });

  it("keeps nothing locked twice inside, so a backup carries it to another computer whole", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "peerchat-locked-"));
    const storagePath = chatFile(dir);
    const store = safeStorage();
    await start(storagePath, store);
    const sealed = JSON.parse(readFileSync(storagePath, "utf8"));
    // What PeerSky's backup packs: the file opened with this computer's lock.
    const inside = JSON.parse(store.decryptString(Buffer.from(sealed.data, "base64")));
    assert.equal(inside.plain, true);
    assert.equal(inside.link.key, LINK_KEY);
    assert.equal(inside.rooms[ROOM].roomKey, ROOM);

    // Restored on another computer, it opens there and is locked with its lock.
    writeFileSync(storagePath, JSON.stringify(inside));
    const other = safeStorage("another-computer");
    const there = await start(storagePath, other);
    assert.equal((await rooms(there))[0].roomKey, ROOM);
    const relocked = JSON.parse(readFileSync(storagePath, "utf8"));
    assert.equal(JSON.parse(other.decryptString(Buffer.from(relocked.data, "base64"))).rooms[ROOM].roomKey, ROOM);
  });

  it("never writes over a locked file this computer cannot open, which would lose every room", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "peerchat-locked-"));
    const storagePath = chatFile(dir);
    await start(storagePath, safeStorage());
    const before = readFileSync(storagePath, "utf8");
    const elsewhere = await start(storagePath, safeStorage("another-computer"));
    const res = await elsewhere.handleChatRequest({ url: "hyper://chat?action=create-key", method: "POST", json: async () => ({ name: "New" }) }, fakeSdk());
    await res.text();
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(readFileSync(storagePath, "utf8"), before);
  });

  it("writes the file as before where the system has no real safe storage", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "peerchat-locked-"));
    const storagePath = chatFile(dir);
    await start(storagePath, safeStorage("basic", "basic_text"));
    const onDisk = JSON.parse(readFileSync(storagePath, "utf8"));
    assert.equal(onDisk["peersky-sealed"], undefined);
    assert.ok(onDisk.rooms[ROOM]);
  });

  it("reads a file whose keys were locked one by one, as every desktop has now", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "peerchat-locked-"));
    const storagePath = path.join(dir, "peersky-chat-rooms.json");
    const store = safeStorage();
    const lockOne = (v) => store.encryptString(v).toString("base64");
    writeFileSync(storagePath, JSON.stringify({
      v: 1, profile: { username: "ada" }, peerProfiles: {}, pendingDMs: {},
      link: { key: lockOne(LINK_KEY), origin: "desktop", labels: [] },
      rooms: { [ROOM]: { roomKey: lockOne(ROOM), name: "Trip planning", isHost: true, createdAt: 1, members: {} } },
    }));
    const mod = await start(storagePath, store);
    assert.equal((await rooms(mod))[0].roomKey, ROOM);
    const inside = JSON.parse(store.decryptString(Buffer.from(JSON.parse(readFileSync(storagePath, "utf8")).data, "base64")));
    assert.equal(inside.rooms[ROOM].roomKey, ROOM);
    assert.equal(inside.link.key, LINK_KEY);
  });
});
