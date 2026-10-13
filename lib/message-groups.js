// Back-to-back messages from one person sit together under one name, the way
// other chat apps show them. A gap of a few minutes or a new day starts a new
// group.
export const GROUP_GAP_MS = 5 * 60_000;

// Whether a message joins the group of the one before it. Each is
// { sender, ts }, with every message of yours under one sender.
export function joinsGroup(before, after) {
  if (!before?.sender || before.sender !== after?.sender) return false;
  const gap = after.ts - before.ts;
  if (!(gap >= 0 && gap < GROUP_GAP_MS)) return false;
  return new Date(before.ts).toDateString() === new Date(after.ts).toDateString();
}
