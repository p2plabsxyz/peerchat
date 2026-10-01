// Wire contract, shared with mobile (backend/peerchat/attachments.mjs). A sealed
// file comes in one of two layouts, told apart by its first four bytes.
//
// PCA1, in one piece, for files up to 100 MB:
//   "PCA1" (4 bytes) | 12-byte random IV | AES-256-GCM ciphertext, 16-byte tag last
//
// PCA2, in frames, for anything bigger, up to 2 GB:
//   "PCA2" | frame size, uint32 big-endian | 8 random bytes
//   then every frame's ciphertext, each followed by its 16-byte tag
// A frame's IV is those 8 random bytes and then its index, uint32 big-endian,
// with the top bit set on the last frame. The 16-byte header is the additional
// data on every frame. The last frame is always shorter than a full one, empty
// when the file divides evenly, so frames cannot be reordered, dropped from the
// end, or resized.
//
// key        = sha256("peersky-chat:attachment:" + roomKey)
// drive name = "peerchat-" + first 32 hex of sha256("peersky-chat:drive:" + roomKey)
// WebCrypto, so this runs in the renderer and in tests.
const ATTACHMENT_KEY_CONTEXT = "peersky-chat:attachment:";
const DRIVE_NAME_CONTEXT = "peersky-chat:drive:";
const MAGIC = new Uint8Array([0x50, 0x43, 0x41, 0x31]); // "PCA1"
const FRAMED_MAGIC = new Uint8Array([0x50, 0x43, 0x41, 0x32]); // "PCA2"
const IV_BYTES = 12;
const TAG_BYTES = 16;
const BASE_NONCE_BYTES = 8;
const FRAMED_HEADER_BYTES = FRAMED_MAGIC.length + 4 + BASE_NONCE_BYTES;
const FINAL_FRAME_FLAG = 0x80000000;
// A reader holds a whole frame before it can open it, and the frame size comes
// from the file, so it believes no more than this.
const MAX_FRAME_BYTES = 16 * 1024 * 1024;
const ROOM_KEY_RE = /^[a-f0-9]{64}$/i;

export const ATTACHMENT_FRAME_BYTES = 1024 * 1024;
// Up to here a file is sealed in one piece, which every PeerChat opens. Past
// it, in frames. Mobile draws the line in the same place.
export const MAX_SINGLE_SEAL_BYTES = 100 * 1024 * 1024;
export const MAX_ATTACHMENT_BYTES = 2 * 1024 * 1024 * 1024;

const subtle = globalThis.crypto?.subtle;
const encoder = new TextEncoder();

function assertRoomKey(roomKey) {
  if (typeof roomKey !== "string" || !ROOM_KEY_RE.test(roomKey)) throw new Error("Invalid room key");
  return roomKey.toLowerCase();
}

async function sha256(text) {
  return new Uint8Array(await subtle.digest("SHA-256", encoder.encode(text)));
}

function toHex(bytes) {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export async function attachmentDriveName(roomKey) {
  const digest = await sha256(DRIVE_NAME_CONTEXT + assertRoomKey(roomKey));
  return "peerchat-" + toHex(digest).slice(0, 32);
}

export async function deriveAttachmentKeyBytes(roomKey) {
  return sha256(ATTACHMENT_KEY_CONTEXT + assertRoomKey(roomKey));
}

async function deriveAttachmentKey(roomKey) {
  const raw = await deriveAttachmentKeyBytes(roomKey);
  return subtle.importKey("raw", raw, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

// Object names carry no room or file information; the real name travels
// inside the encrypted message.
export function opaqueAttachmentPath() {
  const rand = new Uint8Array(8);
  globalThis.crypto.getRandomValues(rand);
  return `${Date.now()}-${toHex(rand)}.bin`;
}

export function isEncryptedAttachment(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length < MAGIC.length + IV_BYTES + 16) return false;
  return MAGIC.every((b, i) => bytes[i] === b);
}

/** Whether a file this size is sealed in frames rather than in one piece. */
export function sealsInFrames(byteLength) {
  return byteLength > MAX_SINGLE_SEAL_BYTES;
}

/** How many bytes a file this size takes once sealed, in the layout it gets. */
export function sealedAttachmentLength(byteLength) {
  if (!sealsInFrames(byteLength)) return MAGIC.length + IV_BYTES + byteLength + TAG_BYTES;
  const frames = Math.floor(byteLength / ATTACHMENT_FRAME_BYTES) + 1;
  return FRAMED_HEADER_BYTES + byteLength + frames * TAG_BYTES;
}

export async function encryptAttachment(bytes, roomKey) {
  const key = await deriveAttachmentKey(roomKey);
  const iv = new Uint8Array(IV_BYTES);
  globalThis.crypto.getRandomValues(iv);
  const sealed = new Uint8Array(await subtle.encrypt({ name: "AES-GCM", iv }, key, bytes));
  const out = new Uint8Array(MAGIC.length + IV_BYTES + sealed.length);
  out.set(MAGIC, 0);
  out.set(iv, MAGIC.length);
  out.set(sealed, MAGIC.length + IV_BYTES);
  return out;
}

export async function decryptAttachment(bytes, roomKey) {
  if (!isEncryptedAttachment(bytes)) throw new Error("Not an encrypted attachment");
  const key = await deriveAttachmentKey(roomKey);
  const iv = bytes.subarray(MAGIC.length, MAGIC.length + IV_BYTES);
  const sealed = bytes.subarray(MAGIC.length + IV_BYTES);
  try {
    return new Uint8Array(await subtle.decrypt({ name: "AES-GCM", iv }, key, sealed));
  } catch {
    throw new Error("Attachment decryption failed");
  }
}

/**
 * A file sealed in frames, as a stream to upload. The file is read a frame at
 * a time and only that frame is held, so a 2 GB video costs a megabyte here.
 */
export function sealAttachmentStream(file, roomKey, { frameBytes = ATTACHMENT_FRAME_BYTES, baseNonce } = {}) {
  assertRoomKey(roomKey);
  const nonce = baseNonce || globalThis.crypto.getRandomValues(new Uint8Array(BASE_NONCE_BYTES));
  const header = framedHeader(frameBytes, nonce);
  let key = null;
  let index = 0;
  return new ReadableStream({
    async start(controller) {
      key = await deriveAttachmentKey(roomKey);
      controller.enqueue(header.slice());
    },
    async pull(controller) {
      const start = index * frameBytes;
      const end = Math.min(start + frameBytes, file.size);
      const isFinal = end - start < frameBytes;
      const plain = new Uint8Array(await file.slice(start, end).arrayBuffer());
      const sealed = await subtle.encrypt(
        { name: "AES-GCM", iv: frameIv(nonce, index, isFinal), additionalData: header },
        key,
        plain,
      );
      controller.enqueue(new Uint8Array(sealed));
      index += 1;
      if (isFinal) controller.close();
    },
  });
}

/**
 * Opens a sealed attachment as it arrives, in either layout, and yields the
 * file in pieces. A framed one comes out a frame at a time. One sealed in a
 * single piece only opens whole, since WebCrypto cannot stream AES-GCM.
 * `source` is a ReadableStream, such as a response body, or any async
 * iterable of bytes.
 */
export async function* openAttachmentStream(source, roomKey) {
  const key = await deriveAttachmentKey(roomKey);
  const queue = new ByteQueue();
  let layout = null;
  let header = null;
  let frameBytes = 0;
  let index = 0;

  for await (const chunk of chunksOf(source)) {
    queue.push(chunk);
    if (!layout) {
      if (queue.length < MAGIC.length) continue;
      layout = readLayout(queue.peek(MAGIC.length));
    }
    if (layout !== "framed") continue;
    if (!header) {
      if (queue.length < FRAMED_HEADER_BYTES) continue;
      header = queue.take(FRAMED_HEADER_BYTES);
      frameBytes = readUint32BE(header, FRAMED_MAGIC.length);
      if (frameBytes < 1 || frameBytes > MAX_FRAME_BYTES) throw new Error("Not an encrypted attachment");
    }
    // A full frame always has more behind it, because the last one is short.
    while (queue.length >= frameBytes + TAG_BYTES) {
      yield await openFrame(key, header, index, false, queue.take(frameBytes + TAG_BYTES));
      index += 1;
    }
  }

  if (layout === "single") {
    yield await decryptAttachment(queue.take(queue.length), roomKey);
    return;
  }
  if (!layout) throw new Error("Not an encrypted attachment");
  if (!header || queue.length < TAG_BYTES) throw new Error("Attachment is incomplete");
  yield await openFrame(key, header, index, true, queue.take(queue.length));
}

function readLayout(magic) {
  if (MAGIC.every((b, i) => magic[i] === b)) return "single";
  if (FRAMED_MAGIC.every((b, i) => magic[i] === b)) return "framed";
  throw new Error("Not an encrypted attachment");
}

function framedHeader(frameBytes, baseNonce) {
  if (!Number.isSafeInteger(frameBytes) || frameBytes < 1 || frameBytes > MAX_FRAME_BYTES) {
    throw new Error("Invalid frame size");
  }
  if (!(baseNonce instanceof Uint8Array) || baseNonce.length !== BASE_NONCE_BYTES) {
    throw new Error("Invalid frame nonce");
  }
  const header = new Uint8Array(FRAMED_HEADER_BYTES);
  header.set(FRAMED_MAGIC, 0);
  writeUint32BE(header, frameBytes, FRAMED_MAGIC.length);
  header.set(baseNonce, FRAMED_MAGIC.length + 4);
  return header;
}

function frameIv(baseNonce, index, isFinal) {
  if (index >= FINAL_FRAME_FLAG) throw new Error("Attachment has too many frames");
  const iv = new Uint8Array(IV_BYTES);
  iv.set(baseNonce, 0);
  writeUint32BE(iv, isFinal ? (index | FINAL_FRAME_FLAG) >>> 0 : index, BASE_NONCE_BYTES);
  return iv;
}

async function openFrame(key, header, index, isFinal, frame) {
  const baseNonce = header.subarray(FRAMED_MAGIC.length + 4);
  try {
    return new Uint8Array(await subtle.decrypt(
      { name: "AES-GCM", iv: frameIv(baseNonce, index, isFinal), additionalData: header },
      key,
      frame,
    ));
  } catch {
    throw new Error("Attachment decryption failed");
  }
}

function writeUint32BE(target, value, offset) {
  target[offset] = (value >>> 24) & 0xff;
  target[offset + 1] = (value >>> 16) & 0xff;
  target[offset + 2] = (value >>> 8) & 0xff;
  target[offset + 3] = value & 0xff;
}

function readUint32BE(source, offset) {
  return source[offset] * 0x1000000 + (source[offset + 1] << 16) + (source[offset + 2] << 8) + source[offset + 3];
}

async function* chunksOf(source) {
  if (typeof source?.getReader !== "function") {
    for await (const chunk of source) yield chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
    return;
  }
  const reader = source.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      if (value?.byteLength) yield value;
    }
  } finally {
    // Stopped early by a bad frame or by whoever was reading: stop the download too.
    reader.cancel().catch(() => {});
  }
}

// Bytes in arrival order, handed out in exact lengths.
class ByteQueue {
  constructor() {
    this.chunks = [];
    this.length = 0;
  }

  push(chunk) {
    if (!chunk.byteLength) return;
    this.chunks.push(chunk);
    this.length += chunk.byteLength;
  }

  peek(count) {
    return this.copy(count, false);
  }

  take(count) {
    return this.copy(count, true);
  }

  copy(count, remove) {
    const out = new Uint8Array(count);
    let filled = 0;
    let next = 0;
    while (filled < count) {
      const head = this.chunks[remove ? 0 : next];
      const used = Math.min(head.byteLength, count - filled);
      out.set(head.subarray(0, used), filled);
      filled += used;
      if (!remove) next += 1;
      else if (used === head.byteLength) this.chunks.shift();
      else this.chunks[0] = head.subarray(used);
    }
    if (remove) this.length -= count;
    return out;
  }
}
