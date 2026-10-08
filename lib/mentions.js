// A mention is "@" and a name someone in the room goes by. Names can have
// spaces, and a person's other devices have a fixed label after an "@"
// ("ada@mobile", see device-link.js), so a mention is read against the names
// the room knows, the longest first. "@ada@mobile" is ada's phone, not ada
// with "@mobile" after it, and "@ada how are you" is ada, not someone called
// "ada how are you". An "@" straight after a letter or digit is part of an
// address, not a mention.
//
// PeerSky Mobile keeps the same rules in app/peerchat/message-text.mjs.

const MAX_NAME = 50;
const NAME_RE = /^[A-Za-z0-9]+(?: [A-Za-z0-9]+)*(?:@(?:mobile|desktop[0-9]{0,3}))?$/;
const LABEL_RE = /@(?:mobile|desktop[0-9]{0,3})$/;
const WORD_RE = /[A-Za-z0-9_]/;

function knownNames(names) {
  const byLower = new Map();
  for (const name of Array.isArray(names) ? names : []) {
    if (typeof name !== "string" || name.length > MAX_NAME || !NAME_RE.test(name)) continue;
    const lower = name.toLowerCase();
    if (!byLower.has(lower)) byLower.set(lower, name);
  }
  return [...byLower.values()].sort((a, b) => b.length - a.length);
}

// Each mention in text, in order, as { start, end, name }: start at the "@",
// end just past the name, and the name as the room knows it.
export function findMentions(text, names) {
  const value = typeof text === "string" ? text : "";
  if (!value.includes("@")) return [];
  const known = knownNames(names);
  if (known.length === 0) return [];
  const lower = value.toLowerCase();
  const found = [];
  let from = 0;
  for (let at = value.indexOf("@"); at !== -1; at = value.indexOf("@", from)) {
    from = at + 1;
    if (at > 0 && WORD_RE.test(value[at - 1])) continue;
    const name = known.find((candidate) => lower.startsWith(candidate.toLowerCase(), at + 1));
    if (!name) continue;
    found.push({ start: at, end: at + 1 + name.length, name });
    from = at + 1 + name.length;
  }
  return found;
}

// The person a name is, without the device label.
export function personName(name) {
  return typeof name === "string" ? name.replace(LABEL_RE, "") : "";
}

// Whether text mentions this person on any of their devices: "@ada@mobile"
// reaches ada's desktop too. ownNames are this device's names, with and
// without its label.
export function mentionsPerson(text, names, ownNames) {
  const mine = (Array.isArray(ownNames) ? ownNames : []).filter((name) => typeof name === "string" && name);
  const own = new Set(mine.map((name) => personName(name).toLowerCase()));
  if (own.size === 0) return false;
  const all = [...(Array.isArray(names) ? names : []), ...mine];
  return findMentions(text, all).some((mention) => own.has(personName(mention.name).toLowerCase()));
}

// Where the mention being typed starts: the "@" before the caret with a space,
// or nothing, before it. A label's "@" ("@ada@mo") belongs to the name, so the
// "@" before that one is the start. -1 when nothing is being mentioned.
export function mentionQueryStart(before) {
  const text = typeof before === "string" ? before : "";
  let at = text.lastIndexOf("@");
  if (at > 0 && /\S/.test(text[at - 1])) at = text.lastIndexOf("@", at - 1);
  if (at === -1 || (at > 0 && /\S/.test(text[at - 1]))) return -1;
  return at;
}
