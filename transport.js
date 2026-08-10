import c from "compact-encoding";
import Protomux from "protomux";

const CHAT_PROTOCOL = "peersky-chat/1";

export function attachChatTransport(conn, ondata) {
  const mux = Protomux.from(conn);
  const channel = mux.createChannel({ protocol: CHAT_PROTOCOL });
  if (!channel) return null;

  const message = channel.addMessage({
    encoding: c.string,
    onmessage: ondata,
  });

  const transport = {
    send(payload) {
      if (channel.closed || conn.destroyed) return false;
      return message.send(String(payload));
    },
    close() {
      if (!channel.closed) channel.close();
    },
  };

  channel.open();
  return transport;
}

export { CHAT_PROTOCOL };
