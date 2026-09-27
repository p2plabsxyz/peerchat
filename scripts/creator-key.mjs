/**
 * Prints this device's PeerChat public key.
 *
 * Nothing shows it in either app unless you made the room, and a room's own
 * record of who made it is only the first 8 characters. Pinning a creator key
 * needs the whole thing, so this reads it straight out of the storage the app
 * uses.
 *
 * It is a public key. It is what this device hands every peer it connects to.
 * The secret half is never touched or printed.
 *
 *   node scripts/creator-key.mjs [storage path]
 *
 * Close PeerSky first: the store is locked while the app holds it.
 */
import { homedir } from "node:os";
import path from "node:path";
import Corestore from "corestore";

// Where peersky-browser keeps the Hyper SDK's storage.
const DEFAULT_STORAGE = path.join(
  homedir(),
  "Library/Application Support/peersky-browser/hyper",
);

const storage = process.argv[2] || DEFAULT_STORAGE;
const store = new Corestore(storage);

try {
  await store.ready();
  // The same name hyper-sdk asks corestore for, so this is the key the app
  // itself would report.
  const { publicKey } = await store.createKeyPair("noise");
  console.log(`storage:     ${storage}`);
  console.log(`public key:  ${publicKey.toString("hex")}`);
  console.log(`peer id:     ${publicKey.toString("hex").slice(0, 8)}`);
} catch (error) {
  console.error(`Could not read ${storage}`);
  console.error(error.message);
  console.error("If PeerSky is open, close it and try again.");
  process.exitCode = 1;
} finally {
  await store.close().catch(() => {});
}
