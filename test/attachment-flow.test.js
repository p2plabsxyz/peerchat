// The fileEnc flag is what tells a renderer to decrypt; it must survive the
// send handler, the feed, and history reads exactly as sent.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";

import { handleChatRequest, initChat } from "../p2p.js";

const ROOM = "ab".repeat(32);
const URL = "hyper://ff".repeat(1) + "e".repeat(50) + "/1757400000000-0123456789abcdef.bin";

function fakeFeed() {
  const entries = [];
  const feed = new EventEmitter();
  feed.length = 0;
  feed.ready = async () => {};
  feed.get = async (i) => entries[i];
  feed.append = async (entry) => { entries.push(entry); feed.length = entries.length; feed.emit("append"); };
  return feed;
}
const swarm = new EventEmitter();
swarm.flush = async () => {};
const sdk = { publicKey: Buffer.alloc(32, 9), corestore: { get: () => fakeFeed() }, join() {}, swarm };

const call = async (action, method, body, roomKey) => {
  const qs = `hyper://chat?action=${action}${roomKey ? `&roomKey=${roomKey}` : ""}`;
  return JSON.parse(await (await handleChatRequest({ url: qs, method, json: async () => body ?? {} }, sdk)).text());
};
const history = async () => (await call("get-history", "GET", null, ROOM)).messages;

describe("encrypted attachment messages", () => {
  let dir;
  before(async () => {
    dir = mkdtempSync(path.join(tmpdir(), "peerchat-attach-"));
    writeFileSync(path.join(dir, "chat.json"), JSON.stringify({
      v: 1, profile: { username: "tester" }, peerProfiles: {}, pendingDMs: {},
      rooms: { [ROOM]: { roomKey: ROOM, name: "Room", isHost: true, bio: "", link: "", avatar: null, createdAt: Date.now(), createdBy: "x", createdByName: "me", isPinned: false, isMuted: false, unreadCount: 0, unreadMentions: 0, lastMessage: null, members: {} } },
    }));
    initChat(sdk, { storagePath: path.join(dir, "chat.json") });
    await new Promise((r) => setTimeout(r, 100));
  });
  after(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });

  it("keeps fileEnc through send, the feed, and history", async () => {
    const res = await call("send", "POST", { message: URL, fileName: "report.pdf", fileSize: 12345, fileEnc: true }, ROOM);
    assert.equal(res.sent.fileEnc, true);
    const msg = (await history()).find((m) => m.id === res.sent.id);
    assert.equal(msg.fileEnc, true);
    assert.equal(msg.fileName, "report.pdf");
    assert.equal(msg.message, URL);
  });

  it("leaves legacy attachments unflagged so they render as before", async () => {
    const res = await call("send", "POST", { message: URL, fileName: "old.png", fileSize: 10 }, ROOM);
    assert.equal(res.sent.fileEnc, undefined);
    assert.equal((await history()).find((m) => m.id === res.sent.id).fileEnc, undefined);
  });

  it("ignores fileEnc without a file", async () => {
    const res = await call("send", "POST", { message: "just text", fileEnc: true }, ROOM);
    assert.equal(res.sent.fileEnc, undefined);
  });
});
