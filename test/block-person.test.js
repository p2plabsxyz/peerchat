// Blocked on one device, the person's other desktop sent the request straight
// back. A block covers every device that proved it is that person's, as a
// removal from a room does. Mirrors peersky-mobile.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";

import { handleChatRequest, initChat } from "../p2p.js";

const PERSON = "ab".repeat(32);
const swarm = new EventEmitter();
swarm.flush = async () => {};
const sdk = { publicKey: Buffer.alloc(32, 3), corestore: { get: () => new EventEmitter() }, join() {}, async leave() {}, swarm };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function request(action, method, body) {
  const res = await handleChatRequest({ url: `hyper://chat?action=${action}`, method, json: async () => body ?? {} }, sdk);
  return { status: res.status, body: JSON.parse(await res.text()) };
}

describe("blocking somebody", () => {
  let dir;

  before(async () => {
    dir = mkdtempSync(path.join(tmpdir(), "peerchat-block-person-"));
    writeFileSync(path.join(dir, "chat.json"), JSON.stringify({
      v: 1, profile: { username: "Test Cai", bio: "", at: 1000 }, rooms: {},
      peerProfiles: {
        a1a1a1a1: { username: "Test Ana", person: PERSON, updatedAt: 1 },
        a2a2a2a2: { username: "Test Ana@desktop", person: PERSON, updatedAt: 1 },
        b3b3b3b3: { username: "Test Ben", updatedAt: 1 },
      },
      pendingDMs: {
        ["cd".repeat(32)]: { roomKey: "cd".repeat(32), fromId: "a2a2a2a2", fromUsername: "Test Ana@desktop", receivedAt: Date.now() },
      },
    }));
    initChat(sdk, { storagePath: path.join(dir, "chat.json") });
    await sleep(200);
  });

  after(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });

  it("blocks every device of the person, and takes the request from their other one", async () => {
    const blocked = await request("block-peer", "POST", { peerId: "a1a1a1a1", username: "Test Ana" });
    assert.equal(blocked.body.blockedPeers[0].person, PERSON);
    assert.deepEqual(blocked.body.pendingDMs, {});
    const other = await request("join-dm", "POST", { toId: "a2a2a2a2", toUsername: "Test Ana@desktop" });
    assert.equal(other.status, 403);
    assert.match(other.body.error, /Unblock this person/);
  });

  it("leaves somebody else alone, and keeps the block across a restart", async () => {
    const ben = await request("join-dm", "POST", { toId: "b3b3b3b3", toUsername: "Test Ben" });
    assert.equal(ben.status, 200);
    await sleep(1200);
    const saved = JSON.parse(readFileSync(path.join(dir, "chat.json"), "utf8"));
    assert.equal(Object.values(saved.blockedPeers)[0].person, PERSON);
  });

  it("lets every device back in when unblocked", async () => {
    await request("unblock-peer", "POST", { peerId: "a1a1a1a1" });
    const other = await request("join-dm", "POST", { toId: "a2a2a2a2", toUsername: "Test Ana@desktop" });
    assert.equal(other.status, 200);
  });
});
