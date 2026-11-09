/* ZipStream Telegram backend — resolves t.me posts and streams their video
   with HTTP Range support (seekable <video> playback). MTProto user session.
   Includes FFmpeg transcode for HEVC/H.265 → H.264 browser playback. */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import bigInt from "big-integer";
import ffmpeg from "fluent-ffmpeg";
import { loadEnv, createClient, resolveMedia } from "./common.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const PORT = Number(process.env.PORT || 8787);
const CHUNK = 1024 * 1024;        // 1 MB per HTTP response chunk
const REQUEST_SIZE = 512 * 1024;  // MTProto GetFile request size (Telegram's max)
const CACHE_TTL = 10 * 60 * 1000; // keep resolved message (file ref) for 10 min

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Range, Content-Type",
  "Access-Control-Expose-Headers": "Content-Range, Accept-Ranges, Content-Length",
};

const env = loadEnv();
const client = env.TG_API_ID && env.TG_API_HASH ? createClient(env) : null;
const mediaCache = new Map(); // t.me url -> { resolvedAt, meta }

/* ===== ZipCrypto (traditional PKWARE) ===== */
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[i] = c >>> 0;
  }
  return t;
})();
const crc32byte = (crc, b) => ((crc >>> 8) ^ CRC_TABLE[(crc ^ b) & 0xFF]) >>> 0;

class ZipCrypto {
  constructor(password) {
    this.k0 = 0x12345678; this.k1 = 0x23456789; this.k2 = 0x34567890;
    for (let i = 0; i < password.length; i++) this.update(password.charCodeAt(i) & 0xFF);
  }
  update(b) {
    this.k0 = crc32byte(this.k0, b);
    this.k1 = (Math.imul((this.k1 + (this.k0 & 0xFF)) >>> 0, 134775813) + 1) >>> 0;
    this.k2 = crc32byte(this.k2, (this.k1 >>> 24) & 0xFF);
  }
  decryptByte() {
    const t = (this.k2 | 2) & 0xFFFF;
    return (Math.imul(t, t ^ 1) >>> 8) & 0xFF;
  }
  decrypt(bytes) {
    const out = Buffer.alloc(bytes.length);
    for (let i = 0; i < bytes.length; i++) {
      const p = bytes[i] ^ this.decryptByte();
      this.update(p);
      out[i] = p;
    }
    return out;
  }
}

/** Read and decrypt a ZIP entry stream from Telegram. */
async function createEntryStream(meta, dataOff, compSize, password) {
  const { PassThrough } = await import("node:stream");
  const out = new PassThrough({ highWaterMark: 16 * 1024 * 1024 });

  const encrypted = password && password.length > 0;
  const cipher = encrypted ? new ZipCrypto(password) : null;
  let headerBuf = Buffer.alloc(12);
  let headerGot = 0, headerChecked = false, pos = 0;

  try {
    while (pos < compSize) {
      const n = Math.min(CHUNK, compSize - pos);
      const buf = await fetchRange(meta, dataOff + pos, n);
      if (!buf || buf.length === 0) break;
      pos += buf.length;

      let chunk = buf;
      if (encrypted) {
        if (!headerChecked) {
          const take = Math.min(12 - headerGot, chunk.length);
          chunk.copy(headerBuf, headerGot, 0, take);
          headerGot += take;
          chunk = chunk.subarray(take);
          if (headerGot < 12) continue;
          cipher.decrypt(headerBuf); // advance key state
          headerChecked = true;
        }
        if (chunk.length) chunk = cipher.decrypt(chunk);
      }
      out.write(chunk);
    }
    out.end();
  } catch (e) {
    out.destroy(e);
  }
  return out;
}

async function ensureConnected() {
  if (!client) {
    throw new Error("Not logged in. Run `npm run login` in the backend folder first.");
  }
  if (!client.connected) await client.connect();
  if (!(await client.checkAuthorization())) {
    throw new Error("Not logged in. Run `npm run login` in the backend folder first.");
  }
  return client;
}

async function getMedia(url) {
  const now = Date.now();
  const cached = mediaCache.get(url);
  if (cached && now - cached.resolvedAt < CACHE_TTL) return cached.meta;
  await ensureConnected();
  const meta = await resolveMedia(client, url);
  mediaCache.set(url, { resolvedAt: now, meta });
  return meta;
}

function parseRange(header, size) {
  if (!header) return null;
  const m = header.match(/bytes=(\d*)-(\d*)/);
  if (!m) return null;
  let start, end;
  if (m[1] === "" && m[2] === "") return null;
  if (m[1] === "") {
    const n = parseInt(m[2], 10);
    start = Math.max(0, size - n);
    end = size - 1;
  } else {
    start = parseInt(m[1], 10);
    end = m[2] === "" ? size - 1 : Math.min(parseInt(m[2], 10), size - 1);
  }
  if (start > end || start >= size) return { unsatisfiable: true };
  return { start, end };
}

/** Fetch exactly `n` bytes of the media starting at `pos` (fewer at EOF). */
async function fetchRange(meta, pos, n) {
  let lastErr = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      if (!client.connected) await client.connect();
      const iter = client.iterDownload({
        file: meta.media,          // MessageMediaDocument / MessageMediaPhoto
        offset: bigInt(pos),
        chunkSize: n,
        stride: n,
        limit: 1,
        requestSize: REQUEST_SIZE,
      });
      const parts = [];
      for await (const c of iter) parts.push(c);
      const buf = Buffer.concat(parts);
      // gramJS aligns reads to request boundaries and can return more than we
      // asked for near EOF. Never exceed n or Content-Length will be wrong.
      return buf.length > n ? buf.subarray(0, n) : buf;
    } catch (e) {
      lastErr = e;
      console.error(`[fetchRange] ${e.message} — reconnect + retry ${attempt + 1}/3`);
      try { await client.connect(); } catch { /* next attempt */ }
      await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
    }
  }
  throw lastErr;
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(body),
    ...CORS,
  });
  res.end(body);
}

async function handleResolve(req, res, url) {
  const target = url.searchParams.get("url");
  if (!target) return sendJson(res, 400, { ok: false, error: "Missing ?url=" });
  try {
    const meta = await getMedia(target);
    if (meta.kind === "photo") {
      return sendJson(res, 200, { ok: true, kind: "photo", title: meta.title });
    }
    if (meta.kind === "file") {
      return sendJson(res, 200, {
        ok: true,
        kind: "file",
        title: meta.title,
        mime: meta.mime,
        size: meta.size,
      });
    }
    sendJson(res, 200, {
      ok: true,
      kind: "video",
      title: meta.title,
      mime: meta.mime,
      size: meta.size,
      duration: meta.duration,
      width: meta.width,
      height: meta.height,
      stream: `/api/stream?url=${encodeURIComponent(target)}`,
    });
  } catch (e) {
    sendJson(res, 500, { ok: false, error: e.message });
  }
}

async function handleStream(req, res, url) {
  const target = url.searchParams.get("url");
  if (!target) return sendJson(res, 400, { ok: false, error: "Missing ?url=" });

  let meta;
  try {
    meta = await getMedia(target);
  } catch (e) {
    return sendJson(res, 500, { ok: false, error: e.message });
  }
  if (meta.kind === "photo") {
    return sendJson(res, 400, { ok: false, error: "This post is a photo, not a streamable file." });
  }

  const size = meta.size;
  const range = parseRange(req.headers.range, size);
  if (range && range.unsatisfiable) {
    res.writeHead(416, { "Content-Range": `bytes */${size}`, ...CORS });
    return res.end();
  }

  const start = range ? range.start : 0;
  const end = range ? range.end : size - 1;
  const length = end - start + 1;
  const headers = {
    "Content-Type": meta.mime,
    "Accept-Ranges": "bytes",
    "Cache-Control": "no-store",
    "Content-Length": String(length),
    // One response per TCP connection: Chrome reuses keep-alive sockets and
    // occasionally hits ERR_EMPTY_RESPONSE when the server closes an idle one
    // mid-read. Closing here makes every range request deterministic.
    "Connection": "close",
    ...CORS,
  };
  if (range) headers["Content-Range"] = `bytes ${start}-${end}/${size}`;
  return pumpMedia(req, res, meta, start, length, headers, range ? 206 : 200);
}

/** Download one stored ZIP entry directly from Telegram — no client buffering. */
async function handleEntry(req, res, url) {
  const target = url.searchParams.get("url");
  const off = Number(url.searchParams.get("off"));
  const len = Number(url.searchParams.get("len"));
  const name = url.searchParams.get("name") || "video.mp4";
  const type = url.searchParams.get("type") || "application/octet-stream";
  if (!target || !Number.isFinite(off) || !Number.isFinite(len) || off < 0 || len <= 0) {
    return sendJson(res, 400, { ok: false, error: "Need ?url=&off=&len=" });
  }

  let meta;
  try {
    meta = await getMedia(target);
  } catch (e) {
    return sendJson(res, 500, { ok: false, error: e.message });
  }
  if (off + len > meta.size) {
    return sendJson(res, 400, { ok: false, error: "Entry range is outside the file." });
  }

  const range = parseRange(req.headers.range, len);
  if (range && range.unsatisfiable) {
    res.writeHead(416, { "Content-Range": `bytes */${len}`, ...CORS });
    return res.end();
  }
  const start = off + (range ? range.start : 0);
  const length = range ? range.end - range.start + 1 : len;
  const safeName = (name.split(/[\\/]/).pop() || "video.mp4");
  const asciiName = safeName.replace(/[^\x20-\x7E]/g, "_").replace(/"/g, "'");
  const headers = {
    "Content-Type": type,
    "Accept-Ranges": "bytes",
    "Cache-Control": "no-store",
    "Content-Length": String(length),
    "Content-Disposition": `attachment; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(safeName)}`,
    "Connection": "close",
    ...CORS,
  };
  if (range) headers["Content-Range"] = `bytes ${range.start}-${range.end}/${len}`;
  return pumpMedia(req, res, meta, start, length, headers, range ? 206 : 200);
}

/** Stream `length` bytes of `meta` starting at absolute offset `start`. */
async function pumpMedia(req, res, meta, start, length, headers, status) {
  if (req.method === "HEAD") {
    res.writeHead(status, headers);
    return res.end();
  }

  // Prefetch the first chunk before sending headers, so a Telegram outage
  // becomes a readable JSON error instead of a dead socket ("Failed to fetch").
  console.log(`[stream] ${start}+${length}`);
  let first;
  try {
    first = await fetchRange(meta, start, Math.min(CHUNK, length));
    if (!first || first.length === 0) throw new Error("Telegram returned no data");
  } catch (e) {
    console.error("stream preflight error:", e.message);
    return sendJson(res, 502, {
      ok: false,
      error: "Telegram connection problem — " + e.message + ". Retrying usually works.",
    });
  }

  res.writeHead(status, headers);

  const writeChunk = (buf) => new Promise((resolve, reject) => {
    const onDrain = () => { cleanup(); resolve(); };
    const onClose = () => { cleanup(); reject(new Error("client disconnected")); };
    const cleanup = () => { res.off("drain", onDrain); res.off("close", onClose); };
    if (res.write(buf)) { cleanup(); resolve(); }
    else { res.once("drain", onDrain); res.once("close", onClose); }
  });

  let sent = 0;
  try {
    await writeChunk(first);
    sent = first.length;
    while (sent < length) {
      const n = Math.min(CHUNK, length - sent);
      const buf = await fetchRange(meta, start + sent, n);
      if (!buf || buf.length === 0) throw new Error(`Telegram returned no data at ${start + sent}`);
      await writeChunk(buf.length > n ? buf.subarray(0, n) : buf);
      sent += Math.min(buf.length, n);
    }
    res.end();
  } catch (e) {
    console.error("stream error:", e.message);
    res.destroy(e);
  }
}

/** Transcode endpoint: streams Telegram video (or ZIP entry) through FFmpeg (HEVC → H.264) for browser playback. */
async function handleTranscode(req, res, url) {
  const target = url.searchParams.get("url");
  const entryName = url.searchParams.get("entry");
  const dataOff = Number(url.searchParams.get("off"));
  const compSize = Number(url.searchParams.get("len"));
  const password = url.searchParams.get("pw") || "";
  if (!target) return sendJson(res, 400, { ok: false, error: "Missing ?url=" });

  let meta;
  try {
    meta = await getMedia(target);
  } catch (e) {
    return sendJson(res, 500, { ok: false, error: e.message });
  }
  if (meta.kind === "photo") {
    return sendJson(res, 400, { ok: false, error: "This post is a photo." });
  }

  // ZIP entry: need off+len, otherwise transcode whole file (direct video)
  const isZipEntry = Number.isFinite(dataOff) && Number.isFinite(compSize) && dataOff >= 0 && compSize > 0;
  if (meta.kind === "file" && !meta.isVideo && !isZipEntry) {
    return sendJson(res, 400, { ok: false, error: "Not a video file. Use /api/stream for ZIP entries." });
  }

  const range = req.headers.range;
  // We don't know the output size in advance (transcoding changes it)
  // So we stream without Content-Length, using chunked transfer
  res.writeHead(200, {
    "Content-Type": "video/mp4",
    "Accept-Ranges": "bytes",
    "Cache-Control": "no-store",
    "Transfer-Encoding": "chunked",
    ...CORS,
  });

  if (req.method === "HEAD") return res.end();

  // Create a PassThrough stream for FFmpeg output
  const { PassThrough } = await import("node:stream");
  const outputStream = new PassThrough();

  // Pipe FFmpeg output to HTTP response
  outputStream.pipe(res);

  let ffmpegProcess = null;

  // Handle client disconnect
  req.on("close", () => {
    if (ffmpegProcess?.ffmpegProc) ffmpegProcess.ffmpegProc.kill("SIGKILL");
    outputStream.destroy();
  });

  try {
    // Create input stream from Telegram (ZIP entry or whole file)
    let inputStream;
    if (isZipEntry) {
      inputStream = await createEntryStream(meta, dataOff, compSize, password);
    } else {
      inputStream = new PassThrough({ highWaterMark: 16 * 1024 * 1024 });
      const feedTelegram = async () => {
        let sent = 0;
        try {
          while (sent < meta.size) {
            const n = Math.min(CHUNK, meta.size - sent);
            const buf = await fetchRange(meta, sent, n);
            if (!buf || buf.length === 0) break;
            inputStream.write(buf);
            sent += buf.length;
          }
          inputStream.end();
        } catch (e) {
          console.error("[transcode] feed error:", e.message);
          inputStream.destroy(e);
        }
      };
      feedTelegram();
    }

    // Start FFmpeg: input from Telegram stream, output H.264 MP4
    ffmpegProcess = ffmpeg(inputStream)
      .inputOptions([
        "-analyzeduration", "1000000",  // 1ms analyze
        "-probesize", "500000",
        "-fflags", "+genpts",
      ])
      .outputOptions([
        "-c:v", "libx264",
        "-preset", "ultrafast",
        "-tune", "zerolatency",
        "-profile:v", "baseline",
        "-level", "3.0",
        "-pix_fmt", "yuv420p",
        "-c:a", "aac",
        "-b:a", "128k",
        "-f", "mp4",
        "-movflags", "frag_keyframe+empty_moov+default_base_moof",
        "-flags", "+global_header",
      ])
      .on("start", (cmd) => console.log("[transcode] FFmpeg started:", cmd))
      .on("error", (err) => {
        console.error("[transcode] FFmpeg error:", err.message);
        if (!res.writableEnded) res.destroy(err);
      })
      .on("end", () => {
        console.log("[transcode] FFmpeg finished");
        if (!res.writableEnded) outputStream.end();
      })
      .pipe(outputStream, { end: true });

  } catch (e) {
    console.error("[transcode] setup error:", e.message);
    if (!res.writableEnded) res.destroy(e);
  }
}

/** Serve the frontend from the repo root so one process runs the whole app. */
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".wasm": "application/wasm",
  ".zip": "application/zip",
};

function serveStatic(req, res, pathname) {
  let rel;
  try {
    rel = pathname === "/" ? "index.html" : decodeURIComponent(pathname).replace(/^\/+/, "");
  } catch {
    return sendJson(res, 400, { ok: false, error: "Bad path" });
  }
  const file = path.resolve(ROOT, rel);
  const ext = path.extname(file).toLowerCase();
  // Only serve known static assets, never backend source, dotfiles or .env
  if (!file.startsWith(ROOT + path.sep) || rel.split(/[\\/]/)[0] === "backend" ||
      rel.startsWith(".") || !MIME[ext]) {
    return sendJson(res, 404, { ok: false, error: "not found" });
  }
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) return sendJson(res, 404, { ok: false, error: "not found" });
    res.writeHead(200, {
      "Content-Type": MIME[ext],
      "Content-Length": st.size,
      "Cache-Control": "no-store",
      ...(ext === ".js" ? { "Service-Worker-Allowed": "/" } : {}),
    });
    if (req.method === "HEAD") return res.end();
    fs.createReadStream(file).pipe(res);
  });
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, `http://${req.headers.host || "127.0.0.1"}`);
  if (req.method === "OPTIONS") {
    res.writeHead(204, CORS);
    return res.end();
  }
  if (u.pathname === "/health") {
    let authorized = false;
    if (client) {
      try {
        if (!client.connected) await client.connect();
        authorized = await client.checkAuthorization();
      } catch (e) { authorized = false; }
    }
    return sendJson(res, 200, { ok: true, authorized, needLogin: !authorized });
  }
  if (u.pathname === "/api/resolve") return handleResolve(req, res, u);
  if (u.pathname === "/api/stream") return handleStream(req, res, u);
  if (u.pathname === "/api/entry") return handleEntry(req, res, u);
  if (u.pathname === "/api/transcode") return handleTranscode(req, res, u);
  if (req.method === "GET" || req.method === "HEAD") return serveStatic(req, res, u.pathname);
  sendJson(res, 404, { ok: false, error: "not found" });
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`ZipStream app → http://localhost:${PORT}`);
  console.log("  /             the web UI (index.html, app.js, style.css, sw.js)");
  console.log("  /health       status");
  console.log("  /api/resolve  ?url=https://t.me/channel/123");
  console.log("  /api/stream   ?url=https://t.me/channel/123  (supports Range)");
  console.log("  /api/transcode ?url=https://t.me/channel/123 (HEVC → H.264)");
});
