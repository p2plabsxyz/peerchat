// Full-stack two-peer run: real Corestore, real Hyperswarm on an isolated DHT
// testnet, real p2p.js on both sides. Peer B goes offline, A sends, B restarts
// from the same storage and must receive the missed message.
// Heavy and network-real, so it only runs with PEERCHAT_E2E=1.
// Swarm deps load from the Desktop peersky tree: its hyperdht (6.31.x) has
// working testnet discovery; 6.33.x does not.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";

const DESKTOP = "/Users/akhileshthite/Desktop/peersky-browser/node_modules";
const SELF = fileURLToPath(import.meta.url);
const ROOM = "e2".repeat(32);
const M_OFF = "sent while you were offline";
const M_BACK = "reply after coming back";
const run = process.env.PEERCHAT_E2E === "1";

// ---- child mode ----------------------------------------------------------
if (process.env.E2E_ROLE === "peer") {
  const requireDesktop = createRequire(path.join(DESKTOP, "x.js"));
  const Corestore = requireDesktop("corestore");
  const Hyperswarm = requireDesktop("hyperswarm");
  const { initChat, handleChatRequest } = await import(pathToFileURL(path.join(path.dirname(SELF), "..", "p2p.js")));

  const dir = process.env.E2E_DIR;
  const [host, port] = process.env.E2E_BOOTSTRAP.split(":");
  const corestore = new Corestore(path.join(dir, "store"));
  await corestore.ready();
  const swarm = new Hyperswarm({ bootstrap: [{ host, port: Number(port) }] });
  swarm.on("connection", (c, info) => {
    process.stdout.write(JSON.stringify({ tag: "conn", topics: (info?.topics || []).length, client: !!info?.client }) + "\n");
  });
  const sdk = {
    publicKey: swarm.keyPair.publicKey,
    corestore: { get: (opts) => corestore.get(opts) },
    join: (t, o) => swarm.join(t, o),
    swarm,
  };
  initChat(sdk, { storagePath: path.join(dir, "chat.json") });

  const call = async (action, method, body, roomKey) => {
    const qs = `hyper://chat?action=${action}${roomKey ? `&roomKey=${roomKey}` : ""}`;
    const res = await handleChatRequest({ url: qs, method, json: async () => body ?? {} }, sdk);
    return JSON.parse(await res.text());
  };
  const out = (obj) => process.stdout.write(JSON.stringify(obj) + "\n");

  let buf = "";
  process.stdin.on("data", (d) => {
    buf += d.toString();
    const lines = buf.split("\n");
    buf = lines.pop();
    for (const line of lines) {
      if (!line.trim()) continue;
      const cmd = JSON.parse(line);
      (async () => {
        if (cmd.cmd === "join") out({ tag: "joined", result: await call("join", "POST", {}, cmd.roomKey) });
        else if (cmd.cmd === "send") out({ tag: "sent", result: await call("send", "POST", { message: cmd.message }, cmd.roomKey) });
        else if (cmd.cmd === "history") out({ tag: "history", messages: (await call("get-history", "GET", null, cmd.roomKey)).messages || [] });
        else if (cmd.cmd === "peers") out({ tag: "peers", status: await call("net-status", "GET") });
        else if (cmd.cmd === "exit") { await swarm.destroy().catch(() => {}); process.exit(0); }
      })().catch((e) => out({ tag: "error", message: e.message }));
    }
  });
  out({ tag: "ready" });
} else {
  // ---- parent mode -------------------------------------------------------
  describe("two real peers end to end", { skip: run ? false : "set PEERCHAT_E2E=1 to run" }, () => {
    it("delivers messages sent while a peer was offline, after it restarts", async () => {
      const requireDesktop = createRequire(path.join(DESKTOP, "x.js"));
      const createTestnet = requireDesktop("hyperdht/testnet.js");
      const testnet = await createTestnet(3);
      const bootstrap = `${testnet.bootstrap[0].host}:${testnet.bootstrap[0].port}`;
      const dirA = mkdtempSync(path.join(tmpdir(), "e2e-a-"));
      const dirB = mkdtempSync(path.join(tmpdir(), "e2e-b-"));
      const kids = [];

      const startPeer = (dir) => {
        const child = spawn(process.execPath, ["--experimental-detect-module", SELF], {
          env: { ...process.env, E2E_ROLE: "peer", E2E_DIR: dir, E2E_BOOTSTRAP: bootstrap },
          stdio: ["pipe", "pipe", "pipe"],
        });
        child.stderr.on("data", (d) => {
          const s = d.toString();
          if (!/MODULE_TYPELESS|Reparsing|To eliminate|trace-warnings/.test(s)) process.stderr.write("[child] " + s);
        });
        kids.push(child);
        const events = [];
        const waiters = [];
        let buf = "";
        child.stdout.on("data", (d) => {
          buf += d.toString();
          const lines = buf.split("\n");
          buf = lines.pop();
          for (const line of lines) {
            if (!line.startsWith("{")) continue;
            let obj; try { obj = JSON.parse(line); } catch { continue; }
            events.push(obj);
            for (let i = waiters.length - 1; i >= 0; i--) {
              if (waiters[i].match(obj)) waiters.splice(i, 1)[0].resolve(obj);
            }
          }
        });
        return {
          child,
          cmd: (obj) => child.stdin.write(JSON.stringify(obj) + "\n"),
          next: (match, label, ms = 30_000) => {
            const hit = events.find(match);
            if (hit) return Promise.resolve(hit);
            return new Promise((resolve, reject) => {
              const t = setTimeout(() => reject(new Error("timeout: " + label)), ms);
              waiters.push({ match, resolve: (o) => { clearTimeout(t); resolve(o); } });
            });
          },
          drain: () => { events.length = 0; },
        };
      };

      const pollHistory = async (peer, text, label, ms = 60_000) => {
        const until = Date.now() + ms;
        while (Date.now() < until) {
          peer.drain();
          peer.cmd({ cmd: "history", roomKey: ROOM });
          const h = await peer.next((o) => o.tag === "history", "history", 10_000);
          if (h.messages.some((m) => m.message === text)) return;
          await new Promise((r) => setTimeout(r, 1000));
        }
        throw new Error("timeout: " + label);
      };

      try {
        const A = startPeer(dirA);
        await A.next((o) => o.tag === "ready", "A ready");
        A.cmd({ cmd: "join", roomKey: ROOM });
        await A.next((o) => o.tag === "joined", "A joined");

        let B = startPeer(dirB);
        await B.next((o) => o.tag === "ready", "B ready");
        B.cmd({ cmd: "join", roomKey: ROOM });
        await B.next((o) => o.tag === "joined", "B joined");

        // Wait until they actually connect.
        const untilPeers = async (peer, label) => {
          for (let i = 0; i < 60; i++) {
            peer.drain();
            peer.cmd({ cmd: "peers" });
            const s = await peer.next((o) => o.tag === "peers", "peers", 10_000);
            if (s.status.peers.length >= 1) return;
            await new Promise((r) => setTimeout(r, 1000));
          }
          throw new Error("timeout: " + label);
        };
        await untilPeers(A, "A sees B");
        await untilPeers(B, "B sees A");

        // B goes offline.
        B.cmd({ cmd: "exit" });
        await new Promise((r) => B.child.on("exit", r));
        for (let i = 0; i < 60; i++) {
          A.drain();
          A.cmd({ cmd: "peers" });
          const s = await A.next((o) => o.tag === "peers", "peers", 10_000);
          if (s.status.peers.length === 0) break;
          await new Promise((r) => setTimeout(r, 1000));
        }

        // A sends while B is away.
        A.cmd({ cmd: "send", roomKey: ROOM, message: M_OFF });
        await A.next((o) => o.tag === "sent", "A sent offline message");

        // B restarts from the same storage and must catch up.
        B = startPeer(dirB);
        await B.next((o) => o.tag === "ready", "B2 ready");
        try {
          await pollHistory(B, M_OFF, "B received the missed message");
        } catch (e) {
          A.drain(); A.cmd({ cmd: "peers" });
          const sa = await A.next((o) => o.tag === "peers", "peers", 10_000).catch(() => null);
          B.drain(); B.cmd({ cmd: "peers" });
          const sb = await B.next((o) => o.tag === "peers", "peers", 10_000).catch(() => null);
          console.log("DIAG A:", JSON.stringify(sa?.status));
          console.log("DIAG B:", JSON.stringify(sb?.status));
          throw e;
        }

        // And the live path still works both ways.
        B.cmd({ cmd: "send", roomKey: ROOM, message: M_BACK });
        await B.next((o) => o.tag === "sent", "B replied");
        await pollHistory(A, M_BACK, "A received the reply");
      } finally {
        for (const k of kids) { try { k.kill("SIGKILL"); } catch {} }
        await testnet.destroy().catch(() => {});
        rmSync(dirA, { recursive: true, force: true });
        rmSync(dirB, { recursive: true, force: true });
      }
    });
  });
}
