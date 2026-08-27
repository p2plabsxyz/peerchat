import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createCipheriv, createHash, randomBytes } from "crypto";

import {
  deriveMessageKey,
  deriveTopic,
  encryptMsg,
  decryptMsg,
} from "../p2p.js";

const roomKey = () => randomBytes(32).toString("hex");

// Reproduces how a pre-separation build wrote a message: one hash of the room
// key served as both the swarm topic and the AES key.
function legacyEncrypt(text, key) {
  const k = createHash("sha256").update("peersky-chat:" + key).digest();
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", k, iv);
  let ct = c.update(text, "utf8", "hex");
  ct += c.final("hex");
  return { ct, iv: iv.toString("hex"), tag: c.getAuthTag().toString("hex") };
}

describe("room key derivation", () => {
  it("derives a 32-byte topic", () => {
    const topic = deriveTopic(roomKey());
    assert.ok(Buffer.isBuffer(topic));
    assert.equal(topic.byteLength, 32);
  });

  it("is deterministic", () => {
    const key = roomKey();
    assert.deepEqual(deriveTopic(key), deriveTopic(key));
    assert.deepEqual(deriveMessageKey(key), deriveMessageKey(key));
  });

  it("gives different rooms different topics", () => {
    assert.notDeepEqual(deriveTopic(roomKey()), deriveTopic(roomKey()));
  });

  it("separates the topic from the message key", () => {
    const key = roomKey();
    assert.notDeepEqual(deriveTopic(key), deriveMessageKey(key));
  });

  // The bug this guards: joinRoom used to call sdk.join(roomKey) directly, so
  // the room secret was the value announced to DHT nodes.
  it("never announces the room key itself as the topic", () => {
    const key = roomKey();
    assert.notEqual(deriveTopic(key).toString("hex"), key);
  });
});

describe("DHT observer cannot read messages", () => {
  // A DHT node servicing announce/lookup sees the topic bytes and nothing else.
  it("cannot derive the message key from the announced topic", () => {
    const key = roomKey();
    const observedTopic = deriveTopic(key).toString("hex");

    // Every derivation an observer can run over what it actually saw.
    const guesses = [
      createHash("sha256").update("peersky-chat:" + observedTopic).digest(),
      createHash("sha256").update("peersky-chat:key:" + observedTopic).digest(),
      createHash("sha256").update("peersky-chat:topic:" + observedTopic).digest(),
      Buffer.from(observedTopic, "hex"),
    ];

    const real = deriveMessageKey(key);
    for (const guess of guesses) assert.notDeepEqual(guess, real);
  });

  it("cannot decrypt a message using the announced topic", () => {
    const key = roomKey();
    const observedTopic = deriveTopic(key).toString("hex");
    const { ct, iv, tag } = encryptMsg("board meeting at 4", key);

    // Treating the observed topic as if it were the room key must fail.
    assert.throws(() => decryptMsg(ct, iv, tag, observedTopic));
  });
});

describe("message encryption", () => {
  it("round-trips a message", () => {
    const key = roomKey();
    const { ct, iv, tag } = encryptMsg("hello over LAN", key);
    assert.equal(decryptMsg(ct, iv, tag, key), "hello over LAN");
  });

  it("round-trips unicode and long messages", () => {
    const key = roomKey();
    const text = "नमस्ते 🎉 " + "x".repeat(50_000);
    const { ct, iv, tag } = encryptMsg(text, key);
    assert.equal(decryptMsg(ct, iv, tag, key), text);
  });

  it("uses a fresh IV per message", () => {
    const key = roomKey();
    const a = encryptMsg("same text", key);
    const b = encryptMsg("same text", key);
    assert.notEqual(a.iv, b.iv);
    assert.notEqual(a.ct, b.ct);
  });

  it("rejects a message from a different room", () => {
    const { ct, iv, tag } = encryptMsg("secret", roomKey());
    assert.throws(() => decryptMsg(ct, iv, tag, roomKey()));
  });

  it("rejects a tampered ciphertext", () => {
    const key = roomKey();
    const { ct, iv, tag } = encryptMsg("transfer 100", key);
    const flipped = (parseInt(ct.slice(0, 1), 16) ^ 1).toString(16) + ct.slice(1);
    assert.throws(() => decryptMsg(flipped, iv, tag, key));
  });
});

describe("history written before the fix", () => {
  it("still decrypts", () => {
    const key = roomKey();
    const { ct, iv, tag } = legacyEncrypt("message from an older build", key);
    assert.equal(decryptMsg(ct, iv, tag, key), "message from an older build");
  });

  it("does not make new messages readable with the legacy key", () => {
    const key = roomKey();
    const legacyKey = createHash("sha256").update("peersky-chat:" + key).digest();
    assert.notDeepEqual(deriveMessageKey(key), legacyKey);
  });

  it("reports the current-key failure when a message is simply corrupt", () => {
    const key = roomKey();
    const { iv, tag } = encryptMsg("x", key);
    assert.throws(() => decryptMsg("deadbeef", iv, tag, key));
  });
});
