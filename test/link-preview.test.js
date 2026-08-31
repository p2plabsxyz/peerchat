import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  decodeMessagePayload,
  encodeMessagePayload,
  extractFirstHttpUrl,
  resolveLinkPreview,
  sanitizePreview,
  validateHttpUrl,
} from "../lib/link-preview.js";

const HTML = `<!doctype html><html><head>
  <title>Example Domain</title>
  <meta name="description" content="Example description here." />
  <meta property="og:title" content="Og Title" />
</head><body>hi</body></html>`;

const HTML_NO_META = "<html><head><title>Solo Title</title></head><body></body></html>";

function stubFetch(handler) {
  return async (url, options = {}) => handler(url, options);
}

function htmlResponse(body, { status = 200, contentType = "text/html" } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    url: "https://example.com/",
    headers: {
      get(name) {
        return name.toLowerCase() === "content-type" ? contentType : null;
      },
    },
    body: new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(body));
        controller.close();
      },
    }),
  };
}

describe("extractFirstHttpUrl", () => {
  it("returns the first http(s) URL in a message", () => {
    assert.equal(
      extractFirstHttpUrl("see https://example.com/a?b=1 for details"),
      "https://example.com/a?b=1"
    );
  });

  it("strips trailing punctuation from the URL", () => {
    assert.equal(extractFirstHttpUrl("visit (https://example.com/page)."), "https://example.com/page");
  });

  it("returns null when there is no URL", () => {
    assert.equal(extractFirstHttpUrl("no links here"), null);
    assert.equal(extractFirstHttpUrl(""), null);
    assert.equal(extractFirstHttpUrl(null), null);
  });
});

describe("validateHttpUrl", () => {
  it("accepts http and https", () => {
    assert.ok(validateHttpUrl("https://example.com/"));
    assert.ok(validateHttpUrl("http://example.com"));
  });

  it("rejects non-http schemes", () => {
    assert.equal(validateHttpUrl("ftp://example.com"), "");
    assert.equal(validateHttpUrl("javascript:alert(1)"), "");
    assert.equal(validateHttpUrl("file:///etc/passwd"), "");
  });

  it("rejects localhost, private and link-local targets", () => {
    assert.equal(validateHttpUrl("http://localhost:8000/"), "");
    assert.equal(validateHttpUrl("https://127.0.0.1/"), "");
    assert.equal(validateHttpUrl("http://10.0.0.5/"), "");
    assert.equal(validateHttpUrl("http://192.168.1.1/"), "");
    assert.equal(validateHttpUrl("http://169.254.169.254/latest/meta-data"), "");
    assert.equal(validateHttpUrl("http://172.16.0.1/"), "");
    assert.equal(validateHttpUrl("http://[::1]/"), "");
    assert.equal(validateHttpUrl("http://[::ffff:127.0.0.1]/"), "");
    assert.equal(validateHttpUrl("http://[fe80::1]/"), "");
    assert.equal(validateHttpUrl("http://[fd12:3456:789a::1]/"), "");
    assert.equal(validateHttpUrl("http://fc00:1234::1/"), "");
  });

  it("allows public IPv6 literals", () => {
    assert.ok(validateHttpUrl("http://[2606:4700:4700::1111]/"));
    assert.ok(validateHttpUrl("http://[2001:db8::1]/"));
  });

  it("rejects URLs with embedded credentials", () => {
    assert.equal(validateHttpUrl("https://user:pass@example.com/"), "");
  });
});

describe("sanitizePreview", () => {
  it("keeps valid fields and clamps lengths", () => {
    const out = sanitizePreview({
      url: "https://example.com/",
      host: "EXAMPLE.COM",
      title: "t".repeat(500),
      description: "d".repeat(500),
    });
    assert.equal(out.url, "https://example.com/");
    assert.equal(out.host, "example.com");
    assert.equal(out.title.length, 120);
    assert.equal(out.description.length, 300);
  });

  it("drops a preview without a valid url", () => {
    assert.equal(sanitizePreview({ title: "no link" }), null);
    assert.equal(sanitizePreview({ url: "ftp://x/" }), null);
    assert.equal(sanitizePreview(null), null);
  });

  it("falls back to the URL host when host is missing", () => {
    const out = sanitizePreview({ url: "https://sub.example.org/path" });
    assert.equal(out.host, "sub.example.org");
  });
});

describe("encodeMessagePayload / decodeMessagePayload", () => {
  it("encrypts plain text byte-identically when there is no preview", () => {
    const payload = encodeMessagePayload("hello", null);
    assert.equal(payload, "hello");
  });

  it("emits a JSON envelope only when a preview is present", () => {
    const preview = { url: "https://example.com/", host: "example.com", title: "T", description: "D" };
    const payload = encodeMessagePayload("see the link", preview);
    assert.ok(payload.startsWith("{"));

    const { text, preview: back } = decodeMessagePayload(payload);
    assert.equal(text, "see the link");
    assert.deepEqual(back, preview);
  });

  it("treats legacy plaintext as a message without a preview", () => {
    const { text, preview } = decodeMessagePayload("legacy text");
    assert.equal(text, "legacy text");
    assert.equal(preview, null);
  });

  it("treats non-envelope JSON as plain message text", () => {
    const { text, preview } = decodeMessagePayload('{"hello":"world"}');
    assert.equal(text, '{"hello":"world"}');
    assert.equal(preview, null);
  });
});

describe("resolveLinkPreview", () => {
  it("extracts title and description from HTML", async () => {
    const preview = await resolveLinkPreview("https://example.com/", {
      fetchFn: stubFetch(() => htmlResponse(HTML)),
    });
    assert.equal(preview.url, "https://example.com/");
    assert.equal(preview.host, "example.com");
    assert.equal(preview.title, "Og Title");
    assert.equal(preview.description, "Example description here.");
  });

  it("falls back to the <title> tag when there is no og:title", async () => {
    const preview = await resolveLinkPreview("https://example.com/", {
      fetchFn: stubFetch(() => htmlResponse(HTML_NO_META)),
    });
    assert.equal(preview.title, "Solo Title");
  });

  it("returns null on non-HTML content types", async () => {
    const preview = await resolveLinkPreview("https://example.com/f", {
      fetchFn: stubFetch(() => htmlResponse("PNG data", { contentType: "image/png" })),
    });
    assert.equal(preview, null);
  });

  it("returns null on non-2xx responses", async () => {
    const preview = await resolveLinkPreview("https://example.com/404", {
      fetchFn: stubFetch(() => htmlResponse("nope", { status: 404 })),
    });
    assert.equal(preview, null);
  });

  it("returns null on an invalid or private target without fetching", async () => {
    let called = false;
    const preview = await resolveLinkPreview("http://127.0.0.1/", {
      fetchFn: stubFetch(() => {
        called = true;
        return htmlResponse(HTML);
      }),
    });
    assert.equal(preview, null);
    assert.equal(called, false, "must not fetch a blocked target");
  });

  it("returns null when the fetch fails", async () => {
    const preview = await resolveLinkPreview("https://example.com/", {
      fetchFn: stubFetch(() => {
        throw new Error("network down");
      }),
    });
    assert.equal(preview, null);
  });

  it("follows a redirect only while each hop stays public", async () => {
    const hops = [];
    const preview = await resolveLinkPreview("https://a.com/", {
      fetchFn: stubFetch((url) => {
        hops.push(url);
        if (url === "https://a.com/") return { ...htmlResponse(""), status: 302, headers: { get: () => "https://b.com/gone" } };
        return htmlResponse(HTML);
      }),
    });
    assert.deepEqual(hops, ["https://a.com/", "https://b.com/gone"]);
    assert.equal(preview.host, "b.com");
  });

  it("drops a redirect that lands on a private address", async () => {
    const preview = await resolveLinkPreview("https://a.com/", {
      fetchFn: stubFetch((url) => {
        if (url === "https://a.com/") return { ...htmlResponse(""), status: 302, headers: { get: () => "http://127.0.0.1/x" } };
        return htmlResponse(HTML);
      }),
    });
    assert.equal(preview, null);
  });

  it("refuses to fetch a hostname that resolves to a private address", async () => {
    let called = false;
    const preview = await resolveLinkPreview("https://attacker.com/", {
      fetchFn: stubFetch(() => {
        called = true;
        return htmlResponse(HTML);
      }),
      lookupFn: async () => ["169.254.169.254"],
    });
    assert.equal(preview, null);
    assert.equal(called, false, "must not fetch a hostname resolving to a private address");
  });

  it("drops a redirect whose hostname resolves to a private address", async () => {
    const hops = [];
    const preview = await resolveLinkPreview("https://a.com/", {
      fetchFn: stubFetch((url) => {
        hops.push(url);
        if (url === "https://a.com/") return { ...htmlResponse(""), status: 302, headers: { get: () => "https://b.com/x" } };
        return htmlResponse(HTML);
      }),
      lookupFn: async (host) => (host === "b.com" ? ["10.0.0.1"] : ["93.184.216.34"]),
    });
    assert.equal(preview, null);
    assert.deepEqual(hops, ["https://a.com/"]);
  });

  it("fetches a hostname that resolves to a public address", async () => {
    const preview = await resolveLinkPreview("https://example.com/", {
      fetchFn: stubFetch(() => htmlResponse(HTML)),
      lookupFn: async () => ["93.184.216.34"],
    });
    assert.equal(preview.host, "example.com");
  });
});
describe("preview resolution respects its time budget", () => {
  // dns.lookup cannot be aborted, so before the fix a hanging resolver held
  // the send path far past timeoutMs (measured 8s against a 3s budget). The
  // offline-LAN case hits this constantly: the router accepts DNS queries and
  // forwards them to a dead upstream.
  it("gives up on a hanging DNS lookup within the budget", async () => {
    const hangingLookup = () => new Promise((resolve) => {
      const t = setTimeout(() => resolve(["93.184.216.34"]), 8000);
      t.unref?.();
    });
    const instantFetch = async () => ({
      ok: true,
      status: 200,
      headers: { get: (h) => (h === "content-type" ? "text/html" : "") },
      arrayBuffer: async () => new TextEncoder().encode("<title>x</title>").buffer,
      body: null,
    });

    const started = Date.now();
    const result = await resolveLinkPreview("https://example.com/", {
      fetchFn: instantFetch,
      lookupFn: hangingLookup,
      timeoutMs: 1000,
    });
    const elapsed = Date.now() - started;

    assert.equal(result, null, "a missed budget must mean no preview, not a late one");
    assert.ok(elapsed < 2500, `took ${elapsed}ms against a 1000ms budget`);
  });
});
