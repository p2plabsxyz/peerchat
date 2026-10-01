import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";

import {
  ATTACHMENT_FRAME_BYTES,
  MAX_SINGLE_SEAL_BYTES,
  attachmentDriveName,
  decryptAttachment,
  deriveAttachmentKeyBytes,
  encryptAttachment,
  isEncryptedAttachment,
  opaqueAttachmentPath,
  openAttachmentStream,
  sealAttachmentStream,
  sealedAttachmentLength,
  sealsInFrames,
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

// PCA2 seals a frame at a time, so neither side ever holds the whole file.
// Small frames here keep the tests quick; the real one is a megabyte.
const FRAME = 16;

async function collect(stream) {
  const parts = [];
  for await (const part of stream) parts.push(part);
  return parts;
}

const join = (parts) => new Uint8Array(Buffer.concat(parts.map((part) => Buffer.from(part))));

async function sealFramed(plain, key, options = {}) {
  return collect(sealAttachmentStream(new Blob([plain]), key, { frameBytes: FRAME, ...options }));
}

async function openAll(parts, key) {
  return join(await collect(openAttachmentStream(parts, key)));
}

// What PeerSky Mobile's AttachmentFrameEncryptStream writes for this room key,
// these 8 bytes and 8-byte frames. Its tests pin the same bytes, so a change on
// either side that the other cannot read fails somewhere.
const VECTOR = {
  roomKey: "ab".repeat(32),
  baseNonce: Uint8Array.from(Buffer.from("0102030405060708", "hex")),
  frameBytes: 8,
  plain: "PeerChat framed vector, both apps.",
  sealed: "50434132000000080102030405060708abb77278dba950a24b40e33ad546e0c4b794b4a5f4bb4df4226050ae9ff032776d30f7886536c431dcf737ab0abf92be003fa9a2d9ee02261e82c92aba69147f3c1a22e82e71ccd292b2574c05061353633cec9ab230c51db8584f9a6ed3c7303ee8b93cee2e7ddde84c3e46b89cba6efbd8",
};

describe("attachments sealed in frames", () => {
  it("open what mobile seals, and seal it the same way", async () => {
    const sealed = Uint8Array.from(Buffer.from(VECTOR.sealed, "hex"));
    assert.equal(Buffer.from(await openAll([sealed], VECTOR.roomKey)).toString(), VECTOR.plain);

    const ours = await collect(sealAttachmentStream(new Blob([VECTOR.plain]), VECTOR.roomKey, {
      frameBytes: VECTOR.frameBytes,
      baseNonce: VECTOR.baseNonce,
    }));
    assert.equal(Buffer.from(join(ours)).toString("hex"), VECTOR.sealed);
  });

  it("round-trip at every size around a frame, ending on a short frame", async () => {
    const key = roomKey();
    for (const size of [0, 1, FRAME - 1, FRAME, FRAME + 1, FRAME * 3, FRAME * 3 + 5]) {
      const plain = bytes(size);
      const parts = await sealFramed(plain, key);
      const sealed = join(parts);
      assert.equal(Buffer.from(sealed.subarray(0, 4)).toString(), "PCA2", `size ${size}`);
      // The header, then one tag for every full frame and one for the short last frame.
      assert.equal(sealed.length, 16 + size + (Math.floor(size / FRAME) + 1) * 16, `size ${size}`);
      assert.deepEqual(await openAll([sealed], key), plain, `size ${size}`);
    }
  });

  it("never hold more than a frame on the way out", async () => {
    const parts = await sealFramed(bytes(FRAME * 20), roomKey());
    for (const part of parts) assert.ok(part.length <= FRAME + 16);
  });

  it("open however the bytes are cut on the way in", async () => {
    const key = roomKey();
    const plain = bytes(FRAME * 4 + 3);
    const sealed = join(await sealFramed(plain, key));
    for (const step of [1, 3, 7, FRAME + 16, 1000]) {
      const pieces = [];
      for (let at = 0; at < sealed.length; at += step) pieces.push(sealed.subarray(at, at + step));
      assert.deepEqual(await openAll(pieces, key), plain, `step ${step}`);
    }
  });

  it("open from a response body as well as from a list of pieces", async () => {
    const key = roomKey();
    const plain = bytes(FRAME * 5);
    const body = new Blob([join(await sealFramed(plain, key))]).stream();
    assert.deepEqual(await openAll(body, key), plain);
  });

  it("do not open with another room's key", async () => {
    const sealed = join(await sealFramed(bytes(FRAME * 3), roomKey()));
    await assert.rejects(() => openAll([sealed], roomKey()), /decryption failed/);
  });

  it("do not pass a cut-off file as a shorter one", async () => {
    const key = roomKey();
    const sealed = join(await sealFramed(bytes(FRAME * 3), key));
    // Without its empty last frame the file ends on a full frame, which is never the end.
    await assert.rejects(() => openAll([sealed.subarray(0, sealed.length - 16)], key), /decryption failed|incomplete/);
    // Cut inside a frame.
    await assert.rejects(() => openAll([sealed.subarray(0, sealed.length - 40)], key), /decryption failed|incomplete/);
    // Only the header.
    await assert.rejects(() => openAll([sealed.subarray(0, 16)], key), /incomplete/);
  });

  it("do not open with frames swapped", async () => {
    const key = roomKey();
    const sealed = join(await sealFramed(bytes(FRAME * 3), key));
    const frame = FRAME + 16;
    const swapped = join([
      sealed.subarray(0, 16),
      sealed.subarray(16 + frame, 16 + frame * 2),
      sealed.subarray(16, 16 + frame),
      sealed.subarray(16 + frame * 2),
    ]);
    await assert.rejects(() => openAll([swapped], key), /decryption failed/);
  });

  it("do not open with the header edited", async () => {
    const key = roomKey();
    const sealed = join(await sealFramed(bytes(FRAME * 3), key));
    const nonce = Uint8Array.from(sealed);
    nonce[9] ^= 0x01;
    await assert.rejects(() => openAll([nonce], key), /decryption failed/);
    // A frame size the reader would have to hold more than 16 MB for.
    const huge = Uint8Array.from(sealed);
    huge[4] = 0x7f;
    await assert.rejects(() => openAll([huge], key), /Not an encrypted attachment/);
  });

  it("still open files sealed in one piece, and nothing else", async () => {
    const key = roomKey();
    const plain = bytes(5000);
    const single = await encryptAttachment(plain, key);
    assert.deepEqual(await openAll([single.subarray(0, 3), single.subarray(3)], key), plain);
    await assert.rejects(() => openAll([bytes(4096)], key), /Not an encrypted attachment/);
    await assert.rejects(() => openAll([new Uint8Array(0)], key), /Not an encrypted attachment/);
  });

  it("are what a file over 100 MB gets, with the length the drive will hold", () => {
    assert.equal(sealsInFrames(MAX_SINGLE_SEAL_BYTES), false);
    assert.equal(sealsInFrames(MAX_SINGLE_SEAL_BYTES + 1), true);
    assert.equal(sealedAttachmentLength(1024), 4 + 12 + 1024 + 16);
    const size = MAX_SINGLE_SEAL_BYTES + 1;
    assert.equal(sealedAttachmentLength(size), 16 + size + (Math.floor(size / ATTACHMENT_FRAME_BYTES) + 1) * 16);
  });
});
