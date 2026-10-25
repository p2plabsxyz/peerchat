// Turning Sounds off in PeerChat settings lasted until the next start: the
// switch was saved nowhere, so every start and reload turned sounds back on.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";

import { handleChatRequest, initChat } from "../p2p.js";

const swarm = new EventEmitter();
swarm.flush = async () => {};
const sdk = { publicKey: Buffer.alloc(32, 9), corestore: { get: () => new EventEmitter() }, join() {}, swarm };

async function call(action, method, body) {
  const res = await handleChatRequest({ url: `hyper://chat?action=${action}`, method, json: async () => body ?? {} }, sdk);
  return JSON.parse(await res.text());
}

describe("PeerChat settings", () => {
  let dir;

  before(async () => {
    dir = mkdtempSync(path.join(tmpdir(), "peerchat-settings-"));
    writeFileSync(path.join(dir, "chat.json"), JSON.stringify({ v: 1, profile: {}, peerProfiles: {}, pendingDMs: {}, rooms: {} }));
    initChat(sdk, { storagePath: path.join(dir, "chat.json") });
    await new Promise((r) => setTimeout(r, 200));
  });

  after(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });

  it("start with Sounds on", async () => {
    await call("save-profile", "POST", { username: "Test Ana" });
    assert.equal((await call("get-profile", "GET")).sounds, true);
  });

  it("keep Sounds off once it is turned off", async () => {
    await call("save-profile", "POST", { username: "Test Ana", sounds: false, notifications: true, linkPreview: true });
    assert.equal((await call("get-profile", "GET")).sounds, false);
    // A later save that does not touch the switch leaves it off.
    await call("save-profile", "POST", { username: "Test Ana", bio: "Test bio" });
    assert.equal((await call("get-profile", "GET")).sounds, false);
  });

  it("read Sounds back on start and send it from the settings form", () => {
    const app = readFileSync(new URL("../app.js", import.meta.url), "utf8");
    assert.match(app, /if \(!profile\.username\) \{ showOnboarding\(\); return; \}\s+S\.profile = profile;\s+S\.settings\.sounds = profile\.sounds \?\? true;/);
    assert.match(app, /const body = \{ username, bio: \$\("set-bio"\)\.value\.trim\(\), notifications, linkPreview, sounds \};/);
  });
});
