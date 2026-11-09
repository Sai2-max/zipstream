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
const ROOT = path.resolve(__dirname, "..");   // repo root = frontend files
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
  return Buffer.concat(parts);
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
    ...CORS,
  };
  if (range) headers["Content-Range"] = `bytes ${start}-${end}/${size}`;

  res.writeHead(range ? 206 : 200, headers);
  if (req.method === "HEAD") return res.end();

  let sent = 0;
  try {
    while (sent < length) {
      const n = Math.min(CHUNK, length - sent);
      const buf = await fetchRange(meta, start + sent, n);
      if (!buf || buf.length === 0) break;
      if (!res.write(buf)) {
        await new Promise((r) => res.once("drain", r));
      }
      sent += buf.length;
    }
    res.end();
  } catch (e) {
    console.error("stream error:", e.message);
    res.destroy(e);
  }
}

/** Transcode endpoint: streams Telegram video through FFmpeg (HEVC → H.264) for browser playback. */
async function handleTranscode(req, res, url) {
  const target = url.searchParams.get("url");
  const entryName = url.searchParams.get("entry"); // for ZIP entries
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

  // For ZIP files, we'd need to extract the specific entry first
  // This version transcodes the whole file (works for direct video posts)
  if (meta.kind === "file" && !meta.isVideo) {
    return sendJson(res, 400, { ok: false, error: "Not a video file. Use /api/stream for ZIP entries." });
  }

  const range = req.headers.range;
  const totalSize = meta.size;

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

  // Handle client disconnect
  req.on("close", () => {
    ffmpegProcess?.kill("SIGKILL");
    outputStream.destroy();
  });

  let ffmpegProcess = null;

  try {
    // Create input stream from Telegram
    const inputStream = new PassThrough();

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

    // Feed Telegram data into FFmpeg input
    const feedTelegram = async () => {
      let sent = 0;
      try {
        while (sent < totalSize) {
          const n = Math.min(CHUNK, totalSize - sent);
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
