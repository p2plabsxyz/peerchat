// A burst of messages, such as the catch-up after being away for a while,
// sounds once. Every message used to sound, so fifty came in as fifty sounds
// in a row. Messages a moment apart in a live chat still each sound.
export const CHAT_SOUND_GAP_MS = 1500;

export function createSoundGate(gapMs = CHAT_SOUND_GAP_MS, now = () => Date.now()) {
  let last = -Infinity;
  return {
    /** Whether a sound may play now; if so it counts as played. */
    allow() {
      const at = now();
      if (at - last < gapMs) return false;
      last = at;
      return true;
    },
  };
}
