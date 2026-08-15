import { once } from "node:events";
import { randomBytes } from "node:crypto";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { create } from "hyper-sdk";
import HyperDHTmDNS from "hyperdht-mdns";
import { attachChatTransport } from "../transport.js";

class MemoryAdapter {
  constructor(bus) {
    this.bus = bus;
    this.record = null;
    this.handlers = null;
  }

  browse(query, handlers) {
    this.query = query;
    this.handlers = handlers;
    return { stop: () => { this.handlers = null; } };
  }

  advertise(record) {
    this.record = record;
    for (const peer of this.bus) {
      setImmediate(() => {
        this.handlers?.onService(asService(peer.record));
        peer.handlers?.onService(asService(record));
      });
    }
    this.bus.add(this);
    return {
      stop: () => {
        if (this.record === record) this.bus.delete(this);
      },
    };
  }
}

test("reopens PeerChat transport and accepts replayed frames after LAN socket loss", { timeout: 30_000 }, async (t) => {
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

  await HyperDHTmDNS.attachHyperSDK(sdkA, {
    host: "127.0.0.1", port: 49933, allowLoopback: true,
    adapter: new MemoryAdapter(bus),
  });
  await HyperDHTmDNS.attachHyperSDK(sdkB, {
    host: "127.0.0.1", port: 49934, allowLoopback: true,
    adapter: new MemoryAdapter(bus),
  });

  const connectionA = once(sdkA.swarm, "connection");
  const connectionB = once(sdkB.swarm, "connection");
  const topic = randomBytes(32);
  sdkA.join(topic);
  sdkB.join(topic);

  let [[socketA], [socketB]] = await Promise.all([connectionA, connectionB]);
  socketA.on("error", () => {});
  socketB.on("error", () => {});

  let frameReceived = receiveFrame();
  const transportA = attachChatTransport(socketA, () => {});
  const transportB = attachChatTransport(socketB, frameReceived.resolve);
  assert.ok(transportA);
  assert.ok(transportB);
  assert.deepEqual(await Promise.all([transportA.ready(), transportB.ready()]), [true, true]);

  transportA.send('{"type":"message","roomKey":"test"}\n');
  const frame = await withTimeout(frameReceived.promise, "initial chat frame timeout");
  assert.equal(frame, '{"type":"message","roomKey":"test"}\n');

  const nextConnectionA = once(sdkA.swarm, "connection");
  const nextConnectionB = once(sdkB.swarm, "connection");
  socketA.destroy();
  assert.equal(transportA.send('{"type":"message","roomKey":"offline"}\n'), false);

  [[socketA], [socketB]] = await Promise.all([nextConnectionA, nextConnectionB]);
  socketA.on("error", () => {});
  socketB.on("error", () => {});

  frameReceived = receiveFrame();
  const reconnectedA = attachChatTransport(socketA, () => {});
  const reconnectedB = attachChatTransport(socketB, frameReceived.resolve);
  assert.deepEqual(await Promise.all([reconnectedA.ready(), reconnectedB.ready()]), [true, true]);

  const replayed = '{"type":"sync","roomKey":"test","id":"offline-message"}\n';
  reconnectedA.send(replayed);
  assert.equal(await withTimeout(frameReceived.promise, "replayed chat frame timeout"), replayed);
});

function receiveFrame() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function withTimeout(promise, message) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(message)), 5000)),
  ]);
}

function asService(record) {
  return {
    ...record,
    referer: { address: "127.0.0.1" },
    addresses: ["127.0.0.1"],
  };
}
