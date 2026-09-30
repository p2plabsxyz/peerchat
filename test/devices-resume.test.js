// PeerSky closes the stores for a backup or a transfer and then makes the SDK
// again. PeerChat has to join its rooms again on the new one, with feeds from
// the new store, or it goes quiet until a restart.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";

import { deriveTopic, handleChatRequest, initChat } from "../p2p.js";

const ROOM = "aa".repeat(32);

function fakeSdk(byte) {
  const swarm = new EventEmitter();
  swarm.flush = async () => {};
  const sdk = {
    publicKey: Buffer.alloc(32, byte),
    joined: [],
    appended: 0,
    swarm,
    corestore: {
      get: () => {
        const feed = new EventEmitter();
        feed.length = 0;
        feed.ready = async () => {};
        feed.get = async () => { throw new Error("empty"); };
        feed.append = async () => { sdk.appended++; feed.length++; };
        return feed;
      },
    },
    join(topic) { sdk.joined.push(topic.toString("hex")); },
  };
  return sdk;
}

describe("the SDK made again after a backup", () => {
  let dir;
  const first = fakeSdk(7);
  const second = fakeSdk(7);

  before(async () => {
    dir = mkdtempSync(path.join(tmpdir(), "peerchat-resume-"));
    const storagePath = path.join(dir, "chat.json");
    writeFileSync(storagePath, JSON.stringify({
      v: 1, profile: { username: "ada", at: 1 }, peerProfiles: {}, pendingDMs: {},
      rooms: { [ROOM]: { roomKey: ROOM, name: "Room", isHost: true, createdAt: 1, createdBy: "07070707", members: {} } },
    }));
    initChat(first, { storagePath });
    await new Promise((r) => setTimeout(r, 200));
    initChat(second, { storagePath });
    await new Promise((r) => setTimeout(r, 200));
  });

  after(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("joins every room again on the new one", () => {
    const topic = deriveTopic(ROOM).toString("hex");
    assert.ok(first.joined.includes(topic));
    assert.ok(second.joined.includes(topic));
  });

  it("writes to the new store, not the closed one", async () => {
    const before = first.appended;
    const res = await handleChatRequest({
      url: `hyper://chat?action=send&roomKey=${ROOM}`,
      method: "POST",
      json: async () => ({ message: "after the backup" }),
    }, second);
    assert.equal(res.status, 200);
    assert.equal(first.appended, before);
    assert.ok(second.appended > 0);
  });
});
