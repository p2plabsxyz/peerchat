// Searching messages: from the chat list, across every chat this computer
// keeps, and inside one chat. The page (app.js) and the backend (p2p.js), which
// reads the history the page does not hold, look for text the same way. A
// search only ever reads what is kept here; nothing goes to anyone.
import { attachmentKind } from "./render-rules.js";

export const SEARCH_QUERY_MAX = 100;
// The newest this many matches, in all the chats together.
export const SEARCH_RESULT_LIMIT = 50;
// How much history one search reads: each chat's newest entries, and in all,
// the most recently active chats first, so it still answers as it is typed.
export const SEARCH_SCAN_PER_ROOM = 5000;
export const SEARCH_SCAN_TOTAL = 30000;

// What was typed, ready to look for: trimmed, at most a hundred characters.
export function searchQuery(raw) {
  if (typeof raw !== "string") return "";
  return Array.from(raw.trim()).slice(0, SEARCH_QUERY_MAX).join("");
}

const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Finds the query anywhere in a text, whatever its case. Null for no query.
export function queryMatcher(raw) {
  const query = searchQuery(raw);
  return query ? new RegExp(escapeRegExp(query), "iu") : null;
}

// The words a message is found by: a file by its name, never the address it
// is kept at, and nothing for a notice from the app or a reaction.
export function searchableText(msg) {
  if (!msg || msg.type === "system" || msg.type === "reaction") return "";
  const text = typeof msg.message === "string" ? msg.message : "";
  return attachmentKind(text, msg) ? msg.fileName : text;
}

// Where the query is in a text, as { start, end }, or null.
export function findMatch(text, matcher) {
  if (typeof text !== "string" || !text || !matcher) return null;
  const found = matcher.exec(text);
  return found ? { start: found.index, end: found.index + found[0].length } : null;
}

const flat = (text) => text.replace(/\s+/g, " ");

// The part of a message around what was found, on one line, cut short at
// either end: { before, match, after }. A little goes before the match, so it
// still shows in a narrow list, and more after it.
export function snippetAround(text, match, { before = 24, after = 90 } = {}) {
  const head = flat(text.slice(Math.max(0, match.start - before * 4), match.start));
  const tail = flat(text.slice(match.end, match.end + after * 4));
  let lead = head.length > before ? head.slice(head.length - before) : head;
  // Cut where a word starts, when one starts close enough.
  if (lead.length < head.length || match.start > before * 4) {
    const space = lead.indexOf(" ");
    if (space >= 0 && space < before / 2) lead = lead.slice(space + 1);
    lead = "…" + lead.trimStart();
  } else {
    lead = lead.trimStart();
  }
  const cut = tail.length > after || match.end + after * 4 < text.length;
  return {
    before: lead,
    match: flat(text.slice(match.start, match.end)),
    after: cut ? tail.slice(0, after).trimEnd() + "…" : tail.trimEnd(),
  };
}

// A message that has the query in it, as a search result, or null. A file's
// result names the file, which is what was found.
export function searchHit(msg, matcher) {
  const text = searchableText(msg);
  const match = findMatch(text, matcher);
  if (!match) return null;
  return {
    id: msg.id,
    sender: msg.sender,
    senderName: msg.senderName || msg.sender,
    timestamp: msg.timestamp,
    snippet: snippetAround(text, match),
    ...(attachmentKind(msg.message, msg) && { fileName: msg.fileName }),
  };
}

// The newest first, each message once, at most limit of them.
export function newestHits(hits, limit = SEARCH_RESULT_LIMIT) {
  const seen = new Set();
  return [...hits]
    .sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0))
    .filter((hit) => {
      const key = `${hit.roomKey}:${hit.id}`;
      if (!hit.id || seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, limit);
}

// A chat found by its name. A room key matches too, once enough of it is
// typed to mean one room: a letter or two of hex is in nearly every key.
export function roomMatchesQuery(room, raw) {
  const matcher = queryMatcher(raw);
  if (!matcher || !room) return false;
  if (matcher.test(String(room.name || ""))) return true;
  const query = searchQuery(raw).toLowerCase();
  return query.length >= 8 && /^[0-9a-f]+$/.test(query) && String(room.roomKey || "").toLowerCase().includes(query);
}

// When a found message was sent: the time today, "Yesterday", the day of the
// week before that, then the date.
export function searchTimeLabel(ts, now = Date.now()) {
  if (!Number.isFinite(ts) || ts <= 0) return "";
  const sent = new Date(ts);
  const today = new Date(now);
  const day = (date) => new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  const days = Math.round((day(today) - day(sent)) / 86_400_000);
  if (days <= 0) return sent.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  if (days === 1) return "Yesterday";
  if (days < 7) return sent.toLocaleDateString([], { weekday: "long" });
  return sent.toLocaleDateString([], sent.getFullYear() === today.getFullYear()
    ? { month: "short", day: "numeric" }
    : { year: "numeric", month: "short", day: "numeric" });
}
