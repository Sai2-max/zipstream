/* ============================================================
   ZipStream Service Worker — makes a single ZIP entry playable
   as a seekable "virtual file" URL.

   The page hands <video> a same-origin URL of the form:
     /__zip__/<base64url(sourceZipUrl)>/<encodeURIComponent(name)>
                  ?o=<dataOffset>&m=<method>&c=<compSize>&u=<uncompSize>

   The browser's media element issues HTTP Range requests against
   that URL. This worker translates each range into the matching
   byte span inside the remote ZIP and streams only those bytes back:

     * Stored (method 0)  → direct byte mapping. True random access:
                            instant start, seek anywhere, never
                            download bytes you don't watch.
     * Deflated (method 8) → stream-inflated once into an in-memory
                            buffer; playback is progressive and seeking
                            works for anything already inflated (a deflate
                            stream has no random access, so the prefix up
                            to a seek point must be inflated first).

   All remote fetches go through the same CORS fallback chain as the
   page (direct → public CORS proxies) because the ZIP usually lives
   on a cross-origin host.
   ============================================================ */
"use strict";

/* ---------------- constants ---------------- */
const CHUNK = 4 * 1024 * 1024; // 4 MB streaming chunks
const MARK = "/__zip__/";     // matched anywhere in the path (app may live in a subdirectory)

/* ---------------- CORS fallback chain ---------------- */
const PROXY_BUILDERS = {
  "corsproxy.io": (u) => "https://corsproxy.io/?url=" + encodeURIComponent(u),
  "allorigins": (u) => "https://api.allorigins.win/raw?url=" + encodeURIComponent(u),
  "cors.workers.dev": (u) => "https://test.cors.workers.dev/?u=" + encodeURIComponent(u),
  "isomorphic-git": (u) => "https://cors.isomorphic-git.org/" + u,
};
const CANDIDATES = [null, "corsproxy.io", "allorigins", "cors.workers.dev", "isomorphic-git"];

/** Public CORS proxies can never reach a backend on this machine. */
function isLocalUrl(u) {
  try {
    const h = new URL(u).hostname;
    return h === "localhost" || h === "127.0.0.1" || h === "::1" || h === "[::1]";
  } catch { return false; }
}

function targetFor(key, url) { return key ? PROXY_BUILDERS[key](url) : url; }

/* ---------------- remote fetch helpers ---------------- */

/** Find a connection (direct or proxy) that answers HTTP Range requests. */
async function probe(url) {
  const candidates = isLocalUrl(url) ? [null] : CANDIDATES;
  for (const key of candidates) {
    const target = targetFor(key, url);
    try {
      const r = await fetch(target, { headers: { Range: "bytes=0-1" } });
      if (r.status !== 206) continue;
      const buf = new Uint8Array(await r.arrayBuffer());
      if (buf.byteLength >= 1) return key;
    } catch (e) { /* next candidate */ }
  }
  return null;
}

/** Fetch a byte range as a Uint8Array, retrying across the fallback chain. */
async function getBytes(conn, start, length) {
  if (length <= 0) return new Uint8Array(0);
  const pool = isLocalUrl(conn.url) ? [null] : CANDIDATES;
  const order = conn.key !== null
    ? [conn.key, ...pool.filter((k) => k !== conn.key)]
    : pool;
  let lastErr = null;
  for (const key of order) {
    const target = targetFor(key, conn.url);
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const r = await fetch(target, {
          headers: { Range: `bytes=${start}-${start + length - 1}` },
        });
        if (r.status === 416) throw new Error("range past end of file");
        if (r.status !== 206) throw new Error("HTTP " + r.status + " (expected 206 Partial Content)");
        const buf = new Uint8Array(await r.arrayBuffer());
        if (buf.byteLength === 0) throw new Error("empty response");
        return buf;
      } catch (e) { lastErr = e; }
    }
  }
  throw new Error("Range fetch failed: " + (lastErr && lastErr.message));
}

/* ---------------- virtual-URL codec ---------------- */
function b64urlEncode(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function b64urlDecode(str) {
  let s = str.replace(/-/g, "+").replace(/_/g, "/");
  while (s.length % 4) s += "=";
  const bin = atob(s);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

function extType(name) {
  const ext = name.split(".").pop().toLowerCase();
  const map = {
    mp4: "video/mp4", m4v: "video/mp4", mov: "video/mp4",
    webm: "video/webm", mkv: "video/x-matroska",
    mp3: "audio/mpeg", m4a: "audio/mp4", opus: "audio/ogg", ogg: "audio/ogg",
    jpg: "image/jpeg", png: "image/png",
  };
  return map[ext] || null;
}

/* ---------------- connection cache (per source ZIP) ---------------- */
const connCache = new Map(); // srcUrl -> Promise<{ key, url }>
function getConn(srcUrl) {
  if (!connCache.has(srcUrl)) {
    connCache.set(srcUrl, (async () => {
      const key = await probe(srcUrl);
      if (key === null) throw new Error("no Range-capable connection for " + srcUrl);
      return { key, url: srcUrl };
    })());
  }
  return connCache.get(srcUrl);
}

/* ---------------- deflate: streaming inflate buffer ---------------- */
class InflateJob {
  constructor(conn, dataOff, compSize, uncompSize) {
    this.conn = conn;
    this.dataOff = dataOff;
    this.compSize = compSize;
    this.uncompSize = uncompSize;
    this.chunks = [];      // uncompressed Uint8Array pieces, in order
    this.length = 0;       // total uncompressed bytes produced so far
    this.done = false;
    this.error = null;
    this.waiters = [];
    this.started = false;
  }
  start() {
    if (this.started) return;
    this.started = true;
    this._run();
  }
  async _run() {
    try {
      const ds = new DecompressionStream("deflate-raw");
      const writer = ds.writable.getWriter();
      const reader = ds.readable.getReader();
      const readPump = (async () => {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          this.chunks.push(value);
          this.length += value.byteLength;
          this._notify();
        }
      })();
      let pos = 0;
      while (pos < this.compSize) {
        const n = Math.min(CHUNK, this.compSize - pos);
        const c = await getBytes(this.conn, this.dataOff + pos, n);
        await writer.write(c);
        pos += c.byteLength;
      }
      await writer.close();
      await readPump;
      this.done = true;
      this._notify();
    } catch (e) {
      this.error = e;
      this.done = true;
      this._notify();
    }
  }
  _notify() {
    for (const w of this.waiters.splice(0)) w();
  }
  async waitUntil(n) {
    while (this.length < n && !this.done && !this.error) {
      await new Promise((r) => this.waiters.push(r));
    }
    if (this.error) throw this.error;
    if (this.done && this.length < n) throw new Error("inflate ended early (corrupt ZIP entry?)");
  }
  /** Return uncompressed bytes [start, end), blocking until they are available. */
  async region(start, end) {
    await this.waitUntil(start + 1);
    end = Math.min(end, this.length);
    const len = Math.max(0, end - start);
    if (len === 0) return new Uint8Array(0);
    const out = new Uint8Array(len);
    let base = 0, outOff = 0;
    for (const c of this.chunks) {
      const cEnd = base + c.byteLength;
      if (cEnd > start && outOff < len) {
        const from = Math.max(start, base);
        const to = Math.min(start + len, cEnd);
        out.set(c.subarray(from - base, to - base), outOff);
        outOff += to - from;
      }
      base = cEnd;
      if (outOff >= len) break;
    }
    return out;
  }
}
const inflateJobs = new Map(); // "<srcUrl>#<name>" -> InflateJob

/* ---------------- Range parsing ---------------- */
function parseRange(header, total) {
  if (!header) return null; // no range → full 200 response
  const m = header.match(/bytes=(\d*)-(\d*)/);
  if (!m) return null;
  let start, end;
  if (m[1] === "" && m[2] === "") return null;
  if (m[1] === "") {           // suffix range: last N bytes
    const n = parseInt(m[2], 10);
    start = Math.max(0, total - n);
    end = total - 1;
  } else {
    start = parseInt(m[1], 10);
    end = m[2] === "" ? total - 1 : Math.min(parseInt(m[2], 10), total - 1);
  }
  if (start > end || start >= total) return { unsatisfiable: true };
  return { start, end };
}

function rangeHeaders(start, length, total, type) {
  return {
    "Content-Type": type,
    "Content-Length": String(length),
    "Content-Range": `bytes ${start}-${start + length - 1}/${total}`,
    "Accept-Ranges": "bytes",
    "Cache-Control": "no-store",
  };
}
function fullHeaders(length, type) {
  return {
    "Content-Type": type,
    "Content-Length": String(length),
    "Accept-Ranges": "bytes",
    "Cache-Control": "no-store",
  };
}

/* ---------------- response bodies (streaming) ---------------- */

/** Stored entry: map uncompressed offset → ZIP byte offset and stream. */
function storedResponse(conn, dataOff, start, length, total, type, hasRange) {
  const headers = hasRange ? rangeHeaders(start, length, total, type) : fullHeaders(length, type);
  let sent = 0;
  const body = new ReadableStream({
    async pull(controller) {
      if (sent >= length) { controller.close(); return; }
      const n = Math.min(CHUNK, length - sent);
      const chunk = await getBytes(conn, dataOff + start + sent, n);
      controller.enqueue(chunk);
      sent += chunk.byteLength;
    },
  });
  return new Response(body, { status: hasRange ? 206 : 200, headers });
}

/** Deflated entry: read progressively from the inflate buffer. */
function inflateResponse(job, start, length, total, type, hasRange) {
  const headers = hasRange ? rangeHeaders(start, length, total, type) : fullHeaders(length, type);
  let sent = 0;
  const body = new ReadableStream({
    async pull(controller) {
      if (sent >= length) { controller.close(); return; }
      const want = Math.min(CHUNK, length - sent);
      const piece = await job.region(start + sent, start + sent + want);
      if (piece.byteLength === 0) { controller.close(); return; }
      controller.enqueue(piece);
      sent += piece.byteLength;
    },
  });
  return new Response(body, { status: hasRange ? 206 : 200, headers });
}

/* ---------------- request handler ---------------- */
async function handle(request) {
  const url = new URL(request.url);
  const idx = url.pathname.indexOf(MARK);
  const rest = url.pathname.slice(idx + MARK.length);
  const slash = rest.indexOf("/");
  if (slash < 0) return new Response("bad virtual URL", { status: 400 });

  let srcUrl;
  try { srcUrl = b64urlDecode(rest.slice(0, slash)); }
  catch (e) { return new Response("bad source URL", { status: 400 }); }

  let name;
  try { name = decodeURIComponent(rest.slice(slash + 1)); }
  catch (e) { return new Response("bad entry name", { status: 400 }); }

  // entry metadata supplied by the page (it already parsed the ZIP index)
  const q = url.searchParams;
  const dataOff = Number(q.get("o"));
  const method = Number(q.get("m"));
  const compSize = Number(q.get("c"));
  const uncompSize = Number(q.get("u"));
  if (!Number.isFinite(dataOff) || !Number.isFinite(compSize) || !Number.isFinite(uncompSize)) {
    return new Response("missing entry metadata", { status: 400 });
  }

  const type = extType(name) || "application/octet-stream";
  const total = uncompSize;

  try {
    const range = parseRange(request.headers.get("Range"), total);
    if (range && range.unsatisfiable) {
      return new Response(null, {
        status: 416,
        headers: { "Content-Range": `bytes */${total}`, "Accept-Ranges": "bytes" },
      });
    }

    // HEAD: send only headers
    if (request.method === "HEAD") {
      const length = range ? range.end - range.start + 1 : total;
      const headers = range
        ? rangeHeaders(range.start, length, total, type)
        : fullHeaders(length, type);
      return new Response(null, { status: range ? 206 : 200, headers });
    }

    const conn = await getConn(srcUrl);
    const start = range ? range.start : 0;
    const length = range ? range.end - range.start + 1 : total;

    if (method === 0) {
      return storedResponse(conn, dataOff, start, length, total, type, !!range);
    }
    if (method === 8) {
      if (typeof DecompressionStream === "undefined") {
        return new Response("This browser's Service Worker lacks DecompressionStream", { status: 501 });
      }
      const key = srcUrl + "#" + name;
      let job = inflateJobs.get(key);
      if (!job) {
        job = new InflateJob(conn, dataOff, compSize, uncompSize);
        inflateJobs.set(key, job);
      }
      job.start();
      return inflateResponse(job, start, length, total, type, !!range);
    }
    return new Response("unsupported ZIP compression method " + method, { status: 415 });
  } catch (e) {
    return new Response("stream error: " + e.message, { status: 500 });
  }
}

/* ---------------- lifecycle ---------------- */
self.addEventListener("install", (event) => {
  self.skipWaiting();
});
self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});
self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (url.pathname.indexOf(MARK) < 0) return; // everything else: normal network
  if (event.request.method !== "GET" && event.request.method !== "HEAD") return;
  event.respondWith(handle(event.request));
});
