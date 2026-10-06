/**
 * A join, leave or removal line can carry eight characters of a key where the
 * name belongs. Phones announced themselves before they had a name, and the
 * line went into the room's history as it was written. It reads with the name
 * the person has since, or not at all when they never took one: someone who
 * never had a name was never in the conversation.
 *
 * Shared with mobile (backend/peerchat/notice-names.mjs).
 */
const NOTICE = /^([0-9a-f]{8}) (joined|left|was removed from the room by .+)$/;

export function nameNotice(text, nameFor, isName = () => false) {
  const value = typeof text === "string" ? text : "";
  const match = NOTICE.exec(value);
  if (!match) return value;
  const [, id, rest] = match;
  // Somebody may really be called eight hex letters.
  if (isName(id)) return value;
  const name = nameFor(id);
  if (name && name !== id) return `${name} ${rest}`;
  if (rest === "joined" || rest === "left") return null;
  return `Someone ${rest}`;
}
