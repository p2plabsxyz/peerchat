// A desktop keeps the signature on a message it got from another device, and
// hands the message on in its history just as it came, so a desktop that never
// met the author still takes it as the author's. A copy whose text was changed
// on the way no longer fits the signature, and is turned away.
//
// Writer, Relay and Late are desktops, each running its own copy of p2p.js
// (see desktops.mjs), joined by secret-stream connections over loopback.
// Meddler is a test client in the room that changes the text before handing
// the message on.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import b4a from "b4a";
import crypto from "hypercore-crypto";

import { attachChatTransport } from "../transport.js";
import { chainSecretAt, messageKeyAt } from "../lib/key-chain.js";
import { decodeMessagePayload, encodeMessagePayload } from "../lib/link-preview.js";
import { readSignedMessage, signMessage } from "../lib/message-signature.js";
import { securePair, topicsFrame, wireRoom } from "./helpers.mjs";
import { chatCaller, loadDesktop, memoryStore, writeChatFile } from "./desktops.mjs";

const TEXT = "The meeting moved to room 4";
const CHANGED = "The meeting is cancelled";
const OWN = "Meddler says hello";
// p2p.js saves two seconds after a change. The folder goes after that.
const SAVE_DELAY_MS = 2_500;
const SIGNED = ["ak", "h", "as"];
const SEALED = ["ct", "iv", "tag", "e", "ts"];
const hex = (buf) => b4a.toString(buf, "hex");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let dir = "";
let roomKey = "";
let topic = "";
let writer, relay, late;
// The Writer's own copy of its message, as it was sent.
let original = null;
const links = [];

async function startDesktop(name, rooms) {
  const keyPair = crypto.keyPair();
  const storagePath = path.join(dir, `${name}.json`);
  writeChatFile(storagePath, name, rooms);
  const swarm = new EventEmitter();
  swarm.flush = async () => {};
  const logs = new Map();
  const sdk = { publicKey: keyPair.publicKey, swarm, corestore: memoryStore(logs, keyPair), join() {}, leave: async () => {} };
  const mod = await loadDesktop(`signed-history-${name}`);
  mod.initChat(sdk, { storagePath, keyPair });
  return { name, keyPair, id: hex(keyPair.publicKey).slice(0, 8), key: hex(keyPair.publicKey), storagePath, swarm, logs, call: chatCaller(mod, sdk) };
}

// In the room since a minute ago, as if joined then, so what is said from now
// on is theirs to read.
function joinedRoom(joinedAt) {
  return {
    [roomKey]: {
      roomKey, isHost: false, name: `${roomKey.slice(0, 8)}...`, bio: "", createdAt: joinedAt, joinedAt,
      createdBy: "", createdByName: "", isPinned: false, isMuted: false, unreadCount: 0, unreadMentions: 0,
      lastMessage: null, members: {}, creatorKey: "", bans: [],
    },
  };
}

// A connection between two desktops, as Hyperswarm hands it over.
async function link(from, to) {
  const pair = await securePair({ clientKeyPair: from.keyPair, serverKeyPair: to.keyPair });
  links.push(pair);
  from.swarm.emit("connection", pair.clientStream, { topics: [Buffer.from(topic, "hex")] });
  to.swarm.emit("connection", pair.serverStream, {});
  return pair;
}

async function waitFor(check, what) {
  for (let i = 0; i < 200; i++) {
    if (await check()) return;
    await sleep(50);
  }
  throw new Error(`Timed out waiting for ${what}`);
}

async function roomPeers(device) {
  const { peers } = await device.call("net-status", "GET");
  return peers.filter((peer) => peer.rooms.includes(roomKey)).map((peer) => peer.id);
}

async function shown(device, id) {
  const { messages = [] } = await device.call("get-history", "GET", null, roomKey);
  return messages.find((message) => message.id === id && message.type !== "system");
}

const storedCopy = (device, id) => (device.logs.get(`chat-${roomKey}`) || []).find((entry) => entry.id === id);

function seal(text, key) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ct = cipher.update(text, "utf8", "hex") + cipher.final("hex");
  return { ct, iv: iv.toString("hex"), tag: cipher.getAuthTag().toString("hex") };
}

function open(entry, key) {
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(entry.iv, "hex"));
  decipher.setAuthTag(Buffer.from(entry.tag, "hex"));
  return decipher.update(entry.ct, "hex", "utf8") + decipher.final("utf8");
}

// Somebody in the room, with its key and key chain, who is not a desktop
// running p2p.js and does what it likes with what it hands on.
async function connectMeddler(to) {
  const keyPair = crypto.keyPair();
  const pair = await securePair({ clientKeyPair: keyPair, serverKeyPair: to.keyPair });
  links.push(pair);
  const frames = [];
  let buffer = "";
  let transport;
  to.swarm.emit("connection", pair.serverStream, {});
  await new Promise((opened) => {
    transport = attachChatTransport(pair.clientStream, (raw) => {
      buffer += raw.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop();
      for (const line of lines) {
        if (line) { try { frames.push(JSON.parse(line)); } catch {} }
      }
    }, { onopen: opened });
  });
  transport.send(topicsFrame(pair.clientStream, [roomKey]));
  await waitFor(() => frames.some((frame) => frame.type === "join" && frame.room === topic), `${to.name} to let Meddler into the room`);
  return {
    keyPair,
    id: hex(keyPair.publicKey).slice(0, 8),
    send: (frame) => transport.send(JSON.stringify({ ...frame, room: topic }) + "\n"),
  };
}

describe("a signed message handed on in history", () => {
  before(async () => {
    dir = mkdtempSync(path.join(tmpdir(), "peerchat-signed-history-"));
    writer = await startDesktop("Writer", {});
    roomKey = (await writer.call("create-key", "POST", { name: "Signed history" })).roomKey;
    topic = wireRoom(roomKey);
    await writer.call("join", "POST", {}, roomKey);

    const joinedAt = Date.now() - 60_000;
    relay = await startDesktop("Relay", joinedRoom(joinedAt));
    late = await startDesktop("Late", joinedRoom(joinedAt));
    // Already in the room, so this only waits for it to be open.
    for (const device of [relay, late]) await device.call("join", "POST", {}, roomKey);

    await link(writer, relay);
    await waitFor(async () => {
      const { rooms } = await relay.call("get-rooms", "GET");
      return (await roomPeers(writer)).includes(relay.id) && (await roomPeers(relay)).includes(writer.id) &&
        rooms.find((room) => room.roomKey === roomKey)?.rotates === true;
    }, "Writer and Relay to be in the room together, with its key chain");
  });

  after(async () => {
    for (const pair of links) await pair.close().catch(() => {});
    await sleep(SAVE_DELAY_MS);
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("keeps the author's signature on a message it got from them, exactly as it came", async () => {
    const sent = (await writer.call("send", "POST", { message: TEXT }, roomKey)).sent;
    assert.ok(sent?.id);
    await waitFor(() => shown(relay, sent.id), "Relay to get the message");

    original = storedCopy(writer, sent.id);
    const kept = storedCopy(relay, sent.id);
    assert.equal(kept.ak, writer.key);
    for (const field of [...SIGNED, ...SEALED]) assert.equal(kept[field], original[field], `Relay kept ${field} as it came`);
    assert.equal(readSignedMessage(kept, topic)?.authorId, writer.id);
    const message = await shown(relay, sent.id);
    assert.equal(message.message, TEXT);
    assert.equal(message.sender, writer.id);
    assert.equal(message.senderName, "Writer");

    // Writer goes offline for the rest of the test.
    await links[0].close();
    await waitFor(async () => (await roomPeers(relay)).length === 0, "Relay to see Writer go");
  });

  it("turns away a copy whose text was changed on the way", async () => {
    const meddler = await connectMeddler(late);
    const { chain } = JSON.parse(readFileSync(writer.storagePath, "utf8")).rooms[roomKey];
    const hourKey = messageKeyAt(chain, original.e);

    // The hour's key, as anyone in the room passes it on, so Late can read
    // what is sealed with it.
    meddler.send({ type: "room-chain", e: original.e, secret: chainSecretAt(chain, original.e) });
    // The message as Relay keeps it, opened, its text changed and sealed
    // again with the same key. Its id, header and signature stay.
    const copy = storedCopy(relay, original.id);
    const payload = decodeMessagePayload(open(copy, hourKey));
    assert.equal(payload.text, TEXT);
    meddler.send({ type: "sync", ...copy, ...seal(encodeMessagePayload(CHANGED, payload.preview), hourKey) });
    // And one of its own, signed by itself, which Late takes. Frames are read
    // in order, so once this shows the changed copy has been dealt with.
    const id = randomBytes(16).toString("hex");
    const ts = Date.now();
    const sealed = seal(OWN, hourKey);
    meddler.send({
      type: "sync", id, sender: meddler.id, sn: "Meddler", ...sealed, e: original.e, ts,
      ...signMessage({ topic, id, ts, e: original.e, sn: "Meddler" }, sealed, meddler.keyPair),
    });
    await waitFor(() => shown(late, id), "Late to take Meddler's own message");
    assert.equal((await shown(late, id)).message, OWN);

    assert.equal(await shown(late, original.id), undefined);
    assert.equal(storedCopy(late, original.id), undefined);
  });

  it("hands the message on in its history, and a desktop that never met the author takes it as theirs", async () => {
    await link(late, relay);
    await waitFor(() => shown(late, original.id), "Late to get the message from Relay");

    const message = await shown(late, original.id);
    assert.equal(message.message, TEXT);
    assert.equal(message.sender, writer.id);
    assert.equal(message.senderName, "Writer");
    // Kept as it came here too, so Late can hand it on in turn.
    const kept = storedCopy(late, original.id);
    for (const field of [...SIGNED, ...SEALED]) assert.equal(kept[field], original[field], `Late kept ${field} as it came`);
    assert.equal(readSignedMessage(kept, topic)?.authorId, writer.id);
  });
});
