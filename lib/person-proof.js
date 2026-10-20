// A person's devices, shown to anyone in a room.
//
// A person's devices share a link (lib/device-link.js), and its proof is a MAC
// only those devices can check. Everyone else sees the link's id on each of
// them but cannot tell it was not copied: anyone can put someone else's id in
// a profile. So a room's maker removing one of a person's devices could not
// safely remove the rest, and the others stayed in the room.
//
// Each device also signs its own network key with a key pair worked out from
// the link, the same pair on every one of the person's devices. Anyone can
// check that signature, and nobody without the link can make one. Two members
// whose profiles check out under the same person key are one person.
//
// PeerSky Mobile keeps the same rules in backend/peerchat/person-proof.mjs.
// Both have to agree on every byte.
import b4a from "b4a";
import crypto from "hypercore-crypto";
import { createHash } from "crypto";

const CONTEXT = "peersky-chat:person:";
const LABEL = "peersky-chat/2 person\n";
const HEX_64 = /^[0-9a-f]{64}$/;
const SIGNATURE = /^[0-9a-f]{128}$/;

function hex64(value) {
  const text = typeof value === "string" ? value.trim().toLowerCase() : "";
  return HEX_64.test(text) ? text : "";
}

/** The key pair every device holding this link works out alike, or null. */
export function personKeyPair(link) {
  const key = hex64(link?.key);
  if (!key) return null;
  return crypto.keyPair(createHash("sha256").update(CONTEXT + key).digest());
}

/** The person key, public, for this link, or "". */
export function personKey(link) {
  const keyPair = personKeyPair(link);
  return keyPair ? b4a.toString(keyPair.publicKey, "hex") : "";
}

/** Sent with a profile: the person key and its signature over this device's network key. */
export function makePersonProof(link, deviceKey) {
  const keyPair = personKeyPair(link);
  const device = hex64(deviceKey);
  if (!keyPair || !device) return null;
  const signature = crypto.sign(b4a.from(LABEL + device), keyPair.secretKey);
  return { key: b4a.toString(keyPair.publicKey, "hex"), sig: b4a.toString(signature, "hex") };
}

/**
 * The person a device belongs to, when its proof was made for the network key
 * the connection came in with, and "" otherwise.
 */
export function checkPersonProof(proof, deviceKey) {
  const key = hex64(proof?.key);
  const sig = typeof proof?.sig === "string" ? proof.sig.trim().toLowerCase() : "";
  const device = hex64(deviceKey);
  if (!key || !SIGNATURE.test(sig) || !device) return "";
  try {
    return crypto.verify(b4a.from(LABEL + device), b4a.from(sig, "hex"), b4a.from(key, "hex")) ? key : "";
  } catch {
    return "";
  }
}
