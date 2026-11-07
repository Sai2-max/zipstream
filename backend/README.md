# ZipStream backend — stream Telegram videos (MTProto)

A tiny local Node service that resolves a `t.me/channel/123` link and streams the
post's video with HTTP **Range** support, so the browser `<video>` can play it with
instant seeking — without downloading the whole file first.

It logs in as a **user account** (MTProto via [gram.js](https://github.com/gram-js/gramjs)),
because the Bot API cannot fetch historical channel posts.

## Setup (first time)

```bash
cd backend
npm install        # installs `telegram` (gram.js) + `big-integer`
npm run login      # interactive: enter api_id, api_hash, phone, and the login code
```

`npm run login` needs:
1. An **api_id + api_hash** from https://my.telegram.org → "API development tools".
2. Your **phone number** (any Telegram account) and the login code Telegram sends.

This writes a `backend/.env` file containing your session string. **Never commit `.env`
or share it** — it lets anyone use your account.

## Run

```bash
npm start
# ZipStream backend → http://127.0.0.1:8787
```

## Endpoints

| Endpoint | Description |
| --- | --- |
| `GET /health` | `{ ok, authorized }` — the frontend uses this to detect the backend |
| `GET /api/resolve?url=https://t.me/channel/123` | Resolves the post → `{ ok, kind, title, mime, size, duration, width, height, stream }` |
| `GET /api/stream?url=https://t.me/channel/123` | Streams the video; supports `Range: bytes=X-Y` → `206 Partial Content` |

## Notes / limits

- A resolved post is cached in memory for 10 minutes (Telegram file references expire).
- Only works for posts the account can read: **public** channels/groups, or private
  chats the account is a member of.
- Automation of a personal account is against some of Telegram's terms in bulk/abusive
  use — fine for personal, small-scale streaming.
- Streaming seeks far into a video fetches from that offset over MTProto (no full
  download), same as the ZIP streaming path.
