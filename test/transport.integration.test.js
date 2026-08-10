import { EventEmitter, once } from "node:events";
import { randomBytes } from "node:crypto";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { create } from "hyper-sdk";
import HyperswarmLAN from "hyperswarm-lan";
import { attachChatTransport } from "../transport.js";

class MemoryDiscovery extends EventEmitter {
  constructor(bus) {
    super();
    this.bus = bus;
    this.record = null;
    this.onPeer = null;
  }

  start(record, onPeer) {
    this.record = record;
    this.onPeer = onPeer;
    for (const peer of this.bus) {
      setImmediate(() => {
        onPeer(asService(peer.record));
        peer.onPeer(asService(record));
      });
    }
    this.bus.add(this);
  }

  update(record) {
    this.record = record;
    for (const peer of this.bus) {
      if (peer !== this) setImmediate(() => peer.onPeer(asService(record)));
    }
  }

  stop() { this.bus.delete(this); return Promise.resolve(); }
  destroy() { this.bus.delete(this); return Promise.resolve(); }
}

test("sends PeerChat frames beside Corestore replication over LAN", { timeout: 30_000 }, async (t) => {
  const suffix = randomBytes(6).toString("hex");
  const storageA = path.join(tmpdir(), `peerchat-lan-a-${suffix}`);
  const storageB = path.join(tmpdir(), `peerchat-lan-b-${suffix}`);
  const bus = new Set();
  const sdks = [];

  t.after(async () => {
    await Promise.allSettled(sdks.map((sdk) => sdk.close()));
    await Promise.allSettled([
      rm(storageA, { recursive: true, force: true }),
      rm(storageB, { recursive: true, force: true }),
    ]);
  });

  const sdkA = await create({ storage: storageA, swarmOpts: { bootstrap: [], port: 49931 } });
  const sdkB = await create({ storage: storageB, swarmOpts: { bootstrap: [], port: 49932 } });
  sdks.push(sdkA, sdkB);

  await HyperswarmLAN.attachHyperSDK(sdkA, {
    host: "127.0.0.1", port: 49933, allowLoopback: true,
    discovery: new MemoryDiscovery(bus),
  });
  await HyperswarmLAN.attachHyperSDK(sdkB, {
    host: "127.0.0.1", port: 49934, allowLoopback: true,
    discovery: new MemoryDiscovery(bus),
  });

  const connectionA = once(sdkA.swarm, "connection");
  const connectionB = once(sdkB.swarm, "connection");
  const topic = randomBytes(32);
  sdkA.join(topic);
  sdkB.join(topic);

  const [[socketA], [socketB]] = await Promise.all([connectionA, connectionB]);
  socketA.on("error", () => {});
  socketB.on("error", () => {});

  let resolveFrame;
  const frameReceived = new Promise((resolve) => { resolveFrame = resolve; });
  const transportA = attachChatTransport(socketA, () => {});
  const transportB = attachChatTransport(socketB, resolveFrame);
  assert.ok(transportA);
  assert.ok(transportB);

  transportA.send('{"type":"message","roomKey":"test"}\n');
  const frame = await Promise.race([
    frameReceived,
    new Promise((_, reject) => setTimeout(() => reject(new Error("chat frame timeout")), 5000)),
  ]);
  assert.equal(frame, '{"type":"message","roomKey":"test"}\n');
});

function asService(record) {
  return {
    ...record,
    referer: { address: "127.0.0.1" },
    addresses: ["127.0.0.1"],
  };
}
