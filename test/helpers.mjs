// A production-shaped connection pair: protomux requires a transport that
// preserves write boundaries, which hyperswarm provides via NoiseSecretStream.
import net from "node:net";
import SecretStream from "@hyperswarm/secret-stream";

export async function securePair() {
  // Both handshakes must finish before the streams are used. Until the server
  // side connects, remotePublicKey is unset and peers fall back to a shared id.
  let resolveServer;
  const serverReady = new Promise((r) => { resolveServer = r; });
  const server = net.createServer((sock) => {
    const stream = new SecretStream(false, sock);
    stream.once("connect", () => resolveServer(stream));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));

  const clientSock = net.connect(server.address().port, "127.0.0.1");
  const clientStream = new SecretStream(true, clientSock);
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
