import c from "compact-encoding";
import Protomux from "protomux";

// Version 2 names rooms by topic and opens one to a peer only with a proof it
// holds the key (lib/room-proof.js). Version 1 sent the key itself to anyone
// who turned up under a room's topic, so the two do not talk at all.
const CHAT_PROTOCOL = "peersky-chat/2";

export function attachChatTransport(conn, ondata, options = {}) {
  const mux = Protomux.from(conn);
  const channel = mux.createChannel({
    protocol: CHAT_PROTOCOL,
    onopen() {
      options.onopen?.();
    },
    onclose(isRemote) {
      options.onclose?.(isRemote);
    },
  });
  if (!channel) return null;

  const message = channel.addMessage({
    encoding: c.string,
    onmessage: ondata,
  });

  const transport = {
    get opened() {
      return channel.opened;
    },
    ready() {
      return channel.fullyOpened();
    },
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
