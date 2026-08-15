import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { attachChatTransport, CHAT_PROTOCOL } from "../transport.js";

describe("PeerChat transport", () => {
  it("uses a dedicated Protomux string channel", () => {
    let channelOptions;
    let messageOptions;
    let opened = false;
    let ready = false;
    let closedByRemote = null;
    const sent = [];

    const channel = {
      closed: false,
      addMessage(options) {
        messageOptions = options;
        return { send: (payload) => { sent.push(payload); return true; } };
      },
      open() { opened = true; },
      close() { this.closed = true; },
      fullyOpened() { return Promise.resolve(this.opened); },
    };
    const mux = {
      isProtomux: true,
      createChannel(options) {
        channelOptions = options;
        return channel;
      },
    };
    const conn = { destroyed: false, userData: mux };
    const received = [];

    const transport = attachChatTransport(conn, (payload) => received.push(payload), {
      onopen: () => { ready = true; },
      onclose: (isRemote) => { closedByRemote = isRemote; },
    });
    assert.equal(channelOptions.protocol, CHAT_PROTOCOL);
    assert.equal(opened, true);
    assert.equal(ready, false);
    assert.equal(transport.send("hello\n"), true);
    assert.deepEqual(sent, ["hello\n"]);

    channel.opened = true;
    channelOptions.onopen();
    assert.equal(ready, true);
    assert.equal(transport.opened, true);

    messageOptions.onmessage("world\n");
    assert.deepEqual(received, ["world\n"]);

    channelOptions.onclose(true);
    assert.equal(closedByRemote, true);
  });
});
