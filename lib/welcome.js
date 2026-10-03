// The first time a P2P app opens: what it is in a few lines, and one button.
// The same welcome PeerSky shows on phones, drawn over the page until the
// button is pressed, once per app on this computer. It follows the browser's
// theme, and its lines rise in one after another unless motion is reduced.
//
// The same file is in each P2P app that has a welcome; keep them alike.

const STYLE_ID = "peersky-welcome-style";

const STYLE = `
.peersky-welcome {
  position: fixed;
  inset: 0;
  z-index: 2147483000;
  overflow-y: auto;
  display: flex;
  justify-content: center;
  background: var(--browser-theme-background, #18181b);
  color: var(--browser-theme-text-color, #ffffff);
  font-family: var(--browser-theme-font-family, system-ui, sans-serif);
  transition: opacity 0.2s ease;
}
.peersky-welcome.is-leaving { opacity: 0; }
.peersky-welcome__content {
  box-sizing: border-box;
  width: 100%;
  max-width: 560px;
  padding: 56px 24px 40px;
}
.peersky-welcome__icon {
  display: block;
  width: 88px;
  height: 88px;
  margin: 0 auto 18px;
  border-radius: 22px;
}
.peersky-welcome__title {
  margin: 0 0 8px;
  text-align: center;
  font-size: 30px;
  font-weight: 700;
  line-height: 1.2;
}
.peersky-welcome__lead {
  margin: 0 0 32px;
  text-align: center;
  font-size: 16px;
  line-height: 1.5;
  opacity: 0.72;
}
.peersky-welcome__points {
  display: grid;
  gap: 22px;
  margin: 0;
  padding: 0;
  list-style: none;
}
.peersky-welcome__point {
  display: grid;
  grid-template-columns: 44px 1fr;
  gap: 16px;
  align-items: start;
}
.peersky-welcome__badge {
  display: grid;
  place-items: center;
  width: 44px;
  height: 44px;
  border-radius: 12px;
  background: color-mix(in srgb, var(--browser-theme-primary-highlight, #3b82f6) 16%, transparent);
  color: var(--browser-theme-primary-highlight, #3b82f6);
  font-size: 16px;
  font-weight: 700;
}
.peersky-welcome__badge svg { width: 22px; height: 22px; }
.peersky-welcome__point-title {
  margin: 2px 0 4px;
  font-size: 16px;
  font-weight: 700;
}
.peersky-welcome__point-body {
  margin: 0;
  font-size: 14.5px;
  line-height: 1.55;
  opacity: 0.75;
}
.peersky-welcome__point-body:first-child { margin-top: 10px; opacity: 0.9; }
.peersky-welcome__section-title {
  margin: 36px 0 12px;
  font-size: 18px;
  font-weight: 700;
}
.peersky-welcome__question {
  margin-bottom: 8px;
  border-radius: 12px;
  background: color-mix(in srgb, var(--browser-theme-text-color, #ffffff) 6%, transparent);
}
.peersky-welcome__question summary {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  padding: 14px 16px;
  font-weight: 600;
  list-style: none;
  cursor: pointer;
}
.peersky-welcome__question summary::-webkit-details-marker { display: none; }
.peersky-welcome__question summary::after {
  content: "\\203A";
  opacity: 0.55;
  transition: transform 0.15s ease;
}
.peersky-welcome__question[open] summary::after { transform: rotate(90deg); }
.peersky-welcome__question p {
  margin: 0;
  padding: 0 16px 14px;
  line-height: 1.55;
  opacity: 0.8;
}
.peersky-welcome__rules {
  padding: 14px 18px;
  border-radius: 12px;
  background: color-mix(in srgb, var(--browser-theme-text-color, #ffffff) 6%, transparent);
}
.peersky-welcome__rules ul { margin: 0 0 10px; padding-left: 18px; line-height: 1.6; }
.peersky-welcome__note { margin: 0; font-size: 13.5px; line-height: 1.5; opacity: 0.7; }
.peersky-welcome__note a { color: var(--browser-theme-primary-highlight, #3b82f6); }
.peersky-welcome__action {
  display: block;
  width: 100%;
  margin-top: 32px;
  padding: 14px;
  border: 0;
  border-radius: 12px;
  /* Every theme's darker highlight carries white text, in light and dark. */
  background: var(--browser-theme-secondary-highlight, #1d4ed8);
  color: #ffffff;
  font: inherit;
  font-size: 16px;
  font-weight: 700;
  cursor: pointer;
}
.peersky-welcome__action:hover { filter: brightness(1.08); }
.peersky-welcome__action:focus-visible {
  outline: 3px solid color-mix(in srgb, var(--browser-theme-primary-highlight, #3b82f6) 45%, transparent);
  outline-offset: 3px;
}
.peersky-welcome__rise {
  opacity: 0;
  transform: translateY(10px);
  animation: peersky-welcome-rise 0.32s cubic-bezier(0.2, 0.8, 0.2, 1) forwards;
  animation-delay: calc(var(--peersky-welcome-step, 0) * 90ms);
}
@keyframes peersky-welcome-rise {
  to { opacity: 1; transform: none; }
}
@media (prefers-reduced-motion: reduce) {
  .peersky-welcome__rise { animation: none; opacity: 1; transform: none; }
  .peersky-welcome { transition: none; }
}
`;

function storageKey(id) {
  return `peersky:welcome:${id}`;
}

export function hasSeenWelcome(id) {
  try {
    return localStorage.getItem(storageKey(id)) === "seen";
  } catch {
    return false;
  }
}

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function rise(node, step) {
  node.classList.add("peersky-welcome__rise");
  node.style.setProperty("--peersky-welcome-step", String(step));
  return node;
}

/**
 * Shows the welcome unless it has been seen on this computer.
 *
 * @param {object} welcome
 * @param {string} welcome.id Which app, for remembering it was seen.
 * @param {string} welcome.icon The app's tile.
 * @param {string} welcome.title
 * @param {string} [welcome.lead]
 * @param {Array<{ icon?: string, title?: string, body: string }>} welcome.points
 *   With an icon, a titled line; without one, numbered.
 * @param {Array<{ q: string, a: string }>} [welcome.questions]
 * @param {{ items: string[], note: string, link?: { href: string, text: string } }} [welcome.rules]
 * @param {string} welcome.action The button.
 * @param {() => void} [welcome.onDone]
 * @returns {boolean} Whether it showed.
 */
export function showWelcome(welcome) {
  if (hasSeenWelcome(welcome.id)) return false;

  if (!document.getElementById(STYLE_ID)) {
    const style = element("style");
    style.id = STYLE_ID;
    style.textContent = STYLE;
    document.head.appendChild(style);
  }

  const overlay = element("div", "peersky-welcome");
  overlay.setAttribute("role", "dialog");
  overlay.setAttribute("aria-modal", "true");
  overlay.setAttribute("aria-labelledby", "peersky-welcome-title");
  const content = element("div", "peersky-welcome__content");
  overlay.appendChild(content);

  let step = 0;
  const header = rise(element("header"), step++);
  const icon = element("img", "peersky-welcome__icon");
  icon.src = welcome.icon;
  icon.alt = "";
  header.appendChild(icon);
  const title = element("h1", "peersky-welcome__title", welcome.title);
  title.id = "peersky-welcome-title";
  header.appendChild(title);
  if (welcome.lead) header.appendChild(element("p", "peersky-welcome__lead", welcome.lead));
  content.appendChild(header);

  const points = element("ul", "peersky-welcome__points");
  welcome.points.forEach((point, index) => {
    const row = rise(element("li", "peersky-welcome__point"), step++);
    const badge = element("span", "peersky-welcome__badge");
    badge.setAttribute("aria-hidden", "true");
    // The icons are this file's own markup, never anything a page passed in.
    if (point.icon) badge.innerHTML = point.icon;
    else badge.textContent = String(index + 1);
    row.appendChild(badge);
    const words = element("div");
    if (point.title) words.appendChild(element("h2", "peersky-welcome__point-title", point.title));
    words.appendChild(element("p", "peersky-welcome__point-body", point.body));
    row.appendChild(words);
    points.appendChild(row);
  });
  content.appendChild(points);

  // What people ask, folded so the screen stays short. The button comes after
  // them, so whoever goes on has scrolled past every one.
  if (welcome.questions?.length) {
    const section = rise(element("section"), step++);
    section.appendChild(element("h2", "peersky-welcome__section-title", "Questions people ask"));
    for (const { q, a } of welcome.questions) {
      const details = element("details", "peersky-welcome__question");
      details.appendChild(element("summary", "", q));
      details.appendChild(element("p", "", a));
      section.appendChild(details);
    }
    content.appendChild(section);
  }

  // Right above the button, so agreeing means having seen them.
  if (welcome.rules?.items?.length) {
    const section = rise(element("section"), step++);
    section.appendChild(element("h2", "peersky-welcome__section-title", "The rules"));
    const box = element("div", "peersky-welcome__rules");
    const list = element("ul");
    for (const rule of welcome.rules.items) list.appendChild(element("li", "", rule));
    box.appendChild(list);
    const note = element("p", "peersky-welcome__note", welcome.rules.note);
    if (welcome.rules.link) {
      note.append(" ");
      const link = element("a", "", welcome.rules.link.text);
      link.href = welcome.rules.link.href;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      note.append(link, ".");
    }
    box.appendChild(note);
    section.appendChild(box);
    content.appendChild(section);
  }

  const action = rise(element("button", "peersky-welcome__action", welcome.action), step++);
  action.type = "button";
  action.addEventListener("click", () => {
    try {
      localStorage.setItem(storageKey(welcome.id), "seen");
    } catch {}
    overlay.classList.add("is-leaving");
    setTimeout(() => overlay.remove(), 200);
    welcome.onDone?.();
  });
  content.appendChild(action);

  document.body.appendChild(overlay);
  action.focus({ preventScroll: true });
  return true;
}
