// A production-shaped connection pair: protomux requires a transport that
// preserves write boundaries, which hyperswarm provides via NoiseSecretStream.
import net from "node:net";
import { createHash } from "node:crypto";
import SecretStream from "@hyperswarm/secret-stream";

import { roomProof } from "../lib/room-proof.js";

export async function securePair({ clientKeyPair, serverKeyPair } = {}) {
  // Both handshakes must finish before the streams are used. Until the server
  // side connects, remotePublicKey is unset and peers fall back to a shared id.
  let resolveServer;
  const serverReady = new Promise((r) => { resolveServer = r; });
  const server = net.createServer((sock) => {
    const stream = new SecretStream(false, sock, serverKeyPair ? { keyPair: serverKeyPair } : {});
    stream.once("connect", () => resolveServer(stream));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));

  const clientSock = net.connect(server.address().port, "127.0.0.1");
  const clientStream = new SecretStream(true, clientSock, clientKeyPair ? { keyPair: clientKeyPair } : {});
  await new Promise((r) => clientStream.once("connect", r));
  const serverStream = await serverReady;

  return {
    serverStream,
    clientStream,
    close: async () => {
      clientStream.destroy();
      serverStream?.destroy();
      await new Promise((r) => server.close(r));
    },
  };
}

// How a room is named on the wire: its topic, never its key.
export function wireRoom(roomKey) {
  return createHash("sha256").update("peersky-chat:topic:" + roomKey).digest("hex");
}

// The rooms a peer is in, each with the proof that it holds the key, made for
// the connection it is sent on.
export function topicsFrame(stream, roomKeys) {
  return JSON.stringify({
    type: "topics",
    rooms: roomKeys.map((roomKey) => ({
      topic: wireRoom(roomKey),
      proof: roomProof(roomKey, stream.handshakeHash, stream.publicKey),
    })),
  }) + "\n";
}
