/**
 * The earliest creation time anybody in a room reports for it.
 *
 * Wire contract, shared with mobile: room-meta carries createdAt, and each side
 * keeps the earliest plausible answer.
 *
 * Nothing used to share this, so every device stamped the moment it joined and
 * a room whose messages start in April read as created in September on a device
 * that arrived then. A room cannot have been created after the first person who
 * was in it, so the earliest wins and everyone converges without anything being
 * hardcoded.
 *
 * A time in the future is nonsense and is ignored, which is also what stops a
 * peer with a wrong clock dragging the date forward.
 */
export function earliestRoomCreatedAt(current, announced, now = Date.now()) {
  const currentAt = Number.isSafeInteger(current) && current > 0 ? current : 0;
  const announcedAt = Number.isSafeInteger(announced) && announced > 0 ? announced : 0;
  if (!announcedAt || announcedAt > now) return currentAt;
  if (!currentAt) return announcedAt;
  return Math.min(currentAt, announcedAt);
}
