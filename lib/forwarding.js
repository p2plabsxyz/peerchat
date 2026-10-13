// What a message forwards as: its words, or its file. A file or picture is
// opened here and sealed again for the chat it goes to, as one picked from this
// computer would be. A notice from the app is not anyone's message to pass on.
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

// A file or picture to forward: where it is and the key it was sealed with,
// its own in a room whose keys rotate, or else its room's.
export function forwardableFile(msg) {
  if (!msg || msg.type === "system" || !msg.fileName || !msg.fileEnc) return null;
  if (typeof msg.message !== "string" || !/^hyper:\/\//i.test(msg.message)) return null;
  return {
    url: msg.message,
    fileName: msg.fileName,
    fileSize: msg.fileSize || 0,
    fileKey: msg.fileKey || "",
    roomKey: msg.roomKey || "",
  };
}

export function isForwardable(msg) {
  return Boolean(forwardableText(msg) || forwardableFile(msg));
}

// The picked messages as they will arrive: in the order they were sent, each
// as its words or its file. A message that is gone, or cannot be forwarded,
// is left out.
export function forwardItems(messages, pickedIds) {
  return (messages || [])
    .filter((msg) => msg && pickedIds.has(msg.id))
    .sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0))
    .map((msg) => {
      const file = forwardableFile(msg);
      if (file) return { file };
      const text = forwardableText(msg);
      return text ? { text } : null;
    })
    .filter(Boolean);
}

// How long to wait between forwarded messages so the chat's spam limit,
// counted over ten seconds, is never reached: two short of it, which leaves
// room to type. Thirty forwarded at once got the sender kicked.
export function forwardGapMs(spamRateLimit) {
  const limit = Number.isSafeInteger(spamRateLimit) && spamRateLimit > 0 ? spamRateLimit : 10;
  return Math.ceil(10_000 / Math.max(1, limit - 2));
}
