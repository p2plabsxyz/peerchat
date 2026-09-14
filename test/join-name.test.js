// A join announced before onboarding carries the peer id as the display name,
// and every peer writes that into its feed permanently ("7e325e28 joined").
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";

import { handleChatRequest, initChat } from "../p2p.js";

const ROOM = "aa".repeat(32);

const swarm = new EventEmitter();
swarm.flush = async () => {};
function fakeFeed() {
  const feed = new EventEmitter();
  const entries = [];
  feed.length = 0;
  feed.ready = async () => {};
  feed.get = async (i) => entries[i];
  feed.append = async (e) => { entries.push(e); feed.length = entries.length; feed.emit("append"); };
  return feed;
}
const sdk = { publicKey: Buffer.alloc(32, 7), corestore: { get: () => fakeFeed() }, join() {}, swarm };

async function call(action, method, body, roomKey) {
  const qs = `hyper://chat?action=${action}${roomKey ? `&roomKey=${roomKey}` : ""}`;
  const res = await handleChatRequest({ url: qs, method, json: async () => body ?? {} }, sdk);
  return JSON.parse(await res.text());
}

const systemTexts = async () =>
  ((await call("get-history", "GET", null, ROOM)).messages || [])
    .filter((m) => m.type === "system")
    .map((m) => m.text);

describe("join announcements use a display name", () => {
  let dir;

  before(async () => {
    dir = mkdtempSync(path.join(tmpdir(), "peerchat-joinname-"));
    // No profile yet: exactly the state onboarding joins the pre-joined room in.
    writeFileSync(path.join(dir, "chat.json"), JSON.stringify({
      v: 1, profile: {}, peerProfiles: {}, pendingDMs: {}, rooms: {},
    }));
    initChat(sdk, { storagePath: path.join(dir, "chat.json") });
    await new Promise((r) => setTimeout(r, 200));
  });

  after(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });

  it("writes no join message while the user has no name", async () => {
    await call("join", "POST", {}, ROOM);
    await new Promise((r) => setTimeout(r, 100));
    assert.deepEqual(await systemTexts(), [], "a nameless join must not be announced");
  });

  it("announces the join once onboarding sets a name", async () => {
    await call("save-profile", "POST", { username: "Akhilesh" });
    await new Promise((r) => setTimeout(r, 150));
    assert.deepEqual(await systemTexts(), ["Akhilesh joined"]);
  });

  it("never falls back to the peer id", async () => {
    for (const text of await systemTexts()) {
      assert.ok(!/^[a-f0-9]{8} joined$/.test(text), `peer id leaked as a name: ${text}`);
    }
  });

  it("does not re-announce on later profile edits", async () => {
    await call("save-profile", "POST", { username: "Akhilesh", bio: "updated" });
    await new Promise((r) => setTimeout(r, 150));
    assert.deepEqual(await systemTexts(), ["Akhilesh joined"], "join is announced once per room");
  });
});
