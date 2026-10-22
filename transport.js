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

// While the other end of a local network connection is still proving who it
// is, a chat channel it opens first is held, not refused: protomux refuses a
// channel this side has not opened yet, and the two sides finish proving at
// different moments. Returns what lets it go, once this side has opened its
// own channel or decided not to.
export function holdChatTransport(conn) {
  const mux = Protomux.from(conn);
  let release = null;
  const released = new Promise((resolve) => { release = resolve; });
  mux.pair({ protocol: CHAT_PROTOCOL }, () => released);
  return () => {
    mux.unpair({ protocol: CHAT_PROTOCOL });
    release();
  };
}

export { CHAT_PROTOCOL };
