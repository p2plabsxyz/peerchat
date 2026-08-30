export const MAX_PREVIEW_BYTES = 256 * 1024;
export const PREVIEW_TIMEOUT_MS = 3000;

const MAX_REDIRECTS = 3;
const MAX_TITLE_LEN = 120;
const MAX_DESC_LEN = 300;
const MAX_HOST_LEN = 128;
const MAX_URL_LEN = 2048;
const PREVIEW_UA = "PeerChat-link-preview/1.0";

const HTTP_URL_RE = /https?:\/\/[^\s<>"'`]+/gi;
const META_TAG_RE = /<meta[^>]*>/gi;

const HOST_RE = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i;

export function extractFirstHttpUrl(text) {
  if (typeof text !== "string" || !text) return null;
  HTTP_URL_RE.lastIndex = 0;
  const match = HTTP_URL_RE.exec(text);
  if (!match) return null;
  const trimmed = match[0].replace(/[)\]},.;:"'!?]+$/g, "");
  return trimmed || null;
}

function isPrivateHost(hostname) {
  const h = String(hostname || "").toLowerCase().replace(/^\[|\]$/g, "");
  if (!h) return true;
  if (h === "localhost" || h.endsWith(".localhost")) return true;
  if (h.endsWith(".local") || h.endsWith(".internal")) return true;
  if (h === "::1" || h === "::" || h === "0:0:0:0:0:0:0:1") return true;

  const ipv4 = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4) {
    const a = Number(ipv4[1]);
    const b = Number(ipv4[2]);
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 169 && b === 254) return true;
    if (a === 192 && b === 168) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a >= 224) return true;
    return false;
  }

  const mapped = h.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
  if (mapped) return isPrivateHost(mapped[1]);
  if (/^fe[89ab][0-9a-f]:/i.test(h)) return true;
  if (/^f[cd]:/i.test(h)) return true;
  return false;
}

function validateHost(host) {
  if (typeof host !== "string" || !host || host.length > MAX_HOST_LEN) return false;
  if (!HOST_RE.test(host)) return false;
  return !isPrivateHost(host);
}

export function validateHttpUrl(input) {
  if (typeof input !== "string" || !input || input.length > MAX_URL_LEN) return "";
  let u;
  try {
    u = new URL(input);
  } catch {
    return "";
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return "";
  if (u.username || u.password) return "";
  if (isPrivateHost(u.hostname)) return "";
  return u.href;
}

function hostOf(url) {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return "";
  }
}

export function sanitizePreview(input) {
  if (!input || typeof input !== "object") return null;
  const url = validateHttpUrl(input.url);
  if (!url) return null;
  const out = { url };
  const host = typeof input.host === "string" && validateHost(input.host)
    ? input.host.toLowerCase()
    : hostOf(url);
  if (host) out.host = host.slice(0, MAX_HOST_LEN);
  const title = typeof input.title === "string" ? input.title.trim().slice(0, MAX_TITLE_LEN) : "";
  if (title) out.title = title;
  const description = typeof input.description === "string" ? input.description.trim().slice(0, MAX_DESC_LEN) : "";
  if (description) out.description = description;
  return out;
}

export function encodeMessagePayload(message, preview) {
  const clean = sanitizePreview(preview);
  if (!clean) return typeof message === "string" ? message : "";
  return JSON.stringify({ v: 2, text: String(message), preview: clean });
}

export function decodeMessagePayload(raw) {
  if (typeof raw !== "string" || raw === "") return { text: "", preview: null };
  if (raw.charCodeAt(0) !== 0x7b) return { text: raw, preview: null };
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && parsed.v === 2 && typeof parsed.text === "string") {
      const preview = sanitizePreview(parsed.preview);
      return { text: parsed.text, preview };
    }
  } catch {
  }
  return { text: raw, preview: null };
}

function resolveRelativeLocation(base, location) {
  if (typeof location !== "string" || !location) return null;
  let resolved;
  try {
    resolved = new URL(location, base);
  } catch {
    return null;
  }
  return validateHttpUrl(resolved.href);
}

async function readBodyCapped(res, maxBytes) {
  if (!res.body || typeof res.body.getReader !== "function") {
    const text = typeof res.text === "function" ? await res.text() : "";
    return text.slice(0, maxBytes);
  }
  try {
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let out = "";
    try {
      while (out.length < maxBytes) {
        const { value, done } = await reader.read();
        if (done) break;
        out += decoder.decode(value, { stream: true });
      }
    } finally {
      try { await reader.cancel(); } catch {}
    }
    return out;
  } catch {
    const text = typeof res.text === "function" ? await res.text() : "";
    return text.slice(0, maxBytes);
  }
}

async function fetchHtmlWithFetch(fetchFn, href, timeoutMs, maxBytes) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    let current = href;
    for (let hops = 0; hops <= MAX_REDIRECTS; hops++) {
      const res = await fetchFn(current, {
        redirect: "manual",
        signal: controller.signal,
        headers: { "user-agent": PREVIEW_UA, accept: "text/html" },
      });
      if (!res) return null;
      if (res.status >= 300 && res.status < 400) {
        if (hops >= MAX_REDIRECTS) return null;
        const location = (res.headers && res.headers.get ? res.headers.get("location") : "") || "";
        const next = resolveRelativeLocation(current, location);
        if (!next) return null;
        current = next;
        continue;
      }
      if (!res.ok) return null;
      const contentType = (res.headers && res.headers.get ? res.headers.get("content-type") : "") || "";
      if (contentType && !/text\/html|application\/xhtml\+xml/i.test(contentType)) return null;
      const body = await readBodyCapped(res, maxBytes);
      if (!body) return null;
      return { body, url: current };
    }
    return null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchHtmlWithNode(href, timeoutMs, maxBytes) {
  const getBuiltinModule = globalThis.process?.getBuiltinModule;
  if (typeof getBuiltinModule !== "function") return null;
  let scheme;
  try {
    scheme = new URL(href).protocol;
  } catch {
    return null;
  }
  const mod = getBuiltinModule(scheme === "https:" ? "https" : "http");
  if (!mod) return null;

  let current = href;
  for (let hops = 0; hops <= MAX_REDIRECTS; hops++) {
    const result = await new Promise((resolve) => {
      const req = mod.get(current, { headers: { "user-agent": PREVIEW_UA, accept: "text/html" } }, (res) => {
        const status = res.statusCode || 0;
        if (status >= 300 && status < 400 && res.headers.location) {
          res.resume();
          resolve({ redirect: res.headers.location });
          return;
        }
        if (status < 200 || status >= 300) {
          res.resume();
          resolve(null);
          return;
        }
        const contentType = String(res.headers["content-type"] || "");
        if (contentType && !/text\/html|application\/xhtml\+xml/i.test(contentType)) {
          res.resume();
          resolve(null);
          return;
        }
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          if (body.length < maxBytes) body += chunk;
        });
        res.on("end", () => resolve({ body, url: current }));
        res.on("error", () => resolve(null));
      });
      req.on("error", () => resolve(null));
      req.setTimeout(timeoutMs, () => {
        req.destroy();
        resolve(null);
      });
    });
    if (result === null) return null;
    if (result.url) return result;
    if (hops >= MAX_REDIRECTS) return null;
    const next = resolveRelativeLocation(current, result.redirect);
    if (!next) return null;
    current = next;
  }
  return null;
}

export async function resolveLinkPreview(url, options = {}) {
  const canonical = typeof url === "string" ? validateHttpUrl(url) : "";
  if (!canonical) return null;

  const fetchFn = typeof options.fetchFn === "function" ? options.fetchFn : globalThis.fetch;
  const timeoutMs = options.timeoutMs || PREVIEW_TIMEOUT_MS;
  const maxBytes = options.maxBytes || MAX_PREVIEW_BYTES;

  const htmlResult = typeof fetchFn === "function"
    ? await fetchHtmlWithFetch(fetchFn, canonical, timeoutMs, maxBytes)
    : await fetchHtmlWithNode(canonical, timeoutMs, maxBytes);
  if (!htmlResult?.body) return null;
  const finalUrl = htmlResult.url || canonical;

  const { title, description } = parseLinkMetadata(htmlResult.body);
  return sanitizePreview({
    url: finalUrl,
    host: hostOf(finalUrl),
    title,
    description,
  });
}

function extractMetaContent(html, name) {
  let m;
  META_TAG_RE.lastIndex = 0;
  while ((m = META_TAG_RE.exec(html)) !== null) {
    const tag = m[0];
    const key = (tag.match(/\b(?:name|property)\s*=\s*("|')([^"']*)\1/i) || [])[2];
    const content = (tag.match(/\bcontent\s*=\s*("|')([^"']*)\1/i) || [])[2];
    if (key && content && key.toLowerCase() === name) {
      return cleanHtmlText(content);
    }
  }
  return "";
}

function decodeHtmlEntities(s) {
  return s
    .replace(/&nbsp;/gi, " ")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/gi, '"')
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&amp;/gi, "&")
    .replace(/&#(\d+);/g, (_, d) => {
      try { return String.fromCodePoint(Number(d)); } catch { return ""; }
    })
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => {
      try { return String.fromCodePoint(parseInt(h, 16)); } catch { return ""; }
    });
}

function cleanHtmlText(s) {
  return decodeHtmlEntities(s.replace(/<[^>]*>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
}

function extractTitle(html) {
  const og = extractMetaContent(html, "og:title");
  if (og) return og;
  const m = html.match(/<title(?:\s[^>]*)?>([\s\S]*?)<\/title>/i);
  if (!m) return "";
  return cleanHtmlText(m[1]);
}

function parseLinkMetadata(html) {
  if (typeof html !== "string" || !html) return { title: "", description: "" };
  const title = extractTitle(html);
  const description = extractMetaContent(html, "description") || extractMetaContent(html, "og:description");
  return { title, description };
}