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
                     →  [if deflated] inflate-raw streaming in browser
                     →  Blob URL → <video>
```
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

## Test locally
Open the live app and click a demo button (demo zips are hosted in this repo, powered by GitHub raw).
