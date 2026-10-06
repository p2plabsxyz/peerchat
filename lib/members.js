/**
 * One row per person, not one per key.
 *
 * A peer id comes from a device key, so somebody who reinstalls, or who joins
 * from a laptop as well as a phone, arrives as a new member under the same
 * name. The room remembers every one of them, and the list then shows the same
 * person twice or three times over with the same picture.
 *
 * Shared with mobile (backend/peerchat/members.mjs) so the member list, the
 * count and the people search all agree on what counts as one person.
 */
export function collapseMembers(members) {
  const byName = new Map();

  for (const member of members) {
    const name = String(member?.username || member?.id || "").toLowerCase();
    if (!name) continue;
    const existing = byName.get(name);
    if (!existing || prefers(member, existing)) byName.set(name, member);
  }

  return [...byName.values()];
}

// You are always yourself. Failing that, the copy that is here now is the one
// worth showing, because it is the one that can be messaged.
function prefers(candidate, existing) {
  if (candidate.self !== existing.self) return candidate.self === true;
  if (candidate.online !== existing.online) return candidate.online === true;
  // Away on one device and here on another is here.
  if (candidate.online && !candidate.idle !== !existing.idle) return !candidate.idle;
  return false;
}

/**
 * The people you can search for, from the welcome room's own member list.
 *
 * Same rules as the member list, because it is the same list: removed people
 * are gone, you are not in your own results, and one row per person. Online
 * first, so whoever can actually be reached is at the top.
 */
export function buildDirectory({
  members = {},
  peerProfiles = {},
  onlinePeers = new Set(),
  idlePeers = new Set(),
  bans = [],
  selfId = "",
  query = "",
} = {}) {
  const removed = new Set((bans || []).map((ban) => ban?.id));
  const q = String(query || "").trim().toLowerCase();

  const people = Object.entries(members || {})
    .filter(([id]) => id !== selfId && !removed.has(id))
    .map(([id, member]) => ({
      id,
      username: peerProfiles[id]?.username || member?.username || id,
      avatar: peerProfiles[id]?.avatar || member?.avatar || null,
      online: onlinePeers.has(id),
      idle: onlinePeers.has(id) && idlePeers.has(id),
      self: false,
    }));

  // Collapsed before the search runs, so the row you see for a name is the same
  // one whether you typed anything or not.
  return collapseMembers(people)
    // Someone who never took a name never took part.
    .filter((person) => person.username !== person.id)
    .filter((person) => !q || person.username.toLowerCase().includes(q))
    .sort((a, b) => (a.online === b.online ? 0 : a.online ? -1 : 1));
}
