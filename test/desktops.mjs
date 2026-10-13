// Several desktops in one process, each running its own copy of p2p.js, for
// tests where desktops talk to each other. p2p.js keeps its rooms, peers and
// counters at module level, so two desktops sharing one copy would share them.
// The load test's loader (load/desktop-loader.mjs) gives p2p.js?dev=x its own
// copy of every file in this folder that it imports.
import { register } from "node:module";
import { EventEmitter } from "node:events";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import crypto from "hypercore-crypto";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

register(pathToFileURL(path.join(ROOT, "test/load/desktop-loader.mjs")).href, import.meta.url, {
  data: { dir: pathToFileURL(ROOT + path.sep).href },
});

/** A fresh copy of p2p.js, as a desktop that starts up loads it. */
export function loadDesktop(tag) {
  return import(`${pathToFileURL(path.join(ROOT, "p2p.js")).href}?dev=${tag}`);
}

/** A desktop's PeerChat file: a name, no onboarding, and any rooms it is in. */
export function writeChatFile(storagePath, username, rooms = {}) {
  writeFileSync(storagePath, JSON.stringify({ v: 1, profile: { username }, peerProfiles: {}, pendingDMs: {}, rooms }));
}

// A room's log in memory, which only ever grows. Each start of a desktop gets
// its own view of it, as a store opened again would give, so a copy from
// before a restart is not still listening to what the new one writes.
class MemoryFeed extends EventEmitter {
  constructor(entries) {
    super();
    this.entries = entries;
  }

  get length() { return this.entries.length; }
  async ready() {}

  async append(entry) {
    this.entries.push(structuredClone(entry));
    this.emit("append");
  }

  async get(index) { return structuredClone(this.entries[index]); }
  async close() {}
}

/** A store for one start of a desktop, over logs that outlast it. */
export function memoryStore(logs, keyPair) {
  const views = new Map();
  return {
    get: ({ name }) => {
      if (!logs.has(name)) logs.set(name, []);
      if (!views.has(name)) views.set(name, new MemoryFeed(logs.get(name)));
      return views.get(name);
    },
    createKeyPair: async (name) => (name === "noise" ? keyPair : crypto.keyPair()),
  };
}

/** handleChatRequest as the page calls it, answering with the parsed body. */
export function chatCaller(mod, sdk) {
  return async (action, method, body, roomKey) => {
    const url = `hyper://chat?action=${action}${roomKey ? `&roomKey=${roomKey}` : ""}`;
    const res = await mod.handleChatRequest({ url, method, json: async () => body ?? {} }, sdk);
    return JSON.parse(await res.text());
  };
}
