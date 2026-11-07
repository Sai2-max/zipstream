/* ============================================================
   ZipStream — play a single file out of a hosted ZIP remotely.
   Reads the ZIP central directory over HTTP Range requests and
   downloads ONLY the byte-span of the chosen file.
   ============================================================ */
"use strict";

/* ---------------- constants ---------------- */
const EOCD_SIG = 0x06054b50;
const CEN_SIG = 0x02014b50;
const LOC_SIG = 0x04034b50;
const ZIP64_EOCD_SIG = 0x06064b50;
const ZIP64_LOC_SIG = 0x07064b50;
const CHUNK = 4 * 1024 * 1024; // 4 MB download chunks
const MAX_CD_SIZE = 64 * 1024 * 1024; // sanity cap for central directory

/* ---------------- DOM ---------------- */
const $ = (id) => document.getElementById(id);
const urlInput = $("urlInput"), loadBtn = $("loadBtn"), proxyMode = $("proxyMode");
const statusEl = $("status"), progressWrap = $("progressWrap"), progressBar = $("progressBar");
const progressText = $("progressText"), cancelBtn = $("cancelBtn");
const zipNameEl = $("zipName"), zipMetaEl = $("zipMeta"), fileListEl = $("fileList");
const filesCard = $("filesCard"), tgCard = $("tgCard"), tgBody = $("tgBody");
const playerCard = $("playerCard"), player = $("player"), playerTitle = $("playerTitle"), fetchMeta = $("fetchMeta");

let currentAbort = null;
let swReady = false;      // Service Worker controlling this page → seekable streaming on
let streamActive = false; // current playback is SW streaming (used for error fallback)

/* ---------------- logging / status ---------------- */
function setStatus(text, kind) {
  statusEl.hidden = false;
  statusEl.className = "status" + (kind ? " " + kind : "");
  statusEl.textContent = text;
}
function setProgress(show, pct, text) {
  progressWrap.hidden = !show;
  if (show) {
    progressBar.style.width = (pct || 0) + "%";
    progressText.textContent = text || "";
  }
}

/* ============================================================
   Range fetch layer with fallback chain
   ============================================================ */
const PROXY_BUILDERS = {
  "corsproxy.io": (u) => "https://corsproxy.io/?url=" + encodeURIComponent(u),
  "allorigins": (u) => "https://api.allorigins.win/raw?url=" + encodeURIComponent(u),
  "cors.workers.dev": (u) => "https://test.cors.workers.dev/?u=" + encodeURIComponent(u),
  "isomorphic-git": (u) => "https://cors.isomorphic-git.org/" + u,
};

function modeList() {
  const mode = proxyMode.value;
  if (mode === "direct") return [null];
  if (mode === "auto") return [null, "corsproxy.io", "allorigins", "cors.workers.dev", "isomorphic-git"];
  const list = [null, mode];
  return [...new Set(list)]; // dedupe (direct mode excluded above)
}

/**
 * Probe candidates with an explicit 1-byte range ("bytes=0-1").
 * Proves honest Range support via the 206 status; the Content-Range
 * header is often hidden by CORS and is never relied on.
 */
async function probe(url, signal) {
  const candidates = modeList();
  for (const key of candidates) {
    const target = key ? PROXY_BUILDERS[key](url) : url;
    try {
      const r = await fetch(target, { headers: { Range: "bytes=0-1" }, signal });
      if (r.status !== 206) continue; // 200 → server ignores Range; anything else → broken
      const buf = new Uint8Array(await r.arrayBuffer());
      if (buf.byteLength >= 1) return { key };
    } catch (e) {
      if (e.name === "AbortError") throw e;
    }
  }
  return null;
}

/**
 * Find the exact file size using tiny 1-byte range probes:
 * "bytes=N-N" answers 206 while N exists and 416 once N is past the end.
 * Cost ≈ 2 × log2(size) one-byte requests.
 */
async function findSize(signal) {
  // Fast path: some hosts expose the total via Content-Range / Content-Length
  // (CORS-permitting). Saves ~2×log2(size) probes on large files.
  try {
    const candidates = modeList();
    for (const key of candidates) {
      const target = key ? PROXY_BUILDERS[key](conn.url) : conn.url;
      const r = await fetch(target, { headers: { Range: "bytes=0-0" }, signal });
      const cr = r.headers.get("Content-Range"); // e.g. "bytes 0-0/12345"
      const m = cr && cr.match(/\/(\d+)\s*$/);
      if (m) return parseInt(m[1], 10);
      if (r.status === 200) {
        const cl = r.headers.get("Content-Length");
        if (cl && parseInt(cl, 10) > 0) return parseInt(cl, 10);
      }
    }
  } catch (e) { /* fall back to binary search below */ }

  const probeByte = async (pos) => {
    const candidates = modeList();
    const order = conn && conn.key
      ? [conn.key, ...candidates.filter((k) => k !== conn.key)]
      : candidates;
    for (const key of order) {
      const target = key ? PROXY_BUILDERS[key](conn.url) : conn.url;
      try {
        const r = await fetch(target, { headers: { Range: `bytes=${pos}-${pos}` }, signal });
        if (r.status === 416) return "eof";
        if (r.ok) {
          const b = await r.arrayBuffer();
          if (b.byteLength > 0) return "ok";
        }
      } catch (e) {
        if (e.name === "AbortError") throw e;
      }
    }
    throw new Error("Size probe failed (no candidate answered a 1-byte range).");
  };
  let lo = 0, hi = 4096;
  // exponential search: grow hi until it is past the end
  for (;;) {
    const v = await probeByte(hi);
    if (v === "eof") break;
    lo = hi;
    hi *= 2;
    if (hi > 34359738368) throw new Error("File too large / size probe gave up at 32 GiB.");
  }
  // binary search for exact end
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    const v = await probeByte(mid);
    if (v === "ok") lo = mid; else hi = mid;
  }
  return lo + 1;
}

/** Chosen fetcher state after probe */
let conn = null; // { key, total, url }

/** Fetch a byte range as Uint8Array using the chosen connection, with one fallback retry. */
async function getBytes(start, length, signal) {
  const candidates = modeList();
  // try chosen first, then remaining candidates
  const order = conn && conn.key
    ? [conn.key, ...candidates.filter((k) => k !== conn.key)]
    : candidates;
  let lastErr = null;
  for (const key of order) {
    const target = key ? PROXY_BUILDERS[key](conn.url) : conn.url;
    const need = length;
    if (need <= 0) return new Uint8Array(0);
    try {
      const r = await fetch(target, {
        headers: { Range: `bytes=${start}-${start + need - 1}` },
        signal,
      });
      if (r.status === 416) throw new Error("range past end of file");
      if (!r.ok) throw new Error("HTTP " + r.status);
      const buf = new Uint8Array(await r.arrayBuffer());
      if (buf.byteLength === 0) throw new Error("empty response");
      return buf;
    } catch (e) {
      if (e.name === "AbortError") throw e;
      lastErr = e;
    }
  }
  throw new Error("Range fetch failed: " + (lastErr && lastErr.message));
}

/* ============================================================
   Remote ZIP reader (EOCD + ZIP64 + central directory)
   ============================================================ */
class RemoteZip {
  constructor() {
    this.entries = [];
    this.comment = null;
  }

  async open(progressCb, signal) {
    // 1) find the exact file size with 1-byte probes (Content-Range is hidden
    //    by CORS on strict hosts, so we never rely on it)
    const total = await findSize(signal);
    conn.total = total;
    progressCb && progressCb(0.02);

    // 2) locate End Of Central Directory in the file tail
    const tailLen = Math.min(66 * 1024, total);
    const tail = await getBytes(total - tailLen, tailLen, signal);
    if (tail.byteLength < 22) throw new Error("File too small to be a ZIP.");
    const dv = new DataView(tail.buffer, tail.byteOffset, tail.byteLength);
    let eocdIdx = -1;
    for (let i = tailLen - 22; i >= 0; i--) {
      if (dv.getUint32(i, true) === EOCD_SIG) { eocdIdx = i; break; }
    }
    if (eocdIdx < 0) {
      throw new Error("Not a ZIP file (no End-Of-Central-Directory found).");
    }
    let cdCount = dv.getUint16(eocdIdx + 10, true);
    let cdSize = dv.getUint32(eocdIdx + 12, true);
    let cdOff = dv.getUint32(eocdIdx + 16, true);
    const nLen = dv.getUint16(eocdIdx + 20, true);
    this.comment = nLen ? new TextDecoder().decode(tail.subarray(eocdIdx + 22, eocdIdx + 22 + nLen)) : null;

    // 2) ZIP64 support
    if (cdCount === 0xffff || cdSize === 0xffffffff || cdOff === 0xffffffff) {
      const locIdx = eocdIdx - 20;
      if (locIdx >= 0 && dv.getUint32(locIdx, true) === ZIP64_LOC_SIG) {
        const z64Off = bigIntFromPair(dv, locIdx + 8);
        const rec = await getBytes(z64Off, 56, signal);
        const rd = new DataView(rec.buffer, rec.byteOffset, rec.byteLength);
        if (rd.getUint32(0, true) === ZIP64_EOCD_SIG) {
          cdCount = rd.getUint32(32, true);
          cdSize = bigIntFromPair(rd, 40);
          cdOff = bigIntFromPair(rd, 48);
        }
      }
    }
    if (cdSize > MAX_CD_SIZE) throw new Error("Central directory too large (" + fmtBytes(cdSize) + ").");
    progressCb && progressCb(0.08);

    // 3) fetch + parse the central directory
    const cd = await getAllBytes(cdOff, cdSize, (frac) => progressCb && progressCb(0.08 + frac * 0.9), signal);
    parseCentralDirectory.call(this, cd, cdCount, cdOff);
    progressCb && progressCb(1);
    return this.entries;
  }
}

function bigIntFromPair(dv, off) {
  const lo = dv.getUint32(off, true);       // low 32 bits (first 4 bytes, little-endian)
  const hi = dv.getUint32(off + 4, true);   // high 32 bits (next 4 bytes)
  return hi * 4294967296 + lo;
}

/** Parse central directory records from a Uint8Array (relative offsets = absolute − cdOffBase). */
function parseCentralDirectory(cd, count, cdAbsOffset) {
  const dv = new DataView(cd.buffer, cd.byteOffset, cd.byteLength);
  const td = new TextDecoder();
  let p = 0;
  for (let n = 0; n < count && p + 46 <= cd.length; n++) {
    if (dv.getUint32(p, true) !== CEN_SIG) break;
    const flags = dv.getUint16(p + 8, true);
    const method = dv.getUint16(p + 10, true);
    const compSizeR = dv.getUint32(p + 20, true);
    const uncompSizeR = dv.getUint32(p + 24, true);
    const nameLen = dv.getUint16(p + 28, true);
    const extraLen = dv.getUint16(p + 30, true);
    const commentLen = dv.getUint16(p + 32, true);
    const lhoR = dv.getUint32(p + 42, true);

    const name = decodeName(td, cd.subarray(p + 46, p + 46 + nameLen), flags);
    let compSize = compSizeR, uncompSize = uncompSizeR, lo = lhoR;
    // zip64 extra field
    if (compSizeR === 0xffffffff || uncompSizeR === 0xffffffff || lhoR === 0xffffffff) {
      let e = p + 46 + nameLen;
      const eEnd = e + extraLen;
      while (e + 4 <= eEnd) {
        const id = dv.getUint16(e, true);
        const sz = dv.getUint16(e + 2, true);
        if (id === 0x0001) {
          let q = e + 4;
          if (uncompSizeR === 0xffffffff) { uncompSize = bigIntFromPair(dv, q); q += 8; }
          if (compSizeR === 0xffffffff) { compSize = bigIntFromPair(dv, q); q += 8; }
          if (lhoR === 0xffffffff) { lo = bigIntFromPair(dv, q); q += 8; }
          break;
        }
        e += 4 + sz;
      }
    }
    const comment = commentLen
      ? decodeName(td, cd.subarray(p + 46 + nameLen + extraLen, p + 46 + nameLen + extraLen + commentLen), flags)
      : "";

    this.entries.push({ name, method, flags, compSize, uncompSize, localOffset: lo, comment });
    p += 46 + nameLen + extraLen + commentLen;
  }
  if (!this.entries.length) throw new Error("ZIP index parsed but it has 0 entries (encrypted or non-standard ZIP?).");
}

function decodeName(td, bytes, flags) {
  const utf8 = (flags & 0x0800) !== 0;
  if (utf8) return td.decode(bytes);
  // Windows codepage fallback (approximate via windows-1252)
  try { return new TextDecoder("windows-1252").decode(bytes); }
  catch (e) { return td.decode(bytes); }
}

/** Sequential chunked fetch of a large span, calling back with progress. */
async function getAllBytes(start, length, onFrac, signal) {
  const out = new Uint8Array(length);
  let pos = 0;
  while (pos < length) {
    const n = Math.min(CHUNK, length - pos);
    const chunk = await getBytes(start + pos, n, signal);
    out.set(chunk, pos);
    pos += n;
    onFrac && onFrac(pos / length);
  }
  return out;
}

/* ============================================================
   Playback: stream just the chosen entry, inflate if needed
   ============================================================ */
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
function isPlayable(name) { const t = extType(name); return !!t && /^video|audio/.test(t); }

let lastObjectURL = null;
function revokeLast() { if (lastObjectURL) { URL.revokeObjectURL(lastObjectURL); lastObjectURL = null; } }

function b64urlEncode(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Same-origin virtual URL the Service Worker serves as a seekable file. */
function virtualUrl(entry, dataOff) {
  return "__zip__/" + b64urlEncode(conn.url) + "/" + encodeURIComponent(entry.name) +
    "?o=" + dataOff + "&m=" + entry.method + "&c=" + entry.compSize + "&u=" + entry.uncompSize;
}

/** Resolve a local header to the exact byte offset where entry data begins. */
async function resolveDataOff(entry, signal) {
  const sigLoc = await getBytes(entry.localOffset, 30, signal);
  const ldv = new DataView(sigLoc.buffer, sigLoc.byteOffset, sigLoc.byteLength);
  if (ldv.getUint32(0, true) !== LOC_SIG) throw new Error("Corrupt ZIP (bad local header for " + entry.name + ")");
  const lNameLen = ldv.getUint16(26, true);
  const lExtraLen = ldv.getUint16(28, true);
  return entry.localOffset + 30 + lNameLen + lExtraLen;
}

async function playEntry(entry) {
  playerCard.hidden = false;
  playerCard.scrollIntoView({ behavior: "smooth", block: "start" });
  playerTitle.textContent = entry.name;
  revokeLast();
  player.src = "";
  player.onerror = null;
  streamActive = false;
  loadBtn.disabled = true;
  const signal = new AbortController();
  currentAbort = signal;

  try {
    const dataOff = await resolveDataOff(entry, signal.signal);
    const canStream = swReady && (entry.method === 0 || (entry.method === 8 && typeof DecompressionStream !== "undefined"));
    if (canStream) {
      startStream(entry, dataOff);
    } else {
      await playEntryBlob(entry, dataOff, signal);
    }
  } catch (e) {
    setProgress(false);
    if (e.name === "AbortError") setStatus("Cancelled.", "warn");
    else setStatus("❌ Playback failed: " + e.message + (String(e.message).includes("DecompressionStream") ? "\nYour browser lacks DecompressionStream — use a current Chrome/Edge/Firefox." : ""), "err");
  } finally {
    loadBtn.disabled = false;
    currentAbort = null;
  }
}

/** True streaming: hand the Service Worker virtual URL to <video>. */
function startStream(entry, dataOff) {
  streamActive = true;
  fetchMeta.textContent = entry.method === 0
    ? "Streaming (stored entry) — instant start, seek anywhere; only watched bytes are fetched"
    : "Streaming (deflated entry) — inflating in a Service Worker; seek within already-loaded data";
  setProgress(false);
  const url = virtualUrl(entry, dataOff);
  
  const handleError = () => {
    if (!streamActive) return;
    streamActive = false;
    player.onerror = null;
    player.src = "";
    setStatus("Streaming failed — retrying with full-entry download…", "warn");
    playEntryBlob(entry, dataOff, new AbortController()).catch(() => {});
  };
  
  player.onerror = handleError;
  player.src = url;
  player.play().catch((e) => {
    // Codec not supported often throws here, not via onerror
    if (e.name === "NotSupportedError" || e.name === "MediaError") {
      handleError();
    }
  });
  setStatus(`▶ Streaming "${entry.name}" — the browser fetches only the byte ranges it needs; the ZIP stays on the server.`, "ok");
}

/** Fallback: download the whole entry, inflate if needed, play from a Blob. */
async function playEntryBlob(entry, dataOff, signal) {
  fetchMeta.textContent = entry.method === 0 ? "Stored (uncompressed) entry" : "Deflated entry — inflating in your browser";
  const t0 = performance.now();
  const chunks = [];
  let got = 0;

  if (entry.method === 0) {
    // stored: fetch in sequential chunks and assemble
    let pos = 0;
    while (pos < entry.compSize) {
      const n = Math.min(CHUNK, entry.compSize - pos);
      const c = await getBytes(dataOff + pos, n, signal.signal);
      chunks.push(c);
      pos += c.byteLength;
      got = pos;
      const frac = got / entry.compSize;
      const speed = got / ((performance.now() - t0) / 1000);
      setProgress(true, frac * 100, `${fmtBytes(got)} / ${fmtBytes(entry.compSize)} · ${fmtBytes(speed)}/s · only this entry, not the whole ZIP`);
    }
  } else if (entry.method === 8) {
    // deflate: fetch compressed chunks, stream-inflate while downloading
    const ds = new DecompressionStream("deflate-raw");
    const writer = ds.writable.getWriter();
    const reader = ds.readable.getReader();
    const readAll = (async () => {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
      }
    })();
    let pos = 0;
    while (pos < entry.compSize) {
      const n = Math.min(CHUNK, entry.compSize - pos);
      const c = await getBytes(dataOff + pos, n, signal.signal);
      await writer.write(c);
      pos += c.byteLength;
      const frac = pos / entry.compSize;
      setProgress(true, frac * 100, `${fmtBytes(pos)} / ${fmtBytes(entry.compSize)} compressed · inflating…`);
    }
    await writer.close();
    await readAll;
    if (chunks.length === 0 || entry.uncompSize === 0) throw new Error("Nothing inflated — ZIP may be encrypted.");
  } else {
    throw new Error("Unsupported ZIP compression method (" + entry.method + "). Only Stored (0) and Deflate (8) work in browsers.");
  }

  const came = chunks.reduce((s, c) => s + c.byteLength, 0);
  const blob = new Blob(chunks, { type: extType(entry.name) || "application/octet-stream" });
  lastObjectURL = URL.createObjectURL(blob);
  player.src = lastObjectURL;
  player.play().catch(() => {});
  const secs = (performance.now() - t0) / 1000;
  setProgress(false);
  setStatus(
    `✅ Played "${entry.name}" after fetching ${fmtBytes(entry.compSize)} in ${secs.toFixed(1)}s` +
    (entry.method !== 0 ? ` (${fmtBytes(came)} after inflate)` : "") +
    ` — the ZIP stayed on the server.`,
    "ok"
  );

  // Add download button for fallback (useful for HEVC/codec issues)
  const dlBtn = document.createElement("button");
  dlBtn.className = "playbtn dl-btn";
  dlBtn.textContent = "⬇ Download entry";
  dlBtn.style.marginLeft = "8px";
  dlBtn.onclick = () => {
    // Create fresh blob from chunks to ensure complete file
    const dlBlob = new Blob(chunks, { type: extType(entry.name) || "application/octet-stream" });
    const dlUrl = URL.createObjectURL(dlBlob);
    const a = document.createElement("a");
    a.href = dlUrl;
    a.download = entry.name;
    a.click();
    // Clean up after a moment
    setTimeout(() => URL.revokeObjectURL(dlUrl), 1000);
  };
  // Insert in fetchMeta area
  const metaEl = fetchMeta;
  if (metaEl && !metaEl.querySelector(".dl-btn")) {
    metaEl.appendChild(document.createTextNode(" "));
    metaEl.appendChild(dlBtn);
  }
}

/* ============================================================
   Zip64 guard for BigInt ops above (kept simple)
   ============================================================ */

/* ============================================================
   Telegram resolver (best-effort via public web preview)
   ============================================================ */
function parseTelegramLink(url) {
  const m = String(url).match(/(?:t\.me|telegram\.me)\/(?:s\/)?([A-Za-z0-9_]{4,})(?:\/(\d+))?/i);
  if (!m) return null;
  return { channel: m[1], post: m[2] ? parseInt(m[2], 10) : null };
}

/** Manual timeout wrapper — reliable even where AbortSignal.timeout is flaky. */
function fetchWithTimeout(url, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timeout after " + ms + "ms")), ms);
    fetch(url).then(
      (r) => { clearTimeout(timer); resolve(r); },
      (e) => { clearTimeout(timer); reject(e); }
    );
  });
}

async function fetchViaProxy(u) {
  const candidates = ["allorigins", "corsproxy.io", "cors.workers.dev", "isomorphic-git"];
  for (const key of candidates) {
    try {
      const r = await fetchWithTimeout(PROXY_BUILDERS[key](u), 15000);
      if (r.ok) return await r.text();
    } catch (e) { /* next */ }
  }
  return null;
}

/** Jina Reader - CORS-friendly page reader that returns markdown. Fastest Telegram path. */
async function fetchViaJina(u) {
  try {
    const r = await fetchWithTimeout("https://r.jina.ai/" + u, 30000);
    if (r.ok) return await r.text();
  } catch (e) { /* fall through */ }
  return null;
}

function parseMarkdownMedia(md) {
  const unescape = (s) => s.replace(/\\_/g, "_").replace(/\\\(/g, "(").replace(/\\\)/g, ")");
  const urls = new Set();
  for (const m of md.matchAll(/!?\[[^\]]*\]\((https?:\/\/[^\s)]+?)\)/g)) urls.add(unescape(m[1]));
  for (const m of md.matchAll(/(?:https?:\/\/cdn[^\s)"']*telesco\.pe\/[^\s)"']+)/g)) urls.add(unescape(m[0]));
  return [...urls];
}

/** Classify media URLs into videos / photos / zips by extension. */
function classifyMedia(urls) {
  const videos = [], photos = [], zips = [];
  for (const u of urls) {
    const ext = u.split("?")[0].split(".").pop().toLowerCase();
    if (ext === "zip") zips.push(u);
    else if (["mp4", "mkv", "webm", "mov", "m4v", "m3u8"].includes(ext)) videos.push(u);
    else if (["jpg", "jpeg", "png", "webp", "gif", "bmp"].includes(ext)) photos.push(u);
    else videos.push(u); // unknown → treat as potential video
  }
  return { videos, photos, zips };
}

function decodeEntities(s) {
  return s.replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
}

/** Bucket a list of media URLs into { videos, photos, zips } by extension. */
function classifyMedia(urls) {
  const videos = [], photos = [], zips = [];
  const seen = new Set();
  for (const raw of urls || []) {
    if (!raw) continue;
    const u = String(raw).trim();
    if (seen.has(u)) continue;
    seen.add(u);
    const clean = u.split(/[?#]/)[0].toLowerCase();
    const ext = (clean.split(".").pop() || "").replace(/[^\w]/g, "");
    if (ext === "zip" || ext === "rar" || ext === "7z") zips.push(u);
    else if (/^(mp4|m4v|mov|webm|mkv|avi|flv|ts|m2ts|3gp)$/.test(ext)) videos.push(u);
    else if (/^(jpe?g|png|gif|webp|avif|bmp|svg)$/.test(ext)) photos.push(u);
    else if (clean.includes("telesco.pe")) photos.push(u); // Telegram CDN media (extension-less preview images)
  }
  return { videos, photos, zips };
}

function escapeHtml(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

const BACKEND = "http://localhost:8787";

/** Try the local MTProto backend first (it can stream real video attachments). */
async function tryBackendResolve(tgUrl) {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 4000);
    const r = await fetch(BACKEND + "/api/resolve?url=" + encodeURIComponent(tgUrl), { signal: ctrl.signal });
    clearTimeout(t);
    if (r.ok) {
      const data = await r.json();
      return data && data.ok ? { status: "ok", data } : { status: "off" };
    }
    // 500 with a "login" message → backend running but not logged in
    const data = await r.json().catch(() => null);
    if (data && /login/i.test(data.error || "")) return { status: "needLogin" };
    return { status: "off" };
  } catch (e) { return { status: "off" }; }
}

function renderBackendResult(info, meta) {
  const dur = meta.duration ? Math.round(meta.duration) + "s · " : "";
  tgBody.innerHTML =
    `<p class="note">Channel: <b>@${escapeHtml(info.channel)}</b>${info.post ? " · post #" + info.post : ""}</p>` +
    `<p class="note">🎬 ${escapeHtml(meta.title)}<br><span class="meta">${dur}${fmtBytes(meta.size)} · ${escapeHtml(meta.mime)}</span></p>` +
    `<div class="row"><button class="ghost" id="backendPlay">▶ Stream video (via local backend)</button></div>` +
    `<p class="note tip">Streaming over MTProto with seeking — only the parts you watch are fetched.</p>`;
  $("backendPlay").addEventListener("click", () => playStreamUrl(BACKEND + meta.stream, meta));
}

function playStreamUrl(url, meta) {
  playerCard.hidden = false;
  playerCard.scrollIntoView({ behavior: "smooth", block: "start" });
  playerTitle.textContent = meta.title || "Telegram video";
  fetchMeta.textContent = "Streaming from Telegram via local backend — seekable";
  revokeLast();
  player.src = "";
  player.onerror = null;
  player.src = url;
  player.play().catch(() => {});
  filesCard.hidden = true;
  tgCard.hidden = true;
  setStatus(`▶ Streaming "${meta.title || "Telegram video"}" — the backend serves only the byte ranges requested.`, "ok");
}

async function handleTelegram(text) {
  const info = parseTelegramLink(text);
  tgCard.hidden = false;
  tgBody.innerHTML = "<p class='note'>Resolving Telegram post…</p>";
  const target = `https://t.me/${info.channel}${info.post ? "/" + info.post : ""}`;
  const embedUrl = target + "?embed=1&mode=tme";

  // path 0: local MTProto backend — can stream actual video attachments (not just photos)
  const backend = await tryBackendResolve(target);
  if (backend.status === "ok" && backend.data.kind === "video") {
    renderBackendResult(info, backend.data);
    return;
  }
  if (backend.status === "ok" && backend.data.kind === "file") {
    const isZip = /\.zip$/i.test(backend.data.title) || /zip/i.test(backend.data.mime || "");
    if (isZip) {
      tgBody.innerHTML =
        `<p class="note">📦 This post is a <b>ZIP archive</b>:</p>` +
        `<p class="note">${escapeHtml(backend.data.title)}<br><span class="meta">${fmtBytes(backend.data.size)}</span></p>` +
        `<div class="row"><button class="ghost" id="openZipBtn">📂 Open archive — list videos inside</button></div>` +
        `<p class="note tip">ZipStream reads the archive index over Range requests and streams one video at a time — no full download.</p>`;
      $("openZipBtn").addEventListener("click", () => {
        urlInput.value = BACKEND + "/api/stream?url=" + encodeURIComponent(target);
        load();
      });
    } else {
      tgBody.innerHTML =
        `<p class="note">📦 This post is a <b>file</b>, not a playable video:</p>` +
        `<p class="note">${escapeHtml(backend.data.title)}<br><span class="meta">${fmtBytes(backend.data.size)} · ${escapeHtml(backend.data.mime)}</span></p>` +
        `<p class="status warn">ZipStream plays <b>videos</b> (or videos inside a .zip). Paste a link to a post that actually contains a video.</p>`;
    }
    return;
  }
  if (backend.status === "needLogin") {
    tgBody.innerHTML =
      `<p class="status warn">Local backend found, but it isn't logged in yet.</p>` +
      `<p class="note">Run <code>npm run login</code> in the <code>backend/</code> folder (needs an api_id/api_hash from my.telegram.org), then try this link again.</p>`;
    return;
  }

  // path 1: jina reader first — CORS-reflecting, usually resolves in <1s, no proxy-outage dependency
  let media = null, channel = null, title = null, reachedTelegram = false;
  const md = await fetchViaJina(embedUrl);
  if (md) {
    reachedTelegram = true;
    channel = info.channel;
    const jMedia = classifyMedia(parseMarkdownMedia(md));
    if (jMedia.videos.length || jMedia.photos.length || jMedia.zips.length) {
      media = { ...jMedia, ogImage: null };
    }
  }

  // path 2: HTML widget via generic proxies — richer data, slower & flakier
  if (!media) {
    const html = await fetchViaProxy(embedUrl);
    if (html) {
      reachedTelegram = true;
      const ogImage = (html.match(/<meta property="og:image" content="([^"]+)"/) || [])[1];
      const telesco = [...new Set([...html.matchAll(/(?:src|href)="(https:\/\/cdn[^"]*telesco\.pe\/file\/[^"]+)"/g)].map((m) => decodeEntities(m[1])))];
      channel = (html.match(/tg:\/\/resolve\?domain=([A-Za-z0-9_]+)/) || [])[1] || info.channel;
      title = (html.match(/<meta property="og:title" content="([^"]*)"/) || [])[1] || null;
      const hMedia = classifyMedia([
        ...telesco,
        ...(ogImage ? [ogImage] : []),
        ...[...new Set([...html.matchAll(/(https?:\/\/[^\s"'<>&]+\.zip)/gi)].map((m) => decodeEntities(m[1])))],
        ...[...new Set([...html.matchAll(/(?:src|href)="(https?:\/\/[^"]+\.(?:mp4|mkv|webm|mov|jpe?g|png))/gi)].map((m) => decodeEntities(m[1])))],
      ]);
      if (hMedia.videos.length || hMedia.photos.length || hMedia.zips.length) {
        media = { ...hMedia, ogImage };
      } else {
        media = { videos: [], photos: [], zips: [], ogImage }; // reached Telegram but nothing visible
      }
    }
  }

  const anyHit = media && (media.videos.length || media.photos.length || media.zips.length || media.ogImage);
  if (!media || !anyHit) {
    tgBody.innerHTML = `<p class="status ${reachedTelegram ? "warn" : "err"}">${
      reachedTelegram
        ? `Reached Telegram, but this post's media is not exposed by Telegram's web preview.\n\nℹ️ <b>Why?</b> Telegram only serves attachment files (videos, big files sent as documents) to the signed-in Telegram client API, not to anonymous web visitors. Photos and caption links are visible; attachments are not.\n\n✅ If the post has a .zip link (Google Drive, Dropbox, GitHub…), paste that here instead — ZipStream streams it directly.`
        : `Couldn't reach Telegram's web preview through any proxy right now (free public CORS proxies are offline/rate-limited — this is temporary, try again in a few minutes).\n\nℹ️ Even when reachable, Telegram never exposes attachment files to anonymous web visitors — videos/documents need the Telegram API with a login.`
    }</p>`;
    return;
  }

  let htmlOut = `<p class="note">Channel: <b>@${channel || info.channel}</b>${info.post ? ` · post #${info.post}` : ""}${title ? ` · ${title}` : ""}</p>`;
  if (media.videos.length) {
    htmlOut += `<p>🎬 Playable media link(s) found:</p>`;
    media.videos.forEach((v, i) => { htmlOut += `<div class="row"><button class="ghost" data-videourl="${v}">▶ Stream video #${i + 1}</button></div>`; });
  }
  if (media.zips.length) {
    htmlOut += `<p>📦 .zip link(s) in the post — open in ZipStream:</p>`;
    media.zips.forEach((z) => { htmlOut += `<div class="row"><button class="ghost" data-zipurl="${z}">📦 ${z}</button></div>`; });
  }
  if (media.photos.length) {
    htmlOut += `<p>🖼️ Photo media from the post:</p><img class="tg-thumb" src="${decodeEntities(media.photos[0])}" alt="Telegram post image">`;
  } else if (media.ogImage) {
    htmlOut += `<p>🖼️ Photo preview (og:image):</p><img class="tg-thumb" src="${decodeEntities(media.ogImage)}" alt="Telegram post image">`;
  }
  if (!media.videos.length && !media.zips.length) {
    htmlOut += `<p class="note tip">ℹ️ This post is a photo, so it displays as an image. Telegram video/document attachments can't be streamed anonymously from the web — they need the Telegram API with a login (bot/user token). A ZIP link in the caption would work: paste it above.</p>`;
  }
  tgBody.innerHTML = htmlOut;
  tgBody.querySelectorAll("[data-videourl]").forEach((b) => b.addEventListener("click", () => { urlInput.value = b.dataset.videourl; playDirect(); }));
  tgBody.querySelectorAll("[data-zipurl]").forEach((b) => b.addEventListener("click", () => { urlInput.value = b.dataset.zipurl; load(); }));
}

/** Quick-player for a direct video URL (no ZIP involved). */
function playDirect() {
  const url = urlInput.value.trim();
  if (!/\.(mp4|mkv|webm|mov|m4v)(\?|$)/i.test(url)) { setStatus("That doesn't look like a direct video file URL.", "err"); return; }
  playerCard.hidden = false;
  playerTitle.textContent = url.split("/").pop();
  fetchMeta.textContent = "Direct video streaming";
  revokeLast();
  player.src = url;
  player.play().catch(() => {});
  filesCard.hidden = true;
  tgCard.hidden = true;
  setStatus("Playing the video directly (streamed with range requests by your browser).", "ok");
}

/* ============================================================
   Main flow
   ============================================================ */
async function load() {
  const url = urlInput.value.trim();
  if (!url) { setStatus("Paste a link first.", "err"); return; }

  filesCard.hidden = true; tgCard.hidden = true; revokeLast(); player.src = "";
  loadBtn.disabled = true;

  try {
    if (parseTelegramLink(url)) {
      await handleTelegram(url);
      return;
    }
    setStatus("Connecting…");
    const signal = new AbortController();
    currentAbort = signal;
    const p = await probe(url, signal.signal);
    if (!p) {
      setStatus(
        "❌ Couldn't find any connection that supports HTTP Range requests for this URL.\n" +
        "The file host must return 206 Partial Content (Google Drive viewer URLs, for example, don't).\n" +
        "Try a different mode in the Connection dropdown, or a direct link to the .zip file (hosts like GitHub raw, Dropbox and most web servers work).",
        "err"
      );
      return;
    }
    conn = { key: p.key, total: null, url };
    setStatus(`Connected via ${p.key === null ? "direct" : p.key}. Measuring file size + reading ZIP index…`);

    const zip = new RemoteZip();
    const entries = await zip.open((f) => setProgress(true, f * 100, `reading ZIP index… ${Math.round(f * 100)}%`));

    filesCard.hidden = false;
    zipNameEl.textContent = url.split("/").pop().split("?")[0] || url;
    zipMetaEl.textContent = `${entries.length} files${conn.total ? ` · ZIP size ${fmtBytes(conn.total)}` : ""}`;
    // sort: playable first
    const sorted = [...entries].sort((a, b) => Number(isPlayable(b.name)) - Number(isPlayable(a.name)));
    renderEntries(sorted);
    setProgress(false);
    setStatus(`✅ Read the ZIP index: ${entries.length} files. Pick a video — only its bytes will be downloaded.`, "ok");
  } catch (e) {
    setProgress(false);
    setStatus("❌ " + e.message, "err");
  } finally {
    loadBtn.disabled = false;
  }
}

function renderEntries(entries) {
  fileListEl.innerHTML = "";
  for (const e of entries) {
    const li = document.createElement("li");
    const name = document.createElement("span");
    name.className = "fname";
    name.textContent = e.name;
    li.appendChild(name);
    const sz = document.createElement("span");
    sz.className = "badge";
    sz.textContent = fmtBytes(e.uncompSize || e.compSize);
    li.appendChild(sz);
    const comp = document.createElement("span");
    comp.className = "badge" + (e.method === 8 ? " deflate" : "");
    comp.textContent = e.method === 0 ? "stored" : e.method === 8 ? "deflated" : "method " + e.method;
    li.appendChild(comp);
    if (isPlayable(e.name)) {
      li.querySelector(".badge").classList.add("playable");
      const btn = document.createElement("button");
      btn.className = "playbtn";
      btn.textContent = "▶ Play";
      btn.addEventListener("click", () => playEntry(e));
      li.appendChild(btn);
    } else {
      const badge = document.createElement("span");
      badge.className = "badge";
      badge.textContent = "not a video";
      li.appendChild(badge);
    }
    fileListEl.appendChild(li);
  }
}

function fmtBytes(n) {
  if (!Number.isFinite(n)) return "?";
  if (n < 1024) return n + " B";
  const u = ["KB", "MB", "GB", "TB"];
  let i = -1;
  do { n /= 1024; i++; } while (n >= 1024 && i < u.length - 1);
  return n.toFixed(n < 10 ? 2 : 1) + " " + u[i];
}

/* ============================================================
   Service Worker — enables true seekable streaming via <video>
   ============================================================ */
const swStateEl = $("swState");
function setSwState(state) {
  if (!swStateEl) return;
  swStateEl.className = "hint" + (state === "on" ? " ok" : state === "off" ? " warn" : "");
  swStateEl.textContent = state === "on"
    ? "Streaming engine: active — videos stream with seeking (only watched bytes are fetched)."
    : state === "pending"
      ? "Streaming engine: starting… open a video again in a moment."
      : state === "off"
        ? "Streaming engine: unavailable — will download one full entry instead."
        : "";
}

async function initSW() {
  if (!("serviceWorker" in navigator)) { setSwState("off"); return; }
  const onControl = () => {
    swReady = !!navigator.serviceWorker.controller;
    setSwState(swReady ? "on" : "pending");
  };
  navigator.serviceWorker.addEventListener("controllerchange", onControl);
  try {
    await navigator.serviceWorker.register("sw.js", { scope: "./" });
  } catch (e) { setSwState("off"); return; }
  onControl();
  if (!swReady) {
    // First visit: the worker installs/activates and calls clients.claim();
    // controllerchange flips swReady as soon as it takes control.
    setTimeout(onControl, 1500);
  }
}

/* ---------------- wiring ---------------- */
loadBtn.addEventListener("click", load);
urlInput.addEventListener("keydown", (e) => { if (e.key === "Enter") load(); });
cancelBtn.addEventListener("click", () => { if (currentAbort) currentAbort.abort(); });
const DEMO_COMMIT = "8006d7bf52b278d8b6342fa91a2ba219f5bd4c0a"; // current HEAD
$("demoBtn1").addEventListener("click", () => { urlInput.value = `https://raw.githubusercontent.com/Sai2-max/zipstream/${DEMO_COMMIT}/demo.zip`; load(); });
$("demoBtn2").addEventListener("click", () => { urlInput.value = `https://raw.githubusercontent.com/Sai2-max/zipstream/${DEMO_COMMIT}/demo2.zip`; load(); });
$("demoTgBtn").addEventListener("click", () => { urlInput.value = "https://t.me/ultimateeditors02/13"; load(); });

initSW();
