// Who still counts as online a moment after their connection goes.
//
// Hyperswarm drops and redials as a matter of course, and a phone waking, a
// network changing or a laptop opening its lid all do it too. Acting on every
// offline event meant the peer count and the online dots blinked each time,
// which in a room with a few hundred people never stops.
//
// A peer reported offline is held for a short while. Come back inside that
// window and nothing on screen moved; stay away and they drop off as usual.
export const PEER_PRESENCE_GRACE_MS = 15000;

export function createPresenceHold({ graceMs = PEER_PRESENCE_GRACE_MS } = {}) {
  const held = new Map(); // peerId -> when they stop counting

  return {
    /** They are back, so there is nothing to hold. */
    online(peerId) {
      if (peerId) held.delete(peerId);
    },

    /** Their connection went. Keep counting them until the grace runs out. */
    offline(peerId, now = Date.now()) {
      if (peerId) held.set(peerId, now + graceMs);
    },

    isHeld(peerId, now = Date.now()) {
      const expiresAt = held.get(peerId);
      return expiresAt !== undefined && expiresAt > now;
    },

    /** Everyone being kept on screen despite having no connection. */
    heldIds(now = Date.now()) {
      const ids = [];
      for (const [peerId, expiresAt] of held) if (expiresAt > now) ids.push(peerId);
      return ids;
    },

    /**
     * When the next held peer stops counting, so a caller can refresh then.
     * Nothing else happens at that moment, so without it the count would sit
     * stale until some unrelated event moved it.
     */
    nextExpiryAt(now = Date.now()) {
      let earliest = null;
      for (const expiresAt of held.values()) {
        if (expiresAt <= now) return now;
        if (earliest === null || expiresAt < earliest) earliest = expiresAt;
      }
      return earliest;
    },

    /** @returns {string[]} the peers that have now really gone. */
    prune(now = Date.now()) {
      const dropped = [];
      for (const [peerId, expiresAt] of held) {
        if (expiresAt > now) continue;
        held.delete(peerId);
        dropped.push(peerId);
      }
      return dropped;
    },

    /** Leaving a room is not a redial, so there is nothing to wait for. */
    forget(peerId) {
      held.delete(peerId);
    },

    clear() {
      held.clear();
    },
  };
}
