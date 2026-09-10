import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";

import {
  attachmentDriveName,
  decryptAttachment,
  deriveAttachmentKeyBytes,
  encryptAttachment,
  isEncryptedAttachment,
  opaqueAttachmentPath,
} from "../lib/attachment-crypto.js";
import { deriveMessageKey, deriveTopic } from "../p2p.js";

const roomKey = () => randomBytes(32).toString("hex");
const bytes = (n) => new Uint8Array(randomBytes(n));

describe("attachment key derivation", () => {
  it("uses its own label, distinct from the topic and message keys", async () => {
    const key = roomKey();
    const attachment = Buffer.from(await deriveAttachmentKeyBytes(key));
    assert.notDeepEqual(attachment, deriveMessageKey(key));
    assert.notDeepEqual(attachment, deriveTopic(key));
  });

  it("is deterministic and case-insensitive", async () => {
    const key = roomKey();
    assert.deepEqual(await deriveAttachmentKeyBytes(key), await deriveAttachmentKeyBytes(key.toUpperCase()));
  });

  it("rejects anything that is not a room key", async () => {
    await assert.rejects(() => deriveAttachmentKeyBytes("not-a-key"));
    await assert.rejects(() => attachmentDriveName(""));
  });
});

describe("per-room drive name", () => {
  it("is stable for a room and different between rooms", async () => {
    const key = roomKey();
    assert.equal(await attachmentDriveName(key), await attachmentDriveName(key));
    assert.notEqual(await attachmentDriveName(key), await attachmentDriveName(roomKey()));
  });

  it("reveals nothing about the room key", async () => {
    const key = roomKey();
    const name = await attachmentDriveName(key);
    assert.match(name, /^peerchat-[a-f0-9]{32}$/);
    assert.ok(!name.includes(key.slice(0, 8)));
  });
});

describe("opaque object names", () => {
  it("carry no file or room information", () => {
    const a = opaqueAttachmentPath();
    const b = opaqueAttachmentPath();
    assert.match(a, /^\d+-[a-f0-9]{16}\.bin$/);
    assert.notEqual(a, b);
  });
});

describe("attachment sealing", () => {
  it("round-trips bytes for members of the room", async () => {
    const key = roomKey();
    const plain = bytes(64 * 1024);
    const sealed = await encryptAttachment(plain, key);
    assert.ok(isEncryptedAttachment(sealed));
    assert.deepEqual(await decryptAttachment(sealed, key), plain);
  });

  it("round-trips an empty file", async () => {
    const key = roomKey();
    assert.deepEqual(await decryptAttachment(await encryptAttachment(new Uint8Array(0), key), key), new Uint8Array(0));
  });

  it("yields only ciphertext to anyone holding just the link", async () => {
    const plain = new TextEncoder().encode("payroll-2026.xlsx contents");
    const sealed = await encryptAttachment(plain, roomKey());
    assert.ok(!Buffer.from(sealed).includes(Buffer.from("payroll")));
  });

  it("does not open with another room's key", async () => {
    const sealed = await encryptAttachment(bytes(1024), roomKey());
    await assert.rejects(() => decryptAttachment(sealed, roomKey()), /decryption failed/);
  });

  it("does not open when tampered", async () => {
    const key = roomKey();
    const sealed = await encryptAttachment(bytes(1024), key);
    sealed[sealed.length - 1] ^= 0x01;
    await assert.rejects(() => decryptAttachment(sealed, key), /decryption failed/);
  });

  it("uses a fresh IV per file", async () => {
    const key = roomKey();
    const plain = bytes(256);
    assert.notDeepEqual(await encryptAttachment(plain, key), await encryptAttachment(plain, key));
  });

  it("tells sealed files apart from legacy plaintext uploads", async () => {
    assert.equal(isEncryptedAttachment(bytes(4096)), false);
    assert.equal(isEncryptedAttachment(new TextEncoder().encode("PCA1")), false);
    await assert.rejects(() => decryptAttachment(bytes(4096), roomKey()), /Not an encrypted attachment/);
  });
});
