// Opaque per-session ids stand in for room keys anywhere the DOM can see them.
export class RoomRefs {
  constructor(random = () => Math.random().toString(16).slice(2, 10).padEnd(8, "0")) {
    this.random = random;
    this.byKey = new Map();
    this.byRef = new Map();
  }
  ref(roomKey) {
    let id = this.byKey.get(roomKey);
    if (!id) {
      do { id = this.random(); } while (this.byRef.has(id));
      this.byKey.set(roomKey, id);
      this.byRef.set(id, roomKey);
    }
    return id;
  }
  key(ref) { return this.byRef.get(ref) || null; }
}

// Decrypted blob URLs, indexed by room so they can be revoked together on leave.
export class DecryptedUrlCache {
  constructor(revoke = (u) => URL.revokeObjectURL(u)) {
    this.revoke = revoke;
    this.entries = new Map();
    this.byRoom = new Map();
  }
  get(url, roomKey, load) {
    const k = url + "|" + roomKey;
    if (!this.entries.has(k)) {
      const p = Promise.resolve().then(load).catch((err) => {
        this.entries.delete(k);
        this.byRoom.get(roomKey)?.delete(k);
        throw err;
      });
      this.entries.set(k, p);
      if (!this.byRoom.has(roomKey)) this.byRoom.set(roomKey, new Set());
      this.byRoom.get(roomKey).add(k);
    }
    return this.entries.get(k);
  }
  revokeRoom(roomKey) {
    const keys = this.byRoom.get(roomKey);
    if (!keys) return 0;
    for (const k of keys) {
      const p = this.entries.get(k);
      this.entries.delete(k);
      p?.then((u) => this.revoke(u)).catch(() => {});
    }
    this.byRoom.delete(roomKey);
    return keys.size;
  }
  get size() { return this.entries.size; }
}
