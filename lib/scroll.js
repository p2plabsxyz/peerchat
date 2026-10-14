// Pins a container to its bottom while late content (images, decrypted media)
// is still changing the height. The moment the user scrolls up, it stops.
const watches = new WeakMap();

export function stickToBottom(container, opts = {}) {
  const { smooth = false, budgetMs = 1500, raf = (cb) => globalThis.requestAnimationFrame(cb), now = () => performance.now() } = opts;
  if (!container) return;

  const watch = (watches.get(container) || 0) + 1;
  watches.set(container, watch);

  const jump = () => { container.scrollTop = container.scrollHeight; };
  if (smooth) container.scrollTo({ top: container.scrollHeight, behavior: "smooth" });
  else jump();

  const deadline = now() + budgetMs;
  let lastHeight = container.scrollHeight;
  let lastTop = container.scrollTop;

  const step = () => {
    if (!container.isConnected || watches.get(container) !== watch) return;

    const height = container.scrollHeight;
    // Nothing here moves scrollTop up; a shrink clamps it, anything else is the user.
    if (height >= lastHeight && container.scrollTop < lastTop - 1) return;

    if (height !== lastHeight) {
      lastHeight = height;
      if (smooth) container.scrollTo({ top: height, behavior: "smooth" });
      else jump();
    }
    lastTop = container.scrollTop;

    if (now() > deadline) { jump(); return; }
    raf(step);
  };
  raf(step);
}

// Puts a message in the middle of the pane and keeps it there while pictures
// above it load and push it down, as stickToBottom keeps the bottom. It stops
// the moment the user scrolls, and a later stickToBottom takes over from it.
export function holdInView(container, el, opts = {}) {
  const { budgetMs = 1500, raf = (cb) => globalThis.requestAnimationFrame(cb), now = () => performance.now() } = opts;
  if (!container || !el) return;

  const watch = (watches.get(container) || 0) + 1;
  watches.set(container, watch);

  const place = () => {
    container.scrollTop = Math.max(0, el.offsetTop - (container.clientHeight - el.offsetHeight) / 2);
  };
  place();

  const deadline = now() + budgetMs;
  let lastHeight = container.scrollHeight;
  let lastTop = container.scrollTop;

  const step = () => {
    if (!container.isConnected || !el.isConnected || watches.get(container) !== watch) return;
    const height = container.scrollHeight;
    // Moved with nothing loading: that was the user.
    if (height === lastHeight && Math.abs(container.scrollTop - lastTop) > 1) return;
    if (height !== lastHeight) {
      lastHeight = height;
      place();
    }
    lastTop = container.scrollTop;
    if (now() > deadline) return;
    raf(step);
  };
  raf(step);
}

/**
 * Whether a re-rendered pane should jump to the "New Messages" divider or just
 * show the newest message.
 *
 * Going to the divider earns its keep when the unread run starts above the
 * final screen. When the whole run already fits there, scrolling to it drags
 * the reader a few messages up from the message they came to see.
 */
export function shouldScrollToUnread({ dividerTop, scrollHeight, clientHeight }) {
  if (!Number.isFinite(dividerTop) || dividerTop < 0) return false;
  const bottom = Math.max(0, (scrollHeight || 0) - (clientHeight || 0));
  return dividerTop < bottom;
}
