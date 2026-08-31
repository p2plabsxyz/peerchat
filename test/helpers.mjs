// A production-shaped connection pair: protomux requires a transport that
// preserves write boundaries, which hyperswarm provides via NoiseSecretStream.
import net from "node:net";
import SecretStream from "@hyperswarm/secret-stream";

export async function securePair() {
  let serverStream;
  const server = net.createServer((sock) => {
    serverStream = new SecretStream(false, sock);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const clientSock = net.connect(server.address().port, "127.0.0.1");
  const clientStream = new SecretStream(true, clientSock);
  await new Promise((r) => clientStream.once("connect", r));
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
