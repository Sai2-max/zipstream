# ⚡ ZipStream

**Play a video straight out of a hosted ZIP file — without downloading the whole ZIP.**

Paste a link (or a `t.me` Telegram post link), ZipStream reads the ZIP's central directory over
HTTP Range requests, lists the files inside, and downloads **only the byte-span of the file you
pick**. Deflated entries are re-inflated on the fly with the browser's `DecompressionStream`.

## Live app
👉 https://sai2-max.github.io/zipstream/

## Why
10 GB ZIP of videos on a server. You want one video. ZipStream ≈ downloads ~the size of that one video.

## How it works
```
GET Range bytes=X-Y  →  read End-Of-Central-Directory (file tail)
                     →  read Central Directory (ZIP index)
                     →  locate entry → GET Range for that entry's local header + data
                     →  [stored]    <video> streams only the ranges it watches (Service Worker maps ranges → ZIP offsets)
                     →  [deflated]  inflate-raw streaming in a Service Worker → progressive playback
```

### True streaming via a Service Worker
`sw.js` exposes each entry as a same-origin **virtual file URL** (`/__zip__/<source>/<entry>`).
When you press Play the `<video>` element itself issues Range requests, and the worker answers
each one by fetching only that byte span from the remote ZIP:

- **Stored (method 0) entries** — 1:1 offset mapping. Instant start, instant seeking, and you
  only ever download the bytes you actually watch. This is the format to prefer for videos.
- **Deflated (method 8) entries** — re-inflated on the fly with `DecompressionStream` and served
  progressively. A deflate stream has no random access, so seeking far ahead inflates the prefix
  up to that point (and holds it in worker memory).

If the Service Worker isn't ready (first visit, or a browser without SW / `DecompressionStream`),
the app falls back to downloading the single entry into a Blob — the previous behaviour.

- Supports **Stored (method 0)** and **Deflate (method 8)** entries, and **ZIP64**.
- CORS fallback chain: direct → corsproxy.io → allorigins → cors.workers.dev → isomorphic-git.
- 100% client-side. No server, no upload of your data.

## Limits
- The host must answer HTTP **206 Partial Content** (GitHub raw, Dropbox, most CDNs/hosts do).
- Google Drive *viewer* links don't support ranges — use a direct link.
- Telegram: the public web preview only exposes photos / caption links. Media files (videos,
  big zips sent as documents) require the Telegram client API (bot/user token), so a pure browser
  app can't stream them anonymously — the UI explains this when you paste a t.me link.
- Browsers can't decode every codec (no AV1/HEVC guarantee); MP4/H.264 and WebM play best.
- Deflated entries inflate into Service Worker memory; a very large deflated video can use a lot of RAM.
  For best streaming (instant seek, minimal memory), store videos **uncompressed** (`zip -0` or "Store" method).

## Stream Telegram videos (optional local backend)

The browser app can't stream Telegram *video* attachments anonymously (Telegram only exposes
photos and caption links to the public web preview). To stream real Telegram videos — past or
future, like `t.me/channel/123` — run the tiny local backend in [`backend/`](backend/), which
logs in as a user account over MTProto and serves any post's video with HTTP Range support:

```bash
cd backend
npm install
npm run login   # api_id + api_hash from my.telegram.org, then your phone + login code
npm start       # http://127.0.0.1:8787
```

When the backend is running, pasting a `t.me` link automatically streams the video (with seeking)
through it; if it's offline the app falls back to the public web preview. See [`backend/README.md`](backend/README.md).

## Test locally
Open the live app and click a demo button (demo zips are hosted in this repo, powered by GitHub raw).
