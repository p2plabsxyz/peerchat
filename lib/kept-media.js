// Pictures and videos already on screen, put back into a pane that was rebuilt.
//
// Rebuilding the pane made every attachment again from nothing: an empty
// element that fetched, decrypted, was screened and loaded before it had a
// size. Each one collapsed its bubble and opened it back up, and the scroll
// moved with it, which was the flicker under a picture whenever the pane was
// rebuilt. Moving the loaded element over keeps the picture, its size, and a
// video where it was.

/**
 * The loaded media in a pane, by the file each one shows.
 * @param {Iterable<Element>} elements the pane's .msg-file-img elements
 */
export function collectLoadedMedia(elements) {
  const loaded = new Map();
  for (const el of elements) {
    const key = el.dataset?.mediaKey;
    if (key && el.getAttribute("src") && !loaded.has(key)) loaded.set(key, el);
  }
  return loaded;
}

/**
 * Puts each one back in place of what the rebuilt pane made for the same file:
 * an empty encrypted element, one off a drive not screened yet, or the card of
 * a large file that had already been opened.
 * @param {Iterable<Element>} placeholders the new pane's .msg-file-img elements and large media cards
 */
export function restoreLoadedMedia(placeholders, loaded) {
  for (const el of placeholders) {
    if (!loaded.size) return;
    const key = mediaKeyOf(el);
    const kept = key ? loaded.get(key) : null;
    if (!kept) continue;
    loaded.delete(key);
    el.replaceWith(kept);
  }
}

function mediaKeyOf(el) {
  return el.getAttribute("data-enc-src") ||
    el.getAttribute("data-file-url") ||
    (el.dataset?.screened ? "" : el.getAttribute("src")) ||
    "";
}
