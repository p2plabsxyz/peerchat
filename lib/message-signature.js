// Messages signed by whoever wrote them.
//
// A message used to name its author in a field anyone could fill in. Straight
// from its author, the connection proved who that was. Anything that came
// through somebody else, in history sync, carried whatever author that person
// wrote in, so someone in a room could slip in a message "from" anyone. Passing
// messages on from device to device makes almost every message come through
// somebody else, so each one now carries:
//
// - `ak`: its author's network key, whose first 8 hex are their id.
// - `h`: a header the author writes once, as a JSON string: the room by its
//   topic, the message id, its time and hour, the author's name, whether it was
//   forwarded, and in a room made before keys rotated, the reply and file
//   details, which sit outside the sealed body there. In a room whose keys
//   rotate those go inside the sealed body, which the signature covers too.
// - `as`: an Ed25519 signature by `ak` over a label, `h` and the sealed body.
//
// A device keeps `h` exactly as it came, so the message can go on to the next
// device, in history or passed on, and be checked there against the same
// bytes. An older build ignores all three fields.
//
// PeerSky Mobile keeps the same rules in backend/peerchat/message-signature.mjs.
// Both have to agree on every byte.
import crypto from "hypercore-crypto";

const MESSAGE_LABEL = "peersky-chat/3 message";
const REACTION_LABEL = "peersky-chat/3 reaction";
const HEX_64 = /^[0-9a-f]{64}$/;
const SIGNATURE = /^[0-9a-f]{128}$/;
export const MAX_SIGNED_HEADER_BYTES = 4096;

/** What an author signs for a message: the header they wrote and the sealed body. */
export function messageSigningText(h, { ct, iv, tag } = {}) {
  return `${MESSAGE_LABEL}\n${h}\n${ct}\n${iv}\n${tag}`;
}

/** What an author signs for a reaction, which has no sealed body. */
export function reactionSigningText(h) {
  return `${REACTION_LABEL}\n${h}`;
}

export function messageHeader({ topic, id, ts, e, sn, replyTo, fileName, fileSize, fileEnc, fwd }) {
  return JSON.stringify({
    v: 1,
    room: topic,
    id,
    ts,
    ...(Number.isSafeInteger(e) && { e }),
    sn,
    ...(replyTo && { replyTo }),
    ...(fileName && { fileName }),
    ...(fileName && Number.isSafeInteger(fileSize) && { fileSize }),
    ...(fileName && fileEnc === true && { fileEnc: true }),
    ...(fwd === true && { fwd: true }),
  });
}

export function reactionHeader({ topic, id, ts, msgId, emoji, sn }) {
  return JSON.stringify({ v: 1, room: topic, id, ts, msgId, emoji, sn });
}

function signText(text, h, keyPair) {
  if (!keyPair?.secretKey || !keyPair?.publicKey) return null;
  try {
    const as = Buffer.from(crypto.sign(Buffer.from(text), keyPair.secretKey)).toString("hex");
    return { ak: Buffer.from(keyPair.publicKey).toString("hex").toLowerCase(), h, as };
  } catch {
    return null;
  }
}

/** `{ ak, h, as }` for a message, or null when these keys cannot sign. */
export function signMessage(fields, sealed, keyPair) {
  const h = messageHeader(fields);
  return signText(messageSigningText(h, sealed), h, keyPair);
}

/** `{ ak, h, as }` for a reaction, or null when these keys cannot sign. */
export function signReaction(fields, keyPair) {
  const h = reactionHeader(fields);
  return signText(reactionSigningText(h), h, keyPair);
}

// The header, if the frame's signature fits it: null for a frame that carries
// none, as an older build sends, and false for one that carries a bad one.
function readSigned(frame, topic, text) {
  if (frame?.ak === undefined && frame?.h === undefined && frame?.as === undefined) return null;
  const { ak, h, as } = frame;
  if (typeof ak !== "string" || !HEX_64.test(ak) || typeof as !== "string" || !SIGNATURE.test(as)) return false;
  if (typeof h !== "string" || Buffer.byteLength(h, "utf8") > MAX_SIGNED_HEADER_BYTES) return false;
  let header;
  try {
    header = JSON.parse(h);
  } catch {
    return false;
  }
  if (!header || typeof header !== "object" || header.v !== 1 || header.room !== topic) return false;
  if (typeof header.id !== "string" || header.id !== frame.id) return false;
  if (!Number.isSafeInteger(header.ts) || header.ts < 0 || typeof header.sn !== "string") return false;
  try {
    if (!crypto.verify(Buffer.from(text(h)), Buffer.from(as, "hex"), Buffer.from(ak, "hex"))) return false;
  } catch {
    return false;
  }
  return { author: ak, authorId: ak.slice(0, 8), header };
}

/** A message's signed header and author, null when it is unsigned, false when the signature is bad. */
export function readSignedMessage(frame, topic) {
  if (typeof frame?.ct !== "string" || typeof frame?.iv !== "string" || typeof frame?.tag !== "string") {
    return frame?.as === undefined ? null : false;
  }
  const signed = readSigned(frame, topic, (h) => messageSigningText(h, frame));
  if (!signed) return signed;
  // The hour decides the key a body opens with, so it is the signed one.
  const e = signed.header.e;
  if (e !== undefined && !Number.isSafeInteger(e)) return false;
  if ((frame.e ?? undefined) !== e) return false;
  return signed;
}

/** A reaction's signed header and author, null when it is unsigned, false when the signature is bad. */
export function readSignedReaction(frame, topic) {
  const signed = readSigned(frame, topic, reactionSigningText);
  if (!signed) return signed;
  const { msgId, emoji } = signed.header;
  if (typeof msgId !== "string" || typeof emoji !== "string") return false;
  return signed;
}
