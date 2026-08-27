// Two real peers on an isolated DHT testnet, joining by room key and
// exchanging an encrypted message. Guards the topic/key separation end to end:
// discovery must work, and knowing only the announced topic must not be enough
// to read anything.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "crypto";
import Hyperswarm from "hyperswarm";
import createTestnet from "hyperdht/testnet.js";
import b4a from "b4a";

import { deriveTopic, encryptMsg, decryptMsg } from "../p2p.js";

// Generous because CI runners are slow and discovery is a real network round
// trip, even on a loopback testnet.
const CONNECT_TIMEOUT_MS = 30_000;

function firstConnection(swarm) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("no peer connected in time")), CONNECT_TIMEOUT_MS);
    swarm.once("connection", (conn) => {
      clearTimeout(timer);
      conn.on("error", () => {});
      resolve(conn);
    });
  });
}

function nextMessage(conn) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("no message received in time")), CONNECT_TIMEOUT_MS);
    conn.once("data", (buf) => {
      clearTimeout(timer);
      resolve(JSON.parse(b4a.toString(buf)));
    });
  });
}

// Peers must announce one at a time. Joining both sides simultaneously leaves
// neither with a server record to look up yet, and discovery stalls.
async function joinInTurn(entries) {
  for (const [swarm, topic] of entries) {
    swarm.join(topic, { client: true, server: true });
    await swarm.flush();
  }
}

describe("two peers over an isolated DHT", () => {
  let testnet;
  const swarms = [];

  const makeSwarm = () => {
    const swarm = new Hyperswarm({ bootstrap: testnet.bootstrap });
    swarms.push(swarm);
    return swarm;
  };

  before(async () => {
    testnet = await createTestnet(3);
  });

  after(async () => {
    for (const swarm of swarms) await swarm.destroy();
    await testnet.destroy();
  });

  it("two peers sharing a room key find each other and exchange a message", async () => {
    const roomKey = randomBytes(32).toString("hex");
    const topic = deriveTopic(roomKey);

    const alice = makeSwarm();
    const bob = makeSwarm();

    const aliceConn = firstConnection(alice);
    const bobConn = firstConnection(bob);

    await joinInTurn([[alice, topic], [bob, topic]]);

    const [a, b] = await Promise.all([aliceConn, bobConn]);

    const sent = "meeting moved to 4pm";
    a.write(b4a.from(JSON.stringify({ roomKey, ...encryptMsg(sent, roomKey) })));

    const received = await nextMessage(b);
    assert.equal(decryptMsg(received.ct, received.iv, received.tag, roomKey), sent);
  });

  // A DHT node servicing the announce learns the topic. It can join the swarm
  // and receive traffic, but the room key is not recoverable from the topic,
  // so the payload stays closed.
  it("an observer who only has the topic connects but cannot decrypt", async () => {
    const roomKey = randomBytes(32).toString("hex");
    const topic = deriveTopic(roomKey);
    const observedTopicHex = topic.toString("hex");

    const member = makeSwarm();
    const observer = makeSwarm();

    const memberConn = firstConnection(member);
    const observerConn = firstConnection(observer);

    await joinInTurn([[member, topic], [observer, topic]]);

    const [m, o] = await Promise.all([memberConn, observerConn]);

    const secret = "account number is 55512";
    m.write(b4a.from(JSON.stringify(encryptMsg(secret, roomKey))));

    const seen = await nextMessage(o);

    // The observer has the ciphertext and the topic. That is all a DHT node gets.
    assert.ok(seen.ct && seen.iv && seen.tag);
    assert.notEqual(seen.ct, secret);
    assert.throws(() => decryptMsg(seen.ct, seen.iv, seen.tag, observedTopicHex));

    // And with the room key it opens, confirming the ciphertext was real.
    assert.equal(decryptMsg(seen.ct, seen.iv, seen.tag, roomKey), secret);
  });

  // Confirms the announced value actually changed. A build that still joined
  // the raw room key would connect here, and must not.
  it("does not connect to a peer still announcing the raw room key", async () => {
    const roomKey = randomBytes(32).toString("hex");

    const current = makeSwarm();
    const legacy = makeSwarm();

    let connected = false;
    current.on("connection", (conn) => {
      connected = true;
      conn.on("error", () => {});
    });

    await joinInTurn([
      [current, deriveTopic(roomKey)],
      [legacy, b4a.from(roomKey, "hex")],
    ]);

    await new Promise((resolve) => setTimeout(resolve, 5000));
    assert.equal(connected, false, "current build must not join the old topic");
  });
});
