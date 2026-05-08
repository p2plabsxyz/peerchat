/**
 * PeerChat Local Moderation Engine
 *
 * Evaluates messages for spam, NSFW content, abusive language, and adult domain links.
 * Enforcement is purely local — each peer runs moderation independently.
 * All state is in-memory and resets on restart (no permanent bans in a hostless system).
 */

// ---------------------------------------------------------------------------
// Configuration constants (easy to tune)
// ---------------------------------------------------------------------------

/** Maximum messages a single peer may send per sliding window */
export const MAX_MSGS_PER_WINDOW = 10;

/** Sliding-window length in milliseconds */
export const WINDOW_MS = 10_000;

/** Number of violations before the first warning is issued */
export const WARNING_THRESHOLD = 1;

/** Number of violations that triggers an auto-kick */
export const KICK_THRESHOLD = 3;

/** How long (ms) a kicked peer is blocked from rejoining the room */
export const ROOM_REJOIN_COOLDOWN_MS = 5 * 60_000;

// ---------------------------------------------------------------------------
// Internal state (in-memory, per peer+room)
// ---------------------------------------------------------------------------

/**
 * peerId:roomKey → array of message timestamps (sliding window)
 * @type {Map<string, number[]>}
 */
const spamTracker = new Map();

/**
 * peerId:roomKey → cumulative violation count
 * @type {Map<string, number>}
 */
const violationTracker = new Map();

/**
 * peerId:roomKey → timestamp when the peer was kicked
 * @type {Map<string, number>}
 */
const kickList = new Map();

// ---------------------------------------------------------------------------
// Keyword / pattern lists
// ---------------------------------------------------------------------------

/**
 * Conservative abuse keyword list — focused on slurs and direct harassment.
 * Avoids words like "kill" or "die" that are common in gaming contexts.
 * Each entry is a regex pattern matched against the full message (case-insensitive).
 */
const ABUSE_PATTERNS = [
  // Slurs and hate speech
  /\bn[i1!][g9]{1,2}[e3]r\b/i,
  /\bn[i1!][g9]{1,2}[a@]\b/i,
  /\bf[a@][g9]{1,2}[o0]t\b/i,
  /\bf[a@][g9]\b/i,
  /\btr[a@]nn(?:y|ie)\b/i,
  /\br[e3]t[a@]rd(?:ed)?\b/i,
  /\bk[i1!]ke\b/i,
  /\bsp[i1!]c\b/i,
  /\bch[i1!]nk\b/i,
  /\bw[e3]tb[a@]ck\b/i,
  /\bcunt\b/i,
  // Direct harassment
  /\bkys\b/i,
  /\bkill\s*your\s*self\b/i,
  /\bgo\s*die\b/i,
  /\bshoot\s*up\b/i,
  /\brape\s*(you|u|her|him|them)\b/i,
  /\bi('?ll|m\s*going\s*to)\s*(rape|murder|stalk)\b/i,
  // Common profanity
  /\bf+u+c+k+\b/i,
  /\bfuck\s*(you|u|off|ing|er|ed)\b/i,
  /\bsh[i1!]+t+\b/i,
  /\bb[i1!]tch\b/i,
  /\bass\s*hole\b/i,
  /\bdamn\s*(you|it)\b/i,
  /\bstfu\b/i,
  /\bwtf\b/i,
  /\bmotherf/i,
  /\bdick\s*head\b/i,
  /\bdouche\s*bag\b/i,
  /\bwh[o0]re\b/i,
  /\bslut\b/i,
  /\bbastard\b/i,
];

/**
 * NSFW content patterns — catches explicit sexual content keywords.
 */
const NSFW_PATTERNS = [
  /\bp[o0]rn(?:o|ography|hub)?\b/i,
  /\bhentai\b/i,
  /\bxxx\b/i,
  /\bxvideos?\b/i,
  /\bxnxx\b/i,
  /\bxhamster\b/i,
  /\bredtube\b/i,
  /\byouporn\b/i,
  /\bbrazzers\b/i,
  /\bonlyfans\.com\b/i,
  /\bchaturbate\b/i,
  /\blivejasmin\b/i,
  /\bstripchat\b/i,
  /\bmasturbat(?:e|ion|ing)\b/i,
  /\bejaculat(?:e|ion|ing)\b/i,
  /\borgasm\b/i,
  /\banal\s*sex\b/i,
  /\bblowjob\b/i,
  /\bcumshot\b/i,
  /\bdeepthroat\b/i,
  /\bgangbang\b/i,
  /\bhardcore\s*sex\b/i,
  /\bnude(?:s|z)\b/i,
  /\bnsfw\b/i,
  /\bdick\s*pic\b/i,
  // Body / sexual terms
  /\bboob(?:s|ies)?\b/i,
  /\btit(?:s|ties)\b/i,
  /\bdick\b/i,
  /\bcock\b/i,
  /\bpussy\b/i,
  /\bass\b/i,
  /\banus\b/i,
  /\bsex(?:y|ual|ting)?\b/i,
  /\berotic\b/i,
  /\bfetish\b/i,
  /\bstripper\b/i,
  /\bhooker\b/i,
  /\bprostitut/i,
  /\bhorny\b/i,
  /\bjerk\s*off\b/i,
  /\bfap\b/i,
];

/**
 * URL extraction regex — matches http(s), hyper, and bare domain patterns.
 */
const URL_RE = /(?:https?:\/\/|hyper:\/\/)?(?:www\.)?([a-zA-Z0-9-]+(?:\.[a-zA-Z0-9-]+)*\.[a-zA-Z]{2,})(?:[\/\?#][^\s]*)?/gi;

// ---------------------------------------------------------------------------
// Adult domain set — loaded lazily from bundled JSON
// ---------------------------------------------------------------------------

/** @type {Set<string>|null} */
let _adultDomains = null;

/**
 * Load the adult domain blocklist. Works in both Node.js (fs) and browser (fetch) contexts.
 * Falls back to a hardcoded top-50 list if the JSON file is unavailable.
 * @returns {Set<string>}
 */
export function getAdultDomains() {
  if (_adultDomains) return _adultDomains;

  // Hardcoded fallback — the top-50 most trafficked adult domains
  const FALLBACK = [
    "pornhub.com", "xvideos.com", "xnxx.com", "xhamster.com", "redtube.com",
    "youporn.com", "tube8.com", "spankbang.com", "beeg.com", "thumbzilla.com",
    "porntrex.com", "eporner.com", "hqporner.com", "tnaflix.com", "drtuber.com",
    "txxx.com", "voyeurhit.com", "hdzog.com", "sunporno.com", "proporn.com",
    "pornone.com", "4tube.com", "fapcat.com", "zbporn.com", "ashemaletube.com",
    "brazzers.com", "realitykings.com", "bangbros.com", "naughtyamerica.com",
    "digitalplayground.com", "mofos.com", "babes.com", "twistys.com", "vixen.com",
    "blacked.com", "tushy.com", "deeper.com", "slayedofficial.com",
    "onlyfans.com", "chaturbate.com", "livejasmin.com", "stripchat.com",
    "bongacams.com", "cam4.com", "myfreecams.com", "camsoda.com",
    "flirt4free.com", "streamate.com", "imlive.com", "jerkmate.com",
  ];

  _adultDomains = new Set(FALLBACK);

  // Try to load extended list from JSON (async not needed — sync is fine for init)
  try {
    // Node.js path
    if (typeof require !== "undefined") {
      const fs = require("fs");
      const path = require("path");
      const jsonPath = path.join(__dirname, "lib", "adult-domains.json");
      if (fs.existsSync(jsonPath)) {
        const list = JSON.parse(fs.readFileSync(jsonPath, "utf8"));
        if (Array.isArray(list)) {
          for (const d of list) _adultDomains.add(d.toLowerCase());
        }
      }
    }
  } catch {
    // Fallback is already loaded, no action needed
  }

  return _adultDomains;
}

/**
 * Inject a custom domain set (useful for testing).
 * @param {Set<string>} domains
 */
export function setAdultDomains(domains) {
  _adultDomains = domains;
}

// ---------------------------------------------------------------------------
// Core detection functions
// ---------------------------------------------------------------------------

/**
 * Composit key for per-peer-per-room tracking.
 */
function peerRoomKey(peerId, roomKey) {
  return `${peerId}:${roomKey}`;
}

/**
 * Check if a peer is sending messages too fast (spam burst detection).
 * @param {string} peerId
 * @param {string} roomKey
 * @param {number} [now]
 * @returns {boolean} true if the message should be considered spam
 */
export function checkSpam(peerId, roomKey, now) {
  const key = peerRoomKey(peerId, roomKey);
  const ts = now ?? Date.now();

  let window = spamTracker.get(key);
  if (!window) {
    window = [];
    spamTracker.set(key, window);
  }

  // Slide the window — remove timestamps older than WINDOW_MS
  const cutoff = ts - WINDOW_MS;
  while (window.length > 0 && window[0] <= cutoff) {
    window.shift();
  }

  // Record this message
  window.push(ts);

  return window.length > MAX_MSGS_PER_WINDOW;
}

/**
 * Check message text for abusive language.
 * @param {string} text
 * @returns {{ flagged: boolean, reason: string }}
 */
export function checkAbuse(text) {
  if (!text) return { flagged: false, reason: "" };
  for (const pattern of ABUSE_PATTERNS) {
    if (pattern.test(text)) {
      return { flagged: true, reason: "abusive language" };
    }
  }
  return { flagged: false, reason: "" };
}

/**
 * Check message text for NSFW content.
 * @param {string} text
 * @returns {{ flagged: boolean, reason: string }}
 */
export function checkNSFW(text) {
  if (!text) return { flagged: false, reason: "" };
  for (const pattern of NSFW_PATTERNS) {
    if (pattern.test(text)) {
      return { flagged: true, reason: "NSFW content" };
    }
  }
  return { flagged: false, reason: "" };
}

/**
 * Check if the message contains any adult domain links.
 * @param {string} text
 * @returns {{ flagged: boolean, domain: string }}
 */
export function checkAdultDomains(text) {
  if (!text) return { flagged: false, domain: "" };

  const domains = getAdultDomains();
  let match;
  // Reset lastIndex for global regex
  URL_RE.lastIndex = 0;
  while ((match = URL_RE.exec(text)) !== null) {
    const domain = match[1]?.toLowerCase();
    if (!domain) continue;

    // Check exact match and parent domain match (e.g. "www.pornhub.com" → "pornhub.com")
    if (domains.has(domain)) {
      return { flagged: true, domain };
    }
    // Strip leading subdomain
    const parts = domain.split(".");
    if (parts.length > 2) {
      const parent = parts.slice(-2).join(".");
      if (domains.has(parent)) {
        return { flagged: true, domain: parent };
      }
    }
  }
  return { flagged: false, domain: "" };
}

// ---------------------------------------------------------------------------
// Violation tracking & escalation
// ---------------------------------------------------------------------------

/**
 * Record a violation for a peer in a room. Returns the escalation action.
 * @param {string} peerId
 * @param {string} roomKey
 * @returns {'warn' | 'final-warn' | 'kick'}
 */
export function recordViolation(peerId, roomKey) {
  const key = peerRoomKey(peerId, roomKey);
  const count = (violationTracker.get(key) || 0) + 1;
  violationTracker.set(key, count);

  if (count >= KICK_THRESHOLD) return "kick";
  if (count >= KICK_THRESHOLD - 1) return "final-warn";
  return "warn";
}

/**
 * Get the current violation count for a peer in a room.
 * @param {string} peerId
 * @param {string} roomKey
 * @returns {number}
 */
export function getViolations(peerId, roomKey) {
  return violationTracker.get(peerRoomKey(peerId, roomKey)) || 0;
}

/**
 * Reset violations for a peer in a room.
 * @param {string} peerId
 * @param {string} roomKey
 */
export function resetViolations(peerId, roomKey) {
  violationTracker.delete(peerRoomKey(peerId, roomKey));
}

// ---------------------------------------------------------------------------
// Kick list & cooldown
// ---------------------------------------------------------------------------

/**
 * Check if a peer is currently kicked from a room (within cooldown).
 * @param {string} peerId
 * @param {string} roomKey
 * @param {number} [now]
 * @returns {boolean}
 */
export function isKicked(peerId, roomKey, now) {
  const key = peerRoomKey(peerId, roomKey);
  const kickedAt = kickList.get(key);
  if (kickedAt == null) return false;

  const ts = now ?? Date.now();
  if (ts - kickedAt >= ROOM_REJOIN_COOLDOWN_MS) {
    // Cooldown expired — remove from kick list
    kickList.delete(key);
    return false;
  }
  return true;
}

/**
 * Add a peer to the kick list for a room.
 * @param {string} peerId
 * @param {string} roomKey
 * @param {number} [now]
 */
export function addKick(peerId, roomKey, now) {
  kickList.set(peerRoomKey(peerId, roomKey), now ?? Date.now());
}

// ---------------------------------------------------------------------------
// Orchestrator — single entry point for message checks
// ---------------------------------------------------------------------------

/**
 * Run all moderation checks against a message.
 * @param {string} peerId  – sender's peer ID
 * @param {string} roomKey – room the message is in
 * @param {string} text    – plaintext message content
 * @param {number} [now]   – optional timestamp override (for testing)
 * @returns {{ allowed: boolean, reason: string, action: 'none' | 'warn' | 'final-warn' | 'kick' }}
 */
export function checkMessage(peerId, roomKey, text, now) {
  // 1. Is the peer currently kicked?
  if (isKicked(peerId, roomKey, now)) {
    return { allowed: false, reason: "temporarily blocked from this room", action: "kick" };
  }

  // 2. Spam check
  if (checkSpam(peerId, roomKey, now)) {
    const action = recordViolation(peerId, roomKey);
    if (action === "kick") addKick(peerId, roomKey, now);
    return { allowed: false, reason: "spam (too many messages)", action };
  }

  // 3. Abuse check
  const abuse = checkAbuse(text);
  if (abuse.flagged) {
    const action = recordViolation(peerId, roomKey);
    if (action === "kick") addKick(peerId, roomKey, now);
    return { allowed: false, reason: abuse.reason, action };
  }

  // 4. NSFW check
  const nsfw = checkNSFW(text);
  if (nsfw.flagged) {
    const action = recordViolation(peerId, roomKey);
    if (action === "kick") addKick(peerId, roomKey, now);
    return { allowed: false, reason: nsfw.reason, action };
  }

  // 5. Adult domain check
  const adultDomain = checkAdultDomains(text);
  if (adultDomain.flagged) {
    const action = recordViolation(peerId, roomKey);
    if (action === "kick") addKick(peerId, roomKey, now);
    return { allowed: false, reason: `adult domain link (${adultDomain.domain})`, action };
  }

  return { allowed: true, reason: "", action: "none" };
}

// ---------------------------------------------------------------------------
// Reset all state (for testing)
// ---------------------------------------------------------------------------

/**
 * Clear all moderation state. Intended for tests only.
 */
export function resetAll() {
  spamTracker.clear();
  violationTracker.clear();
  kickList.clear();
  _adultDomains = null;
}
