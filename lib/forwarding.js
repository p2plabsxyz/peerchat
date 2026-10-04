// What a message forwards as: its words. A file or picture is sealed with the
// key of the room it was sent to, so it would not open anywhere else, and a
// notice from the app is not anyone's message to pass on.
export function forwardableText(msg) {
  if (!msg || msg.type === "system" || msg.fileName || msg.fileEnc) return null;
  return typeof msg.message === "string" && msg.message.trim() ? msg.message : null;
}

// The picked messages as they will arrive: in the order they were sent, words
// only. A message that is gone, or cannot be forwarded, is left out.
export function forwardTexts(messages, pickedIds) {
  return (messages || [])
    .filter((msg) => msg && pickedIds.has(msg.id))
    .sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0))
    .map(forwardableText)
    .filter(Boolean);
}
