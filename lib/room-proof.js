// Being in a room on a connection means holding the room's key, and a peer
// shows that without sending it. The topic a room is found by is public: DHT
// nodes see it go by. So a topic opens nothing on its own. Each side sends,
// for every room it is in, an HMAC made with that room's key over the
// connection's handshake hash and its own network key. Only someone holding
// the key can make one, it is good on this connection alone, and it cannot be
// bounced back, because the other side's would name the other key.
//
// PeerSky Mobile keeps the same rules in backend/peerchat/room-proof.mjs.
// Both have to agree on every byte.
import { createHash, createHmac } from "crypto";

const ROOM_KEY_RE = /^[0-9a-f]{64}$/;
const KEY_RE = /^[0-9a-f]{64}$/;
const HEX_RE = /^(?:[0-9a-f]{2})+$/;
const PROOF_KEY_CONTEXT = "peersky-chat:proof:";
const PROOF_LABEL = "peersky-chat/2 room";

function hex(value) {
  if (typeof value === "string") return value.toLowerCase();
  if (ArrayBuffer.isView(value)) {
    return Buffer.from(value.buffer, value.byteOffset, value.byteLength).toString("hex");
  }
  return "";
}

export function roomProof(roomKey, handshakeHash, senderKey) {
  const room = typeof roomKey === "string" ? roomKey.toLowerCase() : "";
  const handshake = hex(handshakeHash);
  const sender = hex(senderKey);
  if (!ROOM_KEY_RE.test(room) || !HEX_RE.test(handshake) || !KEY_RE.test(sender)) return "";
  const key = createHash("sha256").update(PROOF_KEY_CONTEXT + room).digest();
  return createHmac("sha256", key).update(`${PROOF_LABEL}\n${handshake}\n${sender}`).digest("hex");
}

export function checkRoomProof(roomKey, handshakeHash, senderKey, proof) {
  if (typeof proof !== "string" || !KEY_RE.test(proof)) return false;
  const expected = roomProof(roomKey, handshakeHash, senderKey);
  if (!expected) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ proof.charCodeAt(i);
  return diff === 0;
}
