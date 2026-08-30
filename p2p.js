import { PassThrough } from "stream";
import {
  createHash,
  createCipheriv,
  createDecipheriv,
  randomBytes,
} from "crypto";
import { existsSync, readFileSync, writeFileSync } from "fs";
import {
  checkContent as moderationCheckContent,
  initModeration,
  checkMessage as moderationCheck,
  isKicked as moderationIsKicked,
} from "./moderation.js";
import {
  addedRooms,
  peerMatchesIdentity,
  peerSharesRoom,
  sharedRoomsFromTopics,
  topicHex,
} from "./routing.js";
import { attachChatTransport } from "./transport.js";
import {
  decodeMessagePayload,
  encodeMessagePayload,
  extractFirstHttpUrl,
  resolveLinkPreview,
  sanitizePreview,
} from "./lib/link-preview.js";
import b4a from "b4a";

export const CHAT_STORAGE = "peersky-chat-rooms.json";

const MAX_SENDER_LEN = 200;
const MAX_MSG_LEN = 64 * 1024;
const MAX_NAME_LEN = 80;
const MAX_BIO_LEN = 300;
const MAX_LINK_LEN = 512;
const MAX_AVATAR_B64 = 1_400_000;
const MAX_FILE_NAME_LEN = 200;
const RATE_WINDOW_MS = 60_000;
const RATE_MAX = 60;
const KEEPALIVE_MS = 15_000;
const PING_MS = 25_000;
const SEEN_CAP = 10_000;
const PERSIST_DELAY_MS = 2_000;
const DM_CONTROL_TYPES = new Set(["dm-invite", "dm-accept", "dm-reject"]);

const DEFAULT_ROOM_MODERATION = {
  abuseFilter: true,
  nsfwFilter: true,
  spamRateLimit: 10,
};

function sanitizeRoomModeration(input) {
  if (!input || typeof input !== "object") return { ...DEFAULT_ROOM_MODERATION };
  const out = { ...DEFAULT_ROOM_MODERATION };
  if (input.abuseFilter === false) out.abuseFilter = false;
  if (input.nsfwFilter === false) out.nsfwFilter = false;
  if (typeof input.spamRateLimit === "number") {
    out.spamRateLimit = Math.max(1, Math.min(50, Math.floor(input.spamRateLimit)));
  }
  return out;
}

const roomFeeds = {};
const roomSseClients = {};
const globalSseClients = [];
const joinedRooms = new Set();
const discoveryKeys = new Map();
const seenIds = new Set();
const rateCounters = new Map();
const decryptedMessageCache = new Map();
const chatTransports = new WeakMap();
const pendingPeers = new WeakMap();

let peers = [];
let localId = "";
let safeStore = null;
let dataPath = null;
let activeRoom = null;
let persistTimer = null;
let peerCountTimer = null;

let savedData = { profile: {}, rooms: {}, peerProfiles: {} };

function isValidRoomKey(k) {
  return typeof k === "string" && /^[a-f0-9]{64}$/i.test(k);
}

function clamp(s, max) {
  return (typeof s === "string" ? s : "").slice(0, max);
}

const USERNAME_ALLOWED_RE = /^[A-Za-z0-9]+(?: [A-Za-z0-9]+)*$/;

function parseProfileUsername(raw) {
  if (typeof raw !== "string") return "";
  const t = raw.trim().replace(/\s+/g, " ");
  if (!t) return "";
  if (t.length > 50 || !USERNAME_ALLOWED_RE.test(t)) return null;
  return t;
}

function normPeerId(id) {
  return clamp(String(id ?? ""), MAX_SENDER_LEN).toLowerCase();
}

function normalizePersistedDmIds() {
  let changed = false;
  for (const r of Object.values(savedData.rooms)) {
    if (r.isDM && r.dmWith) {
      const n = normPeerId(r.dmWith);
      if (n !== r.dmWith) { r.dmWith = n; changed = true; }
    }
  }
  const pend = savedData.pendingDMs;
  if (pend) {
    for (const p of Object.values(pend)) {
      if (p.fromId) {
        const n = normPeerId(p.fromId);
        if (n !== p.fromId) { p.fromId = n; changed = true; }
      }
    }
  }
  if (changed) persistData();
}

function sanitizeAvatar(v) {
  if (v == null || v === "") return null;
  if (typeof v !== "string") return null;
  if (!v.startsWith("data:image/")) return null;
  if (v.length > MAX_AVATAR_B64) return null;
  return v;
}

function checkRate(key) {
  const now = Date.now();
  const e = rateCounters.get(key);
  if (!e || now > e.r) {
    rateCounters.set(key, { c: 1, r: now + RATE_WINDOW_MS });
    return true;
  }
  if (e.c >= RATE_MAX) return false;
  e.c++;
  return true;
}

function trackId(id) {
  if (seenIds.has(id)) return false;
  seenIds.add(id);
  if (seenIds.size > SEEN_CAP) seenIds.delete(seenIds.values().next().value);
  return true;
}

// The swarm topic is announced to DHT nodes in the clear, so it must not be
// the room key or anything the message key can be derived from. Topic and
// message key are separate KDF outputs over the same secret.
const TOPIC_CONTEXT = "peersky-chat:topic:";
const MESSAGE_KEY_CONTEXT = "peersky-chat:key:";
// Pre-separation derivation, when the room key was itself the topic. Kept for
// decryption only so history written by older builds stays readable.
const LEGACY_MESSAGE_KEY_CONTEXT = "peersky-chat:";

export function deriveTopic(roomKey) {
  return createHash("sha256").update(TOPIC_CONTEXT + roomKey).digest();
}

export function deriveMessageKey(roomKey) {
  return createHash("sha256").update(MESSAGE_KEY_CONTEXT + roomKey).digest();
}

function deriveLegacyMessageKey(roomKey) {
  return createHash("sha256").update(LEGACY_MESSAGE_KEY_CONTEXT + roomKey).digest();
}

export function encryptMsg(text, roomKey) {
  const k = deriveMessageKey(roomKey);
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", k, iv);
  let ct = c.update(text, "utf8", "hex");
  ct += c.final("hex");
  return { ct, iv: iv.toString("hex"), tag: c.getAuthTag().toString("hex") };
}

function openMsg(ct, iv, tag, key) {
  const d = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "hex"));
  d.setAuthTag(Buffer.from(tag, "hex"));
  let pt = d.update(ct, "hex", "utf8");
  pt += d.final("utf8");
  return pt;
}

export function decryptMsg(ct, iv, tag, roomKey) {
  try {
    return openMsg(ct, iv, tag, deriveMessageKey(roomKey));
  } catch (err) {
    try {
      // GCM authentication means this only opens genuine pre-separation
      // ciphertext, never a forgery.
      return openMsg(ct, iv, tag, deriveLegacyMessageKey(roomKey));
    } catch {
      throw err;
    }
  }
}

function enc4disk(v) {
  if (!safeStore?.isEncryptionAvailable?.()) return v;
  try { return safeStore.encryptString(v).toString("base64"); } catch { return v; }
}

function dec4disk(v) {
  if (!safeStore?.isEncryptionAvailable?.()) return v;
  try { return safeStore.decryptString(Buffer.from(v, "base64")); } catch { return v; }
}

const DATA_VERSION = 1;

function loadData() {
  if (!dataPath) return;
  try {
    if (!existsSync(dataPath)) return;
    const raw = JSON.parse(readFileSync(dataPath, "utf8"));

    if (raw.rooms) {
      savedData.profile = raw.profile || {};
      savedData.peerProfiles = raw.peerProfiles || {};
      savedData.pendingDMs = raw.pendingDMs || {};
      for (const [id, r] of Object.entries(raw.rooms)) {
        savedData.rooms[id] = { ...r, roomKey: dec4disk(r.roomKey) };
      }
    } else {
      for (const [id, r] of Object.entries(raw)) {
        savedData.rooms[id] = { ...r, roomKey: dec4disk(r.roomKey) };
      }
    }

    // Rooms created before configurable moderation carry no settings. Without a
    // backfill they report null, which the UI shows as "Default settings" and
    // which every filter reads as "not disabled", so the room looks unconfigured
    // and unconfigurable at the same time.
    for (const room of Object.values(savedData.rooms)) {
      if (!room.moderation) room.moderation = { ...DEFAULT_ROOM_MODERATION };
    }

    if ((raw.v || 0) < DATA_VERSION) persistData();
    normalizePersistedDmIds();
  } catch (err) {
    console.error("[chat] Load failed:", err.message);
  }
}

function persistData() {
  if (!dataPath) return;
  try {
    const out = { v: DATA_VERSION, profile: savedData.profile, peerProfiles: savedData.peerProfiles, pendingDMs: savedData.pendingDMs || {}, rooms: {} };
    for (const [id, r] of Object.entries(savedData.rooms)) {
      out.rooms[id] = { ...r, roomKey: enc4disk(r.roomKey) };
    }
    writeFileSync(dataPath, JSON.stringify(out, null, 2), "utf8");
  } catch (err) {
    console.error("[chat] Save failed:", err.message);
  }
}

function debouncePersist() {
  if (persistTimer) return;
  persistTimer = setTimeout(() => {
    persistTimer = null;
    persistData();
  }, PERSIST_DELAY_MS);
}

function prunePeers() {
  const n = peers.length;
  peers = peers.filter((p) => !p.conn.destroyed);
  return peers.length !== n;
}

function sendPeerCount() {
  prunePeers();
  const n = new Set(peers.map((peer) => peer.fullId || peer.id)).size;
  for (const streams of Object.values(roomSseClients)) {
    for (const s of streams) {
      try { s.write(`event: peersCount\ndata: ${n}\n\n`); } catch {}
    }
  }
  broadcastGlobal("peersCount", { count: n });
}

function broadcastPeerCountNow() {
  if (peerCountTimer) { clearTimeout(peerCountTimer); peerCountTimer = null; }
  sendPeerCount();
}

function broadcastPeerCountDelayed() {
  if (peerCountTimer) clearTimeout(peerCountTimer);
  peerCountTimer = setTimeout(() => { peerCountTimer = null; sendPeerCount(); }, 3000);
}

function relayToMatchingPeers(payload, matches) {
  const dead = [];
  const delivered = new Set();
  for (let i = peers.length - 1; i >= 0; i--) {
    if (peers[i].conn.destroyed) { dead.push(i); continue; }
    if (!matches(peers[i])) continue;
    const identity = peers[i].fullId || peers[i].id;
    if (delivered.has(identity)) continue;
    try {
      writeToConnection(peers[i].conn, payload);
      delivered.add(identity);
    } catch {
      dead.push(i);
    }
  }
  if (dead.length) {
    peers = peers.filter((_, i) => !dead.includes(i));
    broadcastPeerCountDelayed();
  }
}

function writeToConnection(conn, payload) {
  const transport = chatTransports.get(conn);
  if (!transport) throw new Error("Chat transport is not open");
  return transport.send(payload);
}

function relayToRoom(roomKey, payload) {
  relayToMatchingPeers(payload, (peer) => peerSharesRoom(peer, roomKey));
}

function relayToPeer(peerId, payload) {
  relayToMatchingPeers(payload, (peer) => peerMatchesIdentity(peer, peerId));
}

function peerForConnection(conn) {
  return peers.find((peer) => peer.conn === conn);
}

function connectionSharesRoom(conn, roomKey) {
  return peerSharesRoom(peerForConnection(conn), roomKey);
}

function broadcastGlobal(event, data) {
  const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  const dead = [];
  for (let i = 0; i < globalSseClients.length; i++) {
    try { globalSseClients[i].write(frame); } catch { dead.push(i); }
  }
  for (let i = dead.length - 1; i >= 0; i--) globalSseClients.splice(dead[i], 1);
}

function roomUpdatePayload(roomKey) {
  const room = savedData.rooms[roomKey];
  if (!room) return null;
  return {
    roomKey,
    name: room.name || roomKey.slice(0, 8) + "...",
    bio: room.bio || "",
    avatar: room.avatar || null,
    isDM: !!room.isDM,
    dmWith: room.dmWith || null,
    pendingAcceptance: !!room.pendingAcceptance,
    createdBy: room.createdBy || "",
    createdByName: room.createdByName || "",
    isPinned: !!room.isPinned,
    isMuted: !!room.isMuted,
    unreadCount: room.unreadCount || 0,
    unreadMentions: room.unreadMentions || 0,
    lastMessage: room.lastMessage || null,
    moderation: room.moderation || null,
  };
}

function emitRoomUpdate(roomKey) {
  const payload = roomUpdatePayload(roomKey);
  if (payload) broadcastGlobal("room-update", payload);
}

async function appendToFeed(roomKey, entry) {
  const feed = roomFeeds[roomKey];
  if (!feed) throw new Error("Feed not initialized");
  await feed.append(entry);
}

function messageCacheKey(roomKey, msgId) {
  return `${roomKey}:${msgId}`;
}

function cacheDecryptedMessage(roomKey, msgId, plaintext) {
  if (!msgId || typeof plaintext !== "string") return;
  decryptedMessageCache.set(messageCacheKey(roomKey, msgId), plaintext);
}

function consumeCachedDecryptedMessage(roomKey, msgId) {
  if (!msgId) return null;
  const key = messageCacheKey(roomKey, msgId);
  if (!decryptedMessageCache.has(key)) return null;
  const plaintext = decryptedMessageCache.get(key);
  decryptedMessageCache.delete(key);
  return plaintext;
}

function isModerationNoticeEntry(entry) {
  return entry?.moderationNotice === true ||
    (entry?.type === "system" && typeof entry.id === "string" && entry.id.startsWith("mod-"));
}

function feedEntryToMsg(entry, roomKey) {
  if (entry.type === "system") {
    const out = { id: entry.id, type: "system", text: entry.text, timestamp: entry.ts };
    if (entry.moderationNotice) out.moderationNotice = true;
    return out;
  }
  if (entry.type === "reaction") {
    return { id: entry.id, type: "reaction", msgId: entry.msgId, emoji: entry.emoji, sender: entry.sender, senderName: entry.sn || entry.sender, timestamp: entry.ts };
  }
  if (entry.ct && entry.iv && entry.tag) {
    const raw = consumeCachedDecryptedMessage(roomKey, entry.id) ?? decryptMsg(entry.ct, entry.iv, entry.tag, roomKey);
    const payload = decodeMessagePayload(raw);
    const out = {
      id: entry.id,
      sender: entry.sender,
      senderName: entry.sn || entry.sender,
      message: payload.text,
      timestamp: entry.ts,
      replyTo: entry.replyTo || null,
    };
    if (payload.preview) out.preview = payload.preview;
    if (entry.fileName) out.fileName = entry.fileName;
    if (entry.fileSize != null) out.fileSize = entry.fileSize;
    return out;
  }
  return {
    id: entry.id || null,
    sender: entry.sender,
    senderName: entry.sn || entry.sender,
    message: entry.message,
    timestamp: entry.timestamp || entry.ts,
    replyTo: entry.replyTo || null,
  };
}

async function syncRoomHistoryTo(conn, rk) {
  if (!connectionSharesRoom(conn, rk)) return;
  const feed = roomFeeds[rk];
  if (!feed || !feed.length) return;
  const len = feed.length;
  for (let i = 0; i < len; i++) {
    try {
      if (conn.destroyed) return;
      if (!connectionSharesRoom(conn, rk)) return;
      const e = await feed.get(i);
      if (isModerationNoticeEntry(e)) continue;
      const syncType = e.type === "system" ? "sync-system" : e.type === "reaction" ? "sync-reaction" : "sync";
      const ok = writeToConnection(conn, JSON.stringify({ type: syncType, roomKey: rk, ...e }) + "\n");
      if (!ok) {
        const drained = await Promise.race([
          new Promise((r) => conn.once("drain", () => r(true))),
          new Promise((r) => setTimeout(() => r(false), 5000)),
        ]);
        if (!drained || conn.destroyed) return;
      }
    } catch {}
  }
}

async function syncHistoryTo(conn) {
  const peer = peerForConnection(conn);
  for (const rk of peer?.rooms || []) {
    await syncRoomHistoryTo(conn, rk);
  }
  if (!conn.destroyed) {
    try { writeToConnection(conn, JSON.stringify({ type: "sync-done" }) + "\n"); } catch {}
  }
}

function decryptIncomingChat(msg, label) {
  if (!msg.ct || !msg.iv || !msg.tag) {
    console.warn(`[chat] Dropping ${label}: missing encrypted payload`);
    return { ok: false, plaintext: "" };
  }

  try {
    return { ok: true, plaintext: decryptMsg(msg.ct, msg.iv, msg.tag, msg.roomKey) };
  } catch (err) {
    console.warn(`[chat] Dropping ${label}: decrypt failed (${err.message})`);
    return { ok: false, plaintext: "" };
  }
}

function moderationSystemText(peerName, modResult) {
  if (modResult.action === "kick") {
    return `\uD83D\uDEAB ${peerName} was auto-kicked (${modResult.reason})`;
  }
  if (modResult.action === "final-warn") {
    return `\uD83D\uDEA8 Final warning for ${peerName} (${modResult.reason})`;
  }
  return `\u26A0\uFE0F ${peerName}: message filtered (${modResult.reason})`;
}

function appendModerationNotice(roomKey, sourceId, peerName, modResult, ts) {
  const sysId = `mod-${sourceId || Date.now()}-${Math.random().toString(36).slice(2)}`;
  return appendToFeed(roomKey, {
    id: sysId,
    type: "system",
    moderationNotice: true,
    text: moderationSystemText(peerName, modResult),
    ts: ts || Date.now(),
  }).catch(() => {});
}

function shareProfile(conn, roomKeys = peerForConnection(conn)?.rooms || []) {
  if (!savedData.profile?.username) return;
  const sharedRooms = roomKeys.filter((rk) => connectionSharesRoom(conn, rk));
  if (!sharedRooms.length) return;
  try {
    writeToConnection(conn, JSON.stringify({
      type: "profile", peerId: localId,
      username: savedData.profile.username,
      bio: savedData.profile.bio || "",
      avatar: savedData.profile.avatar || null,
      rooms: sharedRooms,
    }) + "\n");
  } catch {}
}

function sendRoomMeta(conn, rk) {
  if (!connectionSharesRoom(conn, rk)) return;
  const room = savedData.rooms[rk];
  if (!room || !roomFeeds[rk]) return;

  // Don't send if it's just a placeholder and we aren't the host
  const hasRealName = room.name && room.name !== rk.slice(0, 8) + "...";
  if (!hasRealName && !room.isHost) return;

  try {
    writeToConnection(conn, JSON.stringify({
      type: "room-meta",
      roomKey: rk,
      name: room.name || "",
      bio: room.bio || "",
      link: room.link || "",
      avatar: room.avatar || null,
      createdBy: room.createdBy || (room.isHost ? localId : ""),
      createdByName: room.createdByName || (room.isHost ? (savedData.profile?.username || localId) : ""),
      moderation: room.moderation || null,
    }) + "\n");
  } catch {}
}


function shareRoomMeta(conn, roomKeys = peerForConnection(conn)?.rooms || []) {
  for (const rk of roomKeys) {
    sendRoomMeta(conn, rk);
  }
}

function shareMembers(conn, roomKeys = peerForConnection(conn)?.rooms || []) {
  for (const rk of roomKeys) {
    const room = savedData.rooms[rk];
    if (!room || !room.members || !roomFeeds[rk]) continue;
    try {
      writeToConnection(conn, JSON.stringify({ type: "members-list", roomKey: rk, members: room.members }) + "\n");
    } catch {}
  }
}

function announceJoins(conn, roomKeys = peerForConnection(conn)?.rooms || []) {
  const uname = savedData.profile?.username || localId;
  for (const rk of roomKeys) {
    const room = savedData.rooms[rk];
    if (!room || !roomFeeds[rk]) continue;
    const joinTs = room.joinedAt || room.createdAt || Date.now();
    if (!room.joinedAt) { room.joinedAt = joinTs; debouncePersist(); }
    const joinId = `${rk}-${localId}-join-${joinTs}`;
    try {
      writeToConnection(conn, JSON.stringify({
        type: "join", roomKey: rk,
        peerId: localId,
        username: uname,
        bio: savedData.profile?.bio || "",
        avatar: savedData.profile?.avatar || null,
        id: joinId,
        ts: joinTs,
      }) + "\n");
    } catch {}
  }
}

function shareDMInvites(conn, remoteId) {
  const rnorm = remoteId ? normPeerId(remoteId) : "";
  for (const [rk, room] of Object.entries(savedData.rooms)) {
    if (!room.isDM || !room.dmWith) continue;
    if (rnorm && normPeerId(room.dmWith) !== rnorm) continue;
    try {
      writeToConnection(conn, JSON.stringify({
        type: "dm-invite", roomKey: rk,
        fromId: localId,
        fromUsername: savedData.profile?.username || localId,
        fromAvatar: savedData.profile?.avatar || null,
        fromBio: savedData.profile?.bio || "",
        toId: room.dmWith,
      }) + "\n");
    } catch {}
  }
}

async function joinRoom(sdk, roomKey) {
  if (!joinedRooms.has(roomKey)) {
    // Advertise the room independently of feed initialization. A damaged or
    // temporarily unavailable local feed must not make the peer invisible.
    const topic = deriveTopic(roomKey);
    const discoveryKey = topicHex(topic);
    discoveryKeys.set(discoveryKey, roomKey);
    try {
      sdk.join(topic, { client: true, server: true });
      joinedRooms.add(roomKey);
    } catch (error) {
      discoveryKeys.delete(discoveryKey);
      throw error;
    }

    try {
      await sdk.swarm.flush();
    } catch (error) {
      console.warn(`[chat] Discovery flush ${roomKey.slice(0, 8)}: ${error.message}`);
    }
  }

  let feed = roomFeeds[roomKey];
  if (!feed) {
    feed = sdk.corestore.get({ name: "chat-" + roomKey, valueEncoding: "json" });
    await feed.ready();
    roomFeeds[roomKey] = feed;

    for (let i = 0; i < feed.length; i++) {
      try { const e = await feed.get(i); if (e.id) seenIds.add(e.id); } catch {}
    }

    feed.on("append", async () => {
      try {
        const entry = await feed.get(feed.length - 1);
        const msg = feedEntryToMsg(entry, roomKey);

        for (const s of roomSseClients[roomKey] || []) {
          try { s.write(`data: ${JSON.stringify(msg)}\n\n`); } catch {}
        }

        broadcastGlobal("message", { roomKey, ...msg });

        const room = savedData.rooms[roomKey];
        if (room) {
          const isSystem = msg.type === "system";
          const isReaction = msg.type === "reaction";
          if (!isSystem && !isReaction && room.isDM && room.pendingAcceptance && room.dmWith && msg.sender &&
              normPeerId(msg.sender) === normPeerId(room.dmWith)) {
            room.pendingAcceptance = false;
            debouncePersist();
            emitRoomUpdate(roomKey);
          }
          const msgText = typeof msg.message === "string" ? msg.message : "";
          if (!isSystem && !isReaction && msgText) {
            room.lastMessage = {
              sender: msg.sender,
              senderName: msg.senderName,
              message: msgText.slice(0, 120),
              timestamp: msg.timestamp,
            };
          }
          if (isReaction && msg.emoji) {
            room.lastMessage = {
              sender: msg.sender,
              senderName: msg.senderName,
              message: `reacted ${msg.emoji}`,
              timestamp: msg.timestamp,
            };
          }

          if (!isSystem && !isReaction && roomKey !== activeRoom && msg.sender !== localId) {
            room.unreadCount = (room.unreadCount || 0) + 1;
            const uname = savedData.profile?.username;
            if (uname && msgText.includes("@" + uname)) {
              room.unreadMentions = (room.unreadMentions || 0) + 1;
            }
          }
          if (isReaction && roomKey !== activeRoom && msg.sender !== localId) {
            room.unreadCount = (room.unreadCount || 0) + 1;
          }
          emitRoomUpdate(roomKey);
          debouncePersist();
        }
      } catch (err) {
        console.error("[chat] Append error:", err.message);
      }
    });
  }

}

export function initChat(sdk, options = {}) {
  if (options.safeStorage) safeStore = options.safeStorage;
  if (options.storagePath) dataPath = options.storagePath;
  localId = sdk.publicKey ? b4a.toString(sdk.publicKey, "hex").slice(0, 8).toLowerCase() : "local";

  initModeration().catch((e) => console.warn("[chat] Moderation blocklist load failed:", e.message));

  loadData();

  // Unref'd so a peer-count heartbeat never keeps a process alive on its own.
  setInterval(() => {
    if (globalSseClients.length > 0) sendPeerCount();
  }, 10_000).unref?.();

  const handleTopicsChange = (conn, info) => {
    const peer = peerForConnection(conn) || pendingPeers.get(conn);
    if (!peer) return;

    const nextRooms = sharedRoomsFromTopics(info?.topics, discoveryKeys);
    const newlyShared = addedRooms(peer.rooms, nextRooms);
    peer.rooms = nextRooms;

    if (pendingPeers.has(conn)) return;
    if (!newlyShared.length) return;
    shareProfile(conn, newlyShared);
    shareRoomMeta(conn, newlyShared);
    shareMembers(conn, newlyShared);
    announceJoins(conn, newlyShared);

    (async () => {
      for (const roomKey of newlyShared) {
        await syncRoomHistoryTo(conn, roomKey);
      }
      if (!conn.destroyed) {
        try { writeToConnection(conn, JSON.stringify({ type: "sync-done" }) + "\n"); } catch {}
      }
    })().catch(() => {});
  };

  sdk.localSwarm?.on("topics-change", handleTopicsChange);

  sdk.swarm.on("connection", (conn, info = {}) => {
    const remoteId = conn.remotePublicKey
      ? b4a.toString(conn.remotePublicKey, "hex").slice(0, 8).toLowerCase()
      : "peer";
    const fullId = conn.remotePublicKey
      ? b4a.toString(conn.remotePublicKey, "hex").toLowerCase()
      : remoteId;

    const peerRooms = sharedRoomsFromTopics(info.topics, discoveryKeys);
    const isChat = peerRooms.length > 0;

    if (!isChat) {
      conn.on("error", () => {});
      return;
    }

    if (chatTransports.has(conn)) {
      handleTopicsChange(conn, info);
      return;
    }

    conn.on("error", (e) => console.error(`[chat] Peer [${remoteId}]:`, e.message));

    let buf = "";
    let active = false;
    let pingTimer = null;
    const peer = { conn, id: remoteId, fullId, rooms: peerRooms };
    pendingPeers.set(conn, peer);

    const transport = attachChatTransport(conn, handleChatData, {
      onopen: activatePeer,
      onclose: deactivatePeer,
    });
    if (!transport) {
      pendingPeers.delete(conn);
      return;
    }
    chatTransports.set(conn, transport);

    function activatePeer() {
      if (active || conn.destroyed) return;
      active = true;
      pendingPeers.delete(conn);
      peers.push(peer);
      broadcastPeerCountNow();
      broadcastGlobal("peer-status", { peerId: remoteId, isOnline: true });

      shareProfile(conn);
      shareRoomMeta(conn);
      shareMembers(conn);
      announceJoins(conn);
      shareDMInvites(conn, remoteId);
      syncHistoryTo(conn).catch(() => {});

      pingTimer = setInterval(() => {
        if (conn.destroyed) { clearInterval(pingTimer); return; }
        try { writeToConnection(conn, JSON.stringify({ type: "ping" }) + "\n"); } catch {}
      }, PING_MS);
    }

    function deactivatePeer() {
      pendingPeers.delete(conn);
      if (!active) return;
      active = false;
      if (pingTimer) clearInterval(pingTimer);
      pingTimer = null;
      peers = peers.filter((candidate) => candidate.conn !== conn);
      broadcastPeerCountDelayed();
      const stillConnected = peers.some((candidate) =>
        candidate.id === remoteId && !candidate.conn.destroyed
      );
      if (!stillConnected) {
        broadcastGlobal("peer-status", { peerId: remoteId, isOnline: false });
      }
    }

    function handleChatData(raw) {
      buf += raw.toString();
      const lines = buf.split("\n");
      buf = lines.pop();
      for (const line of lines) {
        if (!line) continue;
        try {
          if (line.length > MAX_MSG_LEN * 4) continue;
          const msg = JSON.parse(line);

          if (
            msg.roomKey &&
            !DM_CONTROL_TYPES.has(msg.type) &&
            !connectionSharesRoom(conn, msg.roomKey)
          ) continue;

          if (msg.type === "ping") {
            try { writeToConnection(conn, JSON.stringify({ type: "pong" }) + "\n"); } catch {}
            continue;
          }
          if (msg.type === "pong") continue;

          if (msg.type === "profile") {
            if (msg.username) {
              const uname = clamp(msg.username, 50);
              const ubio = clamp(msg.bio, MAX_BIO_LEN);
              const uavatar = sanitizeAvatar(msg.avatar);
              savedData.peerProfiles[remoteId] = { username: uname, bio: ubio, avatar: uavatar, updatedAt: Date.now() };
              for (const room of Object.values(savedData.rooms)) {
                if (room.isDM && normPeerId(room.dmWith) === remoteId) {
                  room.name = uname;
                  room.bio = ubio || "";
                  room.avatar = uavatar;
                }
              }

              const peerEntry = peerForConnection(conn);
              const peerRoomKeys = Array.isArray(msg.rooms)
                ? msg.rooms.filter((rk) =>
                    isValidRoomKey(rk) &&
                    savedData.rooms[rk] &&
                    peerSharesRoom(peerEntry, rk)
                  )
                : (peerEntry?.rooms || []);
              for (const rk of peerRoomKeys) {
                const room = savedData.rooms[rk];
                if (!room) continue;
                if (!room.members) room.members = {};
                room.members[remoteId] = {
                  ...(room.members[remoteId] || {}),
                  username: uname, bio: ubio, avatar: uavatar,
                  joinedAt: room.members[remoteId]?.joinedAt || Date.now(),
                };
              }
              debouncePersist();
              broadcastGlobal("member-update", { peerId: remoteId, username: uname, bio: ubio, avatar: uavatar, isOnline: true, rooms: peerRoomKeys });
            }
            continue;
          }

          if (msg.type === "join") {
            if (!msg.roomKey || !msg.peerId) continue;
            const joinPeerId = remoteId || msg.peerId;
            // Block join using the connection-level peer identity, not the self-reported body.
            if (moderationIsKicked(joinPeerId, msg.roomKey)) continue;
            const joinName = clamp(msg.username, 50) || joinPeerId;
            const room = savedData.rooms[msg.roomKey];
            const alreadyKnownMember = !!(room?.members?.[joinPeerId]?.joinedAt);
            if (room) {
              if (!room.members) room.members = {};
              room.members[joinPeerId] = {
                ...(room.members[joinPeerId] || {}),
                username: joinName,
                bio: clamp(msg.bio, MAX_BIO_LEN),
                avatar: sanitizeAvatar(msg.avatar),
                joinedAt: room.members[joinPeerId]?.joinedAt || Date.now(),
              };
              debouncePersist();
              broadcastGlobal("member-update", { peerId: joinPeerId, username: joinName, bio: clamp(msg.bio, MAX_BIO_LEN), avatar: sanitizeAvatar(msg.avatar), isOnline: true, rooms: [msg.roomKey] });
            }

            const sysId = msg.id || `${msg.roomKey}-${joinPeerId}-join-${msg.ts || Date.now()}`;
            if (roomFeeds[msg.roomKey] && !alreadyKnownMember && trackId(sysId)) {
              appendToFeed(msg.roomKey, { id: sysId, type: "system", text: `${joinName} joined`, ts: msg.ts || Date.now() }).catch(() => {});
            }

            // Explicitly send the meta back to the peer who just joined
            sendRoomMeta(conn, msg.roomKey); 
            syncRoomHistoryTo(conn, msg.roomKey).then(() => {
              if (!conn.destroyed) {
                try { writeToConnection(conn, JSON.stringify({ type: "sync-done" }) + "\n"); } catch {}
              }
            }).catch(() => {});
            continue;
          }

          if (msg.type === "dm-invite") {
            if (!msg.roomKey || !isValidRoomKey(msg.roomKey)) continue;
            if (moderationIsKicked(remoteId, msg.roomKey)) continue;
            if (msg.toId && normPeerId(msg.toId) !== normPeerId(localId)) continue;
            if (savedData.rooms[msg.roomKey]) {
              try {
                writeToConnection(conn, JSON.stringify({
                  type: "dm-accept", roomKey: msg.roomKey,
                  fromId: localId, fromUsername: savedData.profile?.username || localId,
                  fromAvatar: savedData.profile?.avatar || null,
                  fromBio: savedData.profile?.bio || "",
                }) + "\n");
              } catch {}
              continue;
            }
            const fromName = clamp(msg.fromUsername, MAX_NAME_LEN) || remoteId;
            const fromAvatar = sanitizeAvatar(msg.fromAvatar);
            const fromBio = clamp(msg.fromBio, MAX_BIO_LEN);
            if (!savedData.pendingDMs) savedData.pendingDMs = {};
            if (!savedData.pendingDMs[msg.roomKey]) {
              savedData.pendingDMs[msg.roomKey] = {
                roomKey: msg.roomKey, fromId: remoteId,
                fromUsername: fromName, fromAvatar, fromBio,
                receivedAt: Date.now(),
              };
              persistData();
            }
            broadcastGlobal("dm-invite", {
              roomKey: msg.roomKey, fromId: remoteId, fromUsername: fromName,
              fromAvatar, fromBio,
            });
            continue;
          }

          if (msg.type === "dm-accept") {
            if (!msg.roomKey || !isValidRoomKey(msg.roomKey)) continue;
            const room = savedData.rooms[msg.roomKey];
            if (!room || !room.isDM) continue;
            if (normPeerId(room.dmWith) !== remoteId) continue;
            const acceptName = clamp(msg.fromUsername, MAX_NAME_LEN) || remoteId;
            const acceptAvatar = sanitizeAvatar(msg.fromAvatar);
            const acceptBio = clamp(msg.fromBio, MAX_BIO_LEN);
            const fromPeer = remoteId;
            if (fromPeer && normPeerId(room.dmWith) === fromPeer) {
              room.avatar = acceptAvatar;
              room.bio = acceptBio || "";
              room.pendingAcceptance = false;
              room.dmWith = fromPeer;
              debouncePersist();
            }
            broadcastGlobal("dm-accepted", {
              roomKey: msg.roomKey, fromId: remoteId, fromUsername: acceptName,
              fromAvatar: acceptAvatar, fromBio: acceptBio,
            });
            continue;
          }

          if (msg.type === "dm-reject") {
            if (!msg.roomKey || !isValidRoomKey(msg.roomKey)) continue;
            const room = savedData.rooms[msg.roomKey];
            if (!room?.isDM || normPeerId(room.dmWith) !== remoteId) continue;
            broadcastGlobal("dm-rejected", {
              roomKey: msg.roomKey, fromId: remoteId,
              fromUsername: clamp(msg.fromUsername, MAX_NAME_LEN) || remoteId,
            });
            continue;
          }

          if (msg.type === "room-meta") {
            const room = savedData.rooms[msg.roomKey];
            if (!room) continue;
            if (moderationIsKicked(remoteId, msg.roomKey)) continue;
            if (room.isDM) { emitRoomUpdate(msg.roomKey); continue; }

            const incomingName = clamp(msg.name, MAX_NAME_LEN);
            const currentIsPlaceholder = !room.name || room.name === msg.roomKey?.slice(0, 8) + "...";
            const incomingIsPlaceholder = !incomingName || incomingName === msg.roomKey?.slice(0, 8) + "...";

            let updated = false;

            // Only accept name if ours is a placeholder AND incoming is real
            if (currentIsPlaceholder && !incomingIsPlaceholder) {
              room.name = incomingName;
              updated = true;
            }

            // Only fill bio/link/avatar/creator if currently missing - prevents spoofing
            if (msg.bio && !room.bio) { room.bio = clamp(msg.bio, MAX_BIO_LEN); updated = true; }
            if (msg.link && !room.link) { room.link = clamp(msg.link, MAX_LINK_LEN) || ""; updated = true; }
            if (msg.avatar && !room.avatar) {
              room.avatar = sanitizeAvatar(msg.avatar);
              if (room.avatar) updated = true;
            }
            if (msg.createdBy && !room.createdBy) { room.createdBy = clamp(msg.createdBy, MAX_SENDER_LEN); updated = true; }
            if (msg.createdByName && !room.createdByName) { room.createdByName = clamp(msg.createdByName, 50); updated = true; }

            // The host owns the room's moderation settings, so mirror whatever
            // they send and never let a remote peer rewrite our own when we are
            // the host. `room.isHost` is about us, not the sender.
            if (msg.moderation && !room.isHost) {
              const next = sanitizeRoomModeration(msg.moderation);
              if (JSON.stringify(next) !== JSON.stringify(room.moderation)) {
                room.moderation = next;
                updated = true;
              }
            }

            if (updated) {
              debouncePersist();
              emitRoomUpdate(msg.roomKey);
            }
            continue;
          }

          if (msg.type === "request-room-meta") {
            if (msg.roomKey && moderationIsKicked(remoteId, msg.roomKey)) continue;
            if (msg.roomKey && savedData.rooms[msg.roomKey]) {
              sendRoomMeta(conn, msg.roomKey);
            }
            continue;
          }

          if (msg.type === "leave") {
            if (msg.roomKey && msg.peerId) {
              if (moderationIsKicked(remoteId, msg.roomKey)) continue;
              const leaveName = clamp(msg.username, 50) || msg.peerId;
              const room = savedData.rooms[msg.roomKey];
              if (room?.members?.[msg.peerId]) {
                delete room.members[msg.peerId];
              }
              const sysId = msg.id || `${msg.roomKey}-${msg.peerId}-left-${msg.ts || Date.now()}`;
              if (roomFeeds[msg.roomKey] && trackId(sysId)) {
                appendToFeed(msg.roomKey, { id: sysId, type: "system", text: `${leaveName} left`, ts: msg.ts || Date.now() }).catch(() => {});
              }
              debouncePersist();
              broadcastGlobal("member-leave", {
                roomKey: msg.roomKey, peerId: msg.peerId,
                username: leaveName,
              });
            }
            continue;
          }

          if (msg.type === "members-list") {
            if (!msg.roomKey || !savedData.rooms[msg.roomKey]) continue;
            if (moderationIsKicked(remoteId, msg.roomKey)) continue;
            const room = savedData.rooms[msg.roomKey];
            if (!room.members) room.members = {};
            const incoming = msg.members || {};
            // Only merge new member profiles, never blindly delete based on incomplete lists
            for (const [peerId, m] of Object.entries(incoming)) {
              if (!room.members[peerId]) room.members[peerId] = m;
            }
            debouncePersist();
            continue;
          }

          if (msg.type === "sync-done") {
            broadcastGlobal("sync-complete", {});
            continue;
          }

          if (msg.type === "sync-reaction") {
            if (!msg.id || !msg.roomKey || !msg.msgId || !roomFeeds[msg.roomKey]) continue;
            if (moderationIsKicked(remoteId, msg.roomKey)) continue;
            const _srRoom = savedData.rooms[msg.roomKey];
            if (_srRoom && !_srRoom.isHost && _srRoom.joinedAt && msg.ts && msg.ts < _srRoom.joinedAt) continue;
            if (!trackId(msg.id)) continue;
            appendToFeed(msg.roomKey, {
              type: "reaction", id: msg.id, msgId: clamp(msg.msgId, 64),
              emoji: clamp(msg.emoji, 10), sender: clamp(msg.sender, MAX_SENDER_LEN),
              sn: clamp(msg.sn, 50), ts: msg.ts || Date.now(),
            }).catch(() => {});
            continue;
          }

          if (msg.type === "sync-system") {
            if (!msg.id || !msg.roomKey || !roomFeeds[msg.roomKey]) continue;
            if (moderationIsKicked(remoteId, msg.roomKey)) continue;
            const _sysRoom = savedData.rooms[msg.roomKey];
            if (_sysRoom && !_sysRoom.isHost && _sysRoom.joinedAt && msg.ts && msg.ts < _sysRoom.joinedAt) continue;
            if (!trackId(msg.id)) continue;
            const _sysRoomMod = savedData.rooms[msg.roomKey]?.moderation || null;
            const sysModeration = moderationCheckContent(msg.text, _sysRoomMod);
            if (sysModeration.flagged) {
              appendModerationNotice(msg.roomKey, msg.id, "Synced history", {
                action: "warn",
                reason: sysModeration.reason,
              }, msg.ts);
              continue;
            }
            appendToFeed(msg.roomKey, { id: msg.id, type: "system", text: msg.text, ts: msg.ts || Date.now() }).catch(() => {});
            continue;
          }

          if (msg.type === "sync") {
            if (!msg.id || !msg.roomKey || !roomFeeds[msg.roomKey]) continue;
            if (moderationIsKicked(remoteId, msg.roomKey)) continue;
            const _syncRoom = savedData.rooms[msg.roomKey];
            if (_syncRoom && !_syncRoom.isHost && _syncRoom.joinedAt && msg.ts && msg.ts < _syncRoom.joinedAt) continue;
            if (!trackId(msg.id)) continue;
            const decrypted = decryptIncomingChat(msg, "synced message");
            if (!decrypted.ok) continue;
            const syncedPayload = decodeMessagePayload(decrypted.plaintext);
            const _syncRoomMod = savedData.rooms[msg.roomKey]?.moderation || null;
            const syncModeration = moderationCheckContent(syncedPayload.text, _syncRoomMod);
            if (syncModeration.flagged) {
              const syncPeerName = clamp(msg.sn, 50) || clamp(msg.sender, MAX_SENDER_LEN) || remoteId;
              appendModerationNotice(msg.roomKey, msg.id, syncPeerName, {
                action: "warn",
                reason: syncModeration.reason,
              }, msg.ts);
              continue;
            }
            cacheDecryptedMessage(msg.roomKey, msg.id, decrypted.plaintext);
            appendToFeed(msg.roomKey, {
              id: msg.id, sender: clamp(msg.sender, MAX_SENDER_LEN), sn: clamp(msg.sn, 50),
              ct: msg.ct, iv: msg.iv, tag: msg.tag, ts: msg.ts,
              ...(msg.replyTo && { replyTo: msg.replyTo }),
              ...(msg.fileName && { fileName: clamp(msg.fileName, MAX_FILE_NAME_LEN) }),
              ...(msg.fileSize != null && { fileSize: msg.fileSize }),
            }).catch(() => {});
            continue;
          }

          if (msg.type === "reaction") {
            if (!msg.id || !msg.roomKey || !msg.msgId || !roomFeeds[msg.roomKey]) continue;
            if (moderationIsKicked(remoteId, msg.roomKey)) continue;
            if (!trackId(msg.id)) continue;
            appendToFeed(msg.roomKey, {
              type: "reaction", id: msg.id, msgId: clamp(msg.msgId, 64),
              emoji: clamp(msg.emoji, 10), sender: remoteId,
              sn: clamp(msg.sn, 50) || remoteId, ts: msg.ts || Date.now(),
            }).catch(() => {});
            continue;
          }

          if (!msg.id || !msg.roomKey || !roomFeeds[msg.roomKey]) continue;
          if (moderationIsKicked(remoteId, msg.roomKey)) continue;
          if (!trackId(msg.id)) continue;

          let moderatedPlaintext = "";
          try {
            const decrypted = decryptIncomingChat(msg, "peer message");
            if (!decrypted.ok) continue;
            const payload = decodeMessagePayload(decrypted.plaintext);
            moderatedPlaintext = decrypted.plaintext;
            const _peerRoomMod = savedData.rooms[msg.roomKey]?.moderation || null;
            const modResult = moderationCheck(remoteId, msg.roomKey, payload.text, undefined, {
              roomModeration: _peerRoomMod,
            });
            if (!modResult.allowed) {
              const peerName = clamp(msg.sn, 50) || savedData.peerProfiles[remoteId]?.username || remoteId;
              appendModerationNotice(msg.roomKey, msg.id, peerName, modResult, msg.ts);
              continue;
            }
          } catch (modErr) {
            console.warn("[chat] Moderation check error:", modErr.message);
            // On error, allow the message through rather than silently dropping
          }
          cacheDecryptedMessage(msg.roomKey, msg.id, moderatedPlaintext);
          appendToFeed(msg.roomKey, {
            id: msg.id, sender: remoteId, sn: clamp(msg.sn, 50) || remoteId,
            ct: msg.ct, iv: msg.iv, tag: msg.tag, ts: msg.ts,
            ...(msg.replyTo && { replyTo: msg.replyTo }),
            ...(msg.fileName && { fileName: clamp(msg.fileName, MAX_FILE_NAME_LEN) }),
            ...(msg.fileSize != null && { fileSize: msg.fileSize }),
          }).catch((e) => console.error("[chat] Peer msg error:", e.message));

          const room = savedData.rooms[msg.roomKey];
          if (room) {
            if (!room.members) room.members = {};
            room.members[remoteId] = {
              username: msg.sn || savedData.peerProfiles[remoteId]?.username || remoteId,
              joinedAt: room.members[remoteId]?.joinedAt || Date.now(),
            };
            debouncePersist();
          }
        } catch {}
      }
    }

    conn.on("close", () => {
      deactivatePeer();
    });
  });

  // Install the connection listeners before joining. A discovered LAN peer can
  // connect immediately, especially when both instances run on the same host.
  for (const roomKey of Object.keys(savedData.rooms)) {
    joinRoom(sdk, roomKey).catch((error) => {
      console.error(`[chat] Auto-join ${roomKey.slice(0, 8)}: ${error.message}`);
    });
  }
}

function respond(status, data) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export async function handleChatRequest(req, sdk) {
  const urlObj = new URL(req.url);
  const action = urlObj.searchParams.get("action");
  const roomKey = urlObj.searchParams.get("roomKey");

  try {
    if (req.method === "POST") {
      if (action === "create-key") {
        const body = await req.json().catch(() => ({}));
        if (body.avatar != null && body.avatar !== "" && sanitizeAvatar(body.avatar) === null) {
          return respond(400, { error: "Invalid room image" });
        }
        const key = randomBytes(32).toString("hex");
        savedData.rooms[key] = {
          roomKey: key, isHost: true,
          name: clamp(body.name, MAX_NAME_LEN) || "New Room",
          bio: clamp(body.bio, MAX_BIO_LEN),
          link: clamp(body.link, MAX_LINK_LEN) || "",
          avatar: sanitizeAvatar(body.avatar),
          createdAt: Date.now(),
          createdBy: localId,
          createdByName: savedData.profile?.username || localId,
          isPinned: false, isMuted: false,
          unreadCount: 0, unreadMentions: 0,
          lastMessage: null, members: {},
          moderation: sanitizeRoomModeration(body.moderation),
        };
        persistData();
        return respond(200, { roomKey: key });
      }

      if (action === "join-dm") {
        const body = await req.json().catch(() => ({}));
        const dmRoomKey = body.roomKey;
        const toId = clamp(body.toId, MAX_SENDER_LEN);
        const toUsername = clamp(body.toUsername, MAX_NAME_LEN) || toId;
        const toAvatar = sanitizeAvatar(body.toAvatar);
        const toBio = clamp(body.toBio, MAX_BIO_LEN);
        if (!dmRoomKey || !isValidRoomKey(dmRoomKey)) return respond(400, { error: "Invalid room key" });
        if (!toId) return respond(400, { error: "toId required" });
        const toIdNorm = normPeerId(toId);
        if (!savedData.rooms[dmRoomKey]) {
          savedData.rooms[dmRoomKey] = {
            roomKey: dmRoomKey, isHost: false, isDM: true,
            dmWith: toIdNorm,
            name: toUsername, bio: toBio || "", avatar: toAvatar || null,
            createdAt: Date.now(),
            createdBy: localId,
            createdByName: savedData.profile?.username || localId,
            isPinned: false, isMuted: false,
            unreadCount: 0, unreadMentions: 0,
            lastMessage: null, members: {},
            pendingAcceptance: true,
          };
          persistData();
        }
        await joinRoom(sdk, dmRoomKey).catch(() => {});
        const inviteMsg = JSON.stringify({
          type: "dm-invite", roomKey: dmRoomKey,
          fromId: localId, fromUsername: savedData.profile?.username || localId,
          fromAvatar: savedData.profile?.avatar || null,
          fromBio: savedData.profile?.bio || "",
          toId: toIdNorm,
        }) + "\n";
        relayToPeer(toIdNorm, inviteMsg);
        return respond(200, { roomKey: dmRoomKey });
      }

      if (action === "accept-dm") {
        const body = await req.json().catch(() => ({}));
        const dmRoomKey = body.roomKey;
        if (!dmRoomKey || !isValidRoomKey(dmRoomKey)) return respond(400, { error: "Invalid room key" });
        if (!savedData.pendingDMs) savedData.pendingDMs = {};
        const pending = savedData.pendingDMs[dmRoomKey];
        if (!pending) return respond(404, { error: "No pending DM invite" });
        const peerNorm = normPeerId(pending.fromId);
        savedData.rooms[dmRoomKey] = {
          roomKey: dmRoomKey, isHost: false, isDM: true,
          dmWith: peerNorm,
          name: pending.fromUsername, bio: pending.fromBio || "",
          avatar: pending.fromAvatar || null,
          createdAt: pending.receivedAt || Date.now(),
          createdBy: peerNorm, createdByName: pending.fromUsername,
          isPinned: false, isMuted: false,
          unreadCount: 0, unreadMentions: 0,
          lastMessage: null, members: {},
          pendingAcceptance: false,
        };
        delete savedData.pendingDMs[dmRoomKey];
        persistData();
        await joinRoom(sdk, dmRoomKey).catch(() => {});
        const acceptMsg = JSON.stringify({
          type: "dm-accept", roomKey: dmRoomKey,
          fromId: localId, fromUsername: savedData.profile?.username || localId,
          fromAvatar: savedData.profile?.avatar || null,
          fromBio: savedData.profile?.bio || "",
        }) + "\n";
        relayToPeer(peerNorm, acceptMsg);
        return respond(200, { roomKey: dmRoomKey });
      }

      if (action === "reject-dm") {
        const body = await req.json().catch(() => ({}));
        const dmRoomKey = body.roomKey;
        if (!dmRoomKey || !isValidRoomKey(dmRoomKey)) return respond(400, { error: "Invalid room key" });
        if (!savedData.pendingDMs) savedData.pendingDMs = {};
        const pending = savedData.pendingDMs[dmRoomKey];
        if (!pending) return respond(404, { error: "No pending DM invite" });
        const peerNorm = normPeerId(pending.fromId);
        delete savedData.pendingDMs[dmRoomKey];
        persistData();
        const rejectMsg = JSON.stringify({
          type: "dm-reject", roomKey: dmRoomKey,
          fromId: localId, fromUsername: savedData.profile?.username || localId,
        }) + "\n";
        relayToPeer(peerNorm, rejectMsg);
        return respond(200, { ok: true });
      }

      if (action === "join") {
        if (!roomKey || !isValidRoomKey(roomKey)) return respond(400, { error: "Invalid room key" });
        const isNew = !savedData.rooms[roomKey];
        if (isNew) {
          savedData.rooms[roomKey] = {
            roomKey, isHost: false,
            name: roomKey.slice(0, 8) + "...",
            bio: "", createdAt: Date.now(),
            createdBy: "", createdByName: "",
            isPinned: false, isMuted: false,
            unreadCount: 0, unreadMentions: 0,
            lastMessage: null, members: {},
            // Filters stay on until the host's room-meta arrives with the real
            // settings. Starting permissive would leak content the host chose
            // to filter during the window before meta lands.
            moderation: { ...DEFAULT_ROOM_MODERATION },
          };
          persistData();
        }
        await joinRoom(sdk, roomKey);

        const uname = savedData.profile?.username || localId;
        const joinTs = Date.now();
        const joinId = `${roomKey}-${localId}-join-${joinTs}`;
        const room = savedData.rooms[roomKey];
        if (room && !room.joinedAt) { room.joinedAt = joinTs; debouncePersist(); }
        if (roomFeeds[roomKey] && trackId(joinId)) {
          appendToFeed(roomKey, { id: joinId, type: "system", text: `${uname} joined`, ts: joinTs }).catch(() => {});
        }

        const joinMsg = JSON.stringify({
          type: "join", roomKey,
          peerId: localId,
          username: uname,
          bio: savedData.profile?.bio || "",
          avatar: savedData.profile?.avatar || null,
          id: joinId,
          ts: joinTs,
        }) + "\n";
        relayToRoom(roomKey, joinMsg);

        if (isNew) {
          for (let i = 0; i < 20; i++) {
            await new Promise((r) => setTimeout(r, 500));
            if (savedData.rooms[roomKey]?.name !== roomKey.slice(0, 8) + "...") break;
          }
          if (savedData.rooms[roomKey]) emitRoomUpdate(roomKey);
        }

        return respond(200, { message: "Joined", identity: localId, room });
      }

      if (action === "react") {
        if (!roomKey || !isValidRoomKey(roomKey)) return respond(400, { error: "Invalid room key" });
        if (!roomFeeds[roomKey]) return respond(404, { error: "Room not found" });
        const body = await req.json();
        if (!body.msgId) return respond(400, { error: "Missing msgId" });
        const id = randomBytes(16).toString("hex");
        if (!trackId(id)) return respond(200, { ok: true });
        const emoji = clamp(body.emoji || "", 10);
        const entry = {
          type: "reaction", id, msgId: clamp(body.msgId, 64), emoji,
          sender: localId, sn: savedData.profile?.username || localId, ts: Date.now(),
        };
        await appendToFeed(roomKey, entry);
        relayToRoom(roomKey, JSON.stringify({ ...entry, roomKey }) + "\n");
        return respond(200, { ok: true });
      }

      if (action === "send") {
        if (!roomKey || !isValidRoomKey(roomKey)) return respond(400, { error: "Invalid room key" });
        if (!roomFeeds[roomKey]) return respond(404, { error: "Room not found" });
        if (!checkRate(roomKey)) return respond(429, { error: "Rate limited" });

        const body = await req.json();
        const message = clamp(body.message, MAX_MSG_LEN);
        if (!message) return respond(400, { error: "Empty message" });

        const _sendRoom = savedData.rooms[roomKey];
        const _sendRoomMod = _sendRoom?.moderation || null;

        const modResult = moderationCheck(localId, roomKey, message, undefined, {
          allowKick: false,
          checkSpam: false,
          roomModeration: _sendRoomMod,
        });

        if (!modResult.allowed) {
          return respond(403, {
            error: `Message blocked: ${modResult.reason}`,
            moderation: true,
            action: modResult.action,
            blockedUntil: modResult.blockedUntil,
            remainingMs: modResult.remainingMs,
          });
        }
        const id = randomBytes(16).toString("hex");
        if (!trackId(id)) return respond(200, { message: "Duplicate" });

        let preview = null;
        if (savedData.profile?.linkPreview !== false) {
          const previewUrl = extractFirstHttpUrl(message);
          if (previewUrl && !moderationCheckContent(previewUrl, _sendRoomMod).flagged) {
            try {
              const resolved = await resolveLinkPreview(previewUrl);
              const previewText = `${resolved?.title || ""} ${resolved?.description || ""}`;
              if (resolved && !moderationCheckContent(previewText, _sendRoomMod).flagged) {
                preview = sanitizePreview(resolved);
              }
            } catch {
              // Preview metadata is optional; a fetch failure never blocks the message.
            }
          }
        }

        const payload = encodeMessagePayload(message, preview);
        const { ct, iv, tag } = encryptMsg(payload, roomKey);
        const ts = Date.now();
        const sn = savedData.profile?.username || localId;
        const replyTo = body.replyTo ? {
          id: clamp(body.replyTo.id, 64),
          sender: clamp(body.replyTo.sender, MAX_SENDER_LEN),
          sn: clamp(body.replyTo.sn, 50),
          text: clamp(body.replyTo.text, 200),
        } : null;
        let fileName = null;
        let fileSize = null;
        if (body.fileName != null && String(body.fileName).trim() !== "") {
          fileName = clamp(String(body.fileName), MAX_FILE_NAME_LEN);
        }
        if (typeof body.fileSize === "number" && Number.isFinite(body.fileSize) && body.fileSize >= 0) {
          fileSize = Math.floor(body.fileSize);
        }
        const entry = {
          id, sender: localId, sn, ct, iv, tag, ts,
          ...(replyTo && { replyTo }),
          ...(fileName && { fileName }),
          ...(fileSize != null && fileName && { fileSize }),
        };

        cacheDecryptedMessage(roomKey, id, payload);
        await appendToFeed(roomKey, entry);
        relayToRoom(roomKey, JSON.stringify({ ...entry, roomKey }) + "\n");
        return respond(200, {
          message: "Sent",
          sent: {
            id, sender: localId, senderName: sn, message, timestamp: ts, replyTo: replyTo || null, roomKey,
            ...(preview && { preview }),
            ...(fileName && { fileName }),
            ...(fileSize != null && { fileSize }),
          },
        });
      }

      if (action === "save-profile") {
        const body = await req.json();
        if (body.avatar != null && body.avatar !== "" && sanitizeAvatar(body.avatar) === null) {
          return respond(400, { error: "Invalid profile image" });
        }
        const parsedName = parseProfileUsername(body.username ?? "");
        if (parsedName === null) {
          return respond(400, { error: "Username may only contain letters, numbers, and spaces (max 50 characters)." });
        }
        const nextUsername = parsedName || savedData.profile?.username || "";
        if (!nextUsername) {
          return respond(400, { error: "Username required." });
        }
        const nextAvatar = body.avatar !== undefined
          ? sanitizeAvatar(body.avatar)
          : savedData.profile?.avatar || null;
        savedData.profile = {
          username: nextUsername,
          bio: clamp(body.bio, MAX_BIO_LEN),
          avatar: nextAvatar,
          createdAt: savedData.profile?.createdAt || Date.now(),
          notifications: body.notifications !== undefined ? !!body.notifications : (savedData.profile?.notifications ?? true),
          linkPreview: body.linkPreview !== undefined ? !!body.linkPreview : (savedData.profile?.linkPreview ?? true),
        };
        savedData.peerProfiles[localId] = {
          username: savedData.profile.username,
          bio: savedData.profile.bio || "",
          avatar: savedData.profile.avatar || null,
          updatedAt: Date.now(),
        };
        for (const room of Object.values(savedData.rooms)) {
          if (room.isHost && room.createdBy === localId) {
            room.createdByName = savedData.profile.username || localId;
          }
        }
        persistData();

        for (const p of peers) {
          if (!p.conn.destroyed) shareProfile(p.conn, p.rooms);
        }
        broadcastGlobal("profile-update", {
          peerId: localId,
          username: savedData.profile.username,
          bio: savedData.profile.bio || "",
          avatar: savedData.profile.avatar || null,
        });

        return respond(200, { ok: true, profile: { ...savedData.profile, id: localId } });
      }

      if (action === "update-room") {
        if (!roomKey || !isValidRoomKey(roomKey)) return respond(400, { error: "Invalid room key" });
        const room = savedData.rooms[roomKey];
        if (!room) return respond(404, { error: "Room not found" });
        const body = await req.json();
        if (body.name !== undefined) room.name = clamp(body.name, MAX_NAME_LEN);
        if (body.bio !== undefined) room.bio = clamp(body.bio, MAX_BIO_LEN);
        if (body.isPinned !== undefined) room.isPinned = !!body.isPinned;
        if (body.isMuted !== undefined) room.isMuted = !!body.isMuted;
        persistData();
        emitRoomUpdate(roomKey);
        return respond(200, { ok: true });
      }

      if (action === "delete-room") {
        if (!roomKey || !isValidRoomKey(roomKey)) return respond(400, { error: "Invalid room key" });
        const leaveTs = Date.now();
        const leaveId = `${roomKey}-${localId}-left-${leaveTs}`;
        const leaveMsg = JSON.stringify({
          type: "leave", peerId: localId,
          username: savedData.profile?.username || localId, roomKey,
          id: leaveId, ts: leaveTs,
        }) + "\n";
        relayToRoom(roomKey, leaveMsg);
        try {
          await sdk.leave(deriveTopic(roomKey));
        } catch (e) {
          console.warn(`[chat] Leave ${roomKey.slice(0, 8)}: ${e.message}`);
        }
        for (const s of roomSseClients[roomKey] || []) { try { s.end(); } catch {} }
        delete roomSseClients[roomKey];
        delete roomFeeds[roomKey];
        joinedRooms.delete(roomKey);
        for (const [discoveryKey, mappedRoomKey] of discoveryKeys) {
          if (mappedRoomKey === roomKey) discoveryKeys.delete(discoveryKey);
        }
        delete savedData.rooms[roomKey];
        if (activeRoom === roomKey) activeRoom = null;
        persistData();
        return respond(200, { ok: true });
      }

      if (action === "mark-read") {
        if (!roomKey || !isValidRoomKey(roomKey)) return respond(400, { error: "Invalid room key" });
        const room = savedData.rooms[roomKey];
        if (room) {
          room.unreadCount = 0;
          room.unreadMentions = 0;
          room.lastReadTs = Date.now();
          persistData();
        }
        return respond(200, { ok: true });
      }

      if (action === "set-active") {
        activeRoom = roomKey && isValidRoomKey(roomKey) ? roomKey : null;
        if (activeRoom) {
          const room = savedData.rooms[activeRoom];
          if (room) { room.unreadCount = 0; room.unreadMentions = 0; persistData(); }
        }
        return respond(200, { ok: true });
      }

      if (action === "request-meta") {
        if (!roomKey || !isValidRoomKey(roomKey)) return respond(400, { error: "Invalid room key" });

        // Ensure the room exists locally before broadcasting (prevents spam amplification)
        if (!savedData.rooms[roomKey]) return respond(403, { error: "Not a member of this room" });

        const requestMsg = JSON.stringify({
          type: "request-room-meta", roomKey
        }) + "\n";
        relayToRoom(roomKey, requestMsg);
        return respond(200, { ok: true });
      }
    }

    if (req.method === "GET") {
      if (action === "get-profile") {
        return respond(200, {
          id: localId,
          username: savedData.profile?.username || "",
          bio: savedData.profile?.bio || "",
          avatar: savedData.profile?.avatar || null,
          createdAt: savedData.profile?.createdAt || 0,
          notifications: savedData.profile?.notifications ?? true,
          linkPreview: savedData.profile?.linkPreview ?? true,
        });
      }

      if (action === "get-rooms") {
        const rooms = [];
        for (const [k, r] of Object.entries(savedData.rooms)) {
          rooms.push({
            roomKey: k,
            name: r.name || k.slice(0, 8) + "...",
            bio: r.bio || "",
            link: r.link || "",
            avatar: r.avatar || null,
            isHost: !!r.isHost,
            isDM: !!r.isDM,
            dmWith: r.dmWith || null,
            pendingAcceptance: !!r.pendingAcceptance,
            isPinned: !!r.isPinned,
            isMuted: !!r.isMuted,
            createdAt: r.createdAt || 0,
            createdBy: r.createdBy || "",
            createdByName: r.createdByName || "",
            lastMessage: r.lastMessage || null,
            unreadCount: r.unreadCount || 0,
            unreadMentions: r.unreadMentions || 0,
            lastReadTs: r.lastReadTs || 0,
            members: r.members || {},
            moderation: r.moderation || null,
          });
        }
        prunePeers();
        const onlinePeers = [...new Set(peers.map((p) => p.id))];
        return respond(200, { rooms, peerProfiles: savedData.peerProfiles || {}, onlinePeers, pendingDMs: savedData.pendingDMs || {} });
      }

      if (action === "get-history") {
        if (!roomKey || !isValidRoomKey(roomKey)) return respond(400, { error: "Invalid room key" });
        const feed = roomFeeds[roomKey];
        if (!feed) {
          if (savedData.rooms[roomKey]) return respond(200, { messages: [] });
          return respond(404, { error: "Room not found" });
        }
        const room = savedData.rooms[roomKey];
        const joinedAt = (room && !room.isHost && room.joinedAt) ? room.joinedAt : 0;
        const messages = [];
        const dedupIds = new Set();
        for (let i = 0; i < feed.length; i++) {
          try {
            const msg = feedEntryToMsg(await feed.get(i), roomKey);
            if (msg.id && dedupIds.has(msg.id)) continue;
            if (msg.id) dedupIds.add(msg.id);
            if (joinedAt && msg.timestamp && msg.timestamp < joinedAt) continue;
            messages.push(msg);
          } catch {}
        }
        messages.sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
        return respond(200, { messages });
      }

      if (action === "receive") {
        if (!roomKey || !isValidRoomKey(roomKey)) return respond(400, { error: "Invalid room key" });
        const feed = roomFeeds[roomKey];
        if (!feed) return respond(404, { error: "Room not found" });

        const stream = new PassThrough();
        stream.write(`event: identity\ndata: ${JSON.stringify({ id: localId })}\n\n`);
        const _rcvRoom = savedData.rooms[roomKey];
        const _rcvJoinedAt = (_rcvRoom && !_rcvRoom.isHost && _rcvRoom.joinedAt) ? _rcvRoom.joinedAt : 0;
        for (let i = 0; i < feed.length; i++) {
          try {
            const _entry = feedEntryToMsg(await feed.get(i), roomKey);
            if (_rcvJoinedAt && _entry.timestamp && _entry.timestamp < _rcvJoinedAt) continue;
            stream.write(`data: ${JSON.stringify(_entry)}\n\n`);
          } catch {}
        }
        const hb = setInterval(() => { try { stream.write("event: heartbeat\ndata: {}\n\n"); } catch {} }, KEEPALIVE_MS);
        if (!roomSseClients[roomKey]) roomSseClients[roomKey] = [];
        roomSseClients[roomKey].push(stream);
        stream.on("close", () => {
          clearInterval(hb);
          roomSseClients[roomKey] = (roomSseClients[roomKey] || []).filter((s) => s !== stream);
        });
        return new Response(stream, {
          status: 200,
          headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" },
        });
      }

      if (action === "receive-all") {
        const stream = new PassThrough();
        stream.write(`event: identity\ndata: ${JSON.stringify({ id: localId })}\n\n`);

        prunePeers();
        const peerCount = new Set(peers.map((peer) => peer.fullId || peer.id)).size;
        stream.write(`event: peersCount\ndata: ${JSON.stringify({ count: peerCount })}\n\n`);

        const onlineIds = [...new Set(peers.map((p) => p.id))];
        stream.write(`event: online-peers\ndata: ${JSON.stringify({ peers: onlineIds })}\n\n`);

        for (const k of Object.keys(savedData.rooms)) {
          const p = roomUpdatePayload(k);
          if (p) stream.write(`event: room-update\ndata: ${JSON.stringify(p)}\n\n`);
        }

        if (savedData.pendingDMs) {
          for (const [rk, dm] of Object.entries(savedData.pendingDMs)) {
            stream.write(`event: dm-invite\ndata: ${JSON.stringify({
              roomKey: rk, fromId: dm.fromId, fromUsername: dm.fromUsername,
              fromAvatar: dm.fromAvatar || null, fromBio: dm.fromBio || "",
            })}\n\n`);
          }
        }

        const hb = setInterval(() => { try { stream.write("event: heartbeat\ndata: {}\n\n"); } catch {} }, KEEPALIVE_MS);
        globalSseClients.push(stream);
        stream.on("close", () => {
          clearInterval(hb);
          const idx = globalSseClients.indexOf(stream);
          if (idx !== -1) globalSseClients.splice(idx, 1);
        });
        return new Response(stream, {
          status: 200,
          headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" },
        });
      }
    }

    return respond(400, { error: "Unknown action" });
  } catch (err) {
    console.error("[chat] Request error:", err);
    return respond(500, { error: "Internal error" });
  }
}
