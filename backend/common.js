/* Shared helpers for the ZipStream Telegram backend. */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions/index.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ENV_PATH = path.join(__dirname, ".env");

/** Read a KEY=VALUE .env file (no dependency needed). */
export function loadEnv() {
  const out = {};
  try {
    const txt = fs.readFileSync(ENV_PATH, "utf8");
    for (const line of txt.split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
      if (m) out[m[1]] = m[2];
    }
  } catch (e) { /* no .env yet */ }
  return out;
}

/** Merge pairs into the .env file (never logs values). */
export function saveEnv(pairs) {
  const env = { ...loadEnv(), ...pairs };
  const lines = Object.entries(env).map(([k, v]) => `${k}=${v}`);
  fs.writeFileSync(ENV_PATH, lines.join("\n") + "\n", "utf8");
}

/** Build a Telegram client from env (no connect yet). */
export function createClient(env) {
  const apiId = Number(env.TG_API_ID);
  const apiHash = env.TG_API_HASH || "";
  if (!apiId || !apiHash) {
    throw new Error("Missing TG_API_ID / TG_API_HASH. Run `npm run login` first.");
  }
  return new TelegramClient(
    new StringSession(env.TG_SESSION || ""),
    apiId,
    apiHash,
    { connectionRetries: 5 },
  );
}

/** Parse t.me/channel/123 → { channel, post }. */
export function parseTgUrl(url) {
  const m = String(url).match(/t\.me\/([A-Za-z0-9_]{4,})(?:\/(\d+))?/);
  if (!m) throw new Error("Expected a t.me/channel/123 link.");
  return { channel: m[1], post: m[2] ? Number(m[2]) : null };
}

/**
 * Resolve a t.me post to its video/document media.
 * Returns metadata plus the raw `message` (kept for streaming via iterDownload).
 */
export async function resolveMedia(client, url) {
  const { channel, post } = parseTgUrl(url);
  if (post == null) throw new Error("Need a specific post: t.me/channel/123");

  const entity = await client.getEntity(channel);
  const messages = await client.getMessages(entity, { ids: [post] });
  const msg = messages[0];
  if (!msg) throw new Error("Post not found (deleted, private, or wrong link).");

  const media = msg.media;
  if (!media) throw new Error("This post has no media.");

  const doc = media.document;
  if (doc && doc.className === "Document") {
    let title = `${channel}_${post}`;
    let duration = 0, width = 0, height = 0, isVideo = false;
    for (const attr of doc.attributes || []) {
      if (attr.className === "DocumentAttributeFilename" && attr.fileName) title = attr.fileName;
      if (attr.className === "DocumentAttributeVideo") {
        isVideo = true;
        duration = attr.duration || 0;
        width = attr.w || 0;
        height = attr.h || 0;
      }
    }
    const size = doc.size && doc.size.toJSNumber ? doc.size.toJSNumber() : Number(doc.size);
    return {
      kind: isVideo ? "video" : "file",
      isVideo,
      title,
      mime: doc.mimeType || "application/octet-stream",
      size,
      duration,
      width,
      height,
      message: msg,
      media,
    };
  }

  if (media.photo) {
    return { kind: "photo", title: `${channel}_${post}`, message: msg, media, size: 0, mime: "image/jpeg" };
  }

  throw new Error("This post's media is not a downloadable file.");
}
