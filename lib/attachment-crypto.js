// Attachments are sealed with AES-256-GCM under a key derived from the room
// key with its own label, and stored in a per-room drive. The link alone
// yields ciphertext. WebCrypto so this runs in the renderer and in tests.
const ATTACHMENT_KEY_CONTEXT = "peersky-chat:attachment:";
const DRIVE_NAME_CONTEXT = "peersky-chat:drive:";
const MAGIC = new Uint8Array([0x50, 0x43, 0x41, 0x31]); // "PCA1"
const IV_BYTES = 12;
const ROOM_KEY_RE = /^[a-f0-9]{64}$/i;

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
