// Messaging someone on another of their devices. A direct chat's key goes to
// the two people in it and to their own devices, and to nobody else, so a
// device in your chat with someone, under their name with its label, is
// theirs. Messaging it opens that chat instead of sending the same person a
// second request.
//
// PeerSky Mobile keeps the same rule in backend/peerchat/person-chat.mjs.
import { personName } from "./mentions.js";

/**
 * chats: the direct chats to look in, as { dmWith, partnerName, members },
 * members the ids seen in each. Returns the one with peerId in it, from the
 * person peerName names, or null.
 */
export function chatWithPerson(chats, peerId, peerName) {
  const id = String(peerId || "").toLowerCase();
  const person = personName(peerName).toLowerCase();
  if (!id || !person) return null;
  return (Array.isArray(chats) ? chats : []).find((chat) =>
    String(chat?.dmWith || "").toLowerCase() !== id &&
    (chat.members || []).some((member) => String(member).toLowerCase() === id) &&
    personName(chat.partnerName).toLowerCase() === person) || null;
}
