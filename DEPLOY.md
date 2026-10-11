# Deploy on Vercel

This repository can run as a Vercel project with Node.js Functions. It contains the API and bot
backend, not the gallery website itself; point the website at this project's deployment, or add the
website as a separate Vercel project.

## 1. Import and deploy

1. Import this GitHub repository in Vercel. Use the repository root as the **Root Directory** and
   the **Other** framework preset. `package.json` requests Node.js 22 or newer.
2. Create a Vercel Blob store and connect it to this project. Vercel supplies
   `BLOB_READ_WRITE_TOKEN` to the deployment. Keep the store private and dedicated to this app if
   possible.
3. Add the environment variables below in Vercel's Project Settings, then redeploy. The `vercel-build`
   script type-checks the API functions; `vercel.json` defines the routes, rewrites, cleanup cron, and
   the ffmpeg binary bundle.
4. Open `https://YOUR-DOMAIN/health`. It should return JSON with `"mode":"vercel"`. The converter
   reports a missing Blob store until `BLOB_READ_WRITE_TOKEN` is configured.

The configured Function duration is 60 seconds; confirm your Vercel plan allows that limit. The
converter stops at 50 seconds to leave time to upload the result. Longer videos can exceed that limit;
on a plan that permits longer Functions, raise the `maxDuration` values in `vercel.json` and set
`WEB_MAX_SECONDS` lower than that limit, then redeploy.

## 2. Environment variables

| Variable | Default | Purpose |
| --- | --- | --- |
| `BLOB_READ_WRITE_TOKEN` | Set by connected Blob store | Stores private uploads and outputs; required for the website converter. |
| `WEB_MAX_UPLOAD_MB` | `100` | Maximum website upload. Direct-to-Blob upload bypasses the Function request-body limit; conversion still uses temporary disk and function time. |
| `WEB_MAX_OUTPUT_MB` | `100` | Maximum converted output size. |
| `WEB_MAX_SECONDS` | `50` | Converter's internal deadline, in seconds; keep below the route's `maxDuration`. |
| `WEB_JOB_TTL_MINUTES` | `60` | How long signed download links remain valid and when old Blob files are removed. |
| `ALLOW_CUSTOM` | `true` | Allow custom dimensions. |
| `MAX_DIMENSION` | `3840` | Largest custom width or height. |
| `WEB_CONVERT` | `true` | Turn the website converter on or off. |
| `WEB_API_KEY` | empty | Optional API key for config/upload/convert/login calls. The browser must send `X-Api-Key`; this is public if embedded in frontend code. |
| `CORS_ORIGIN` | `*` | Browser origins allowed to call the API. Prefer a comma-separated list of exact origins in production. |
| `CRON_SECRET` | — | Required by `/api/cleanup`; Vercel Cron sends `Authorization: Bearer <CRON_SECRET>`. |
| `TELEGRAM_BOT_TOKEN` | — | Optional. Enables Telegram sign-in and the Vercel webhook bot. |
| `PUBLIC_URL` | Vercel production URL | Canonical HTTPS origin for the Telegram webhook, e.g. `https://sendable.example.com`. Set explicitly if a custom domain is used. |
| `TELEGRAM_WEBHOOK_SECRET` | — | Required to receive Telegram webhook updates. Use a random 1–256 character value containing letters, digits, `_` or `-`. |
| `TELEGRAM_SETUP_SECRET` | — | Required to register the Telegram webhook through `/api/telegram/setup`. |
| `LOGIN_GREETING` | `true` | Send an optional Telegram message after a verified website sign-in. |
| `LOGIN_MAX_AGE_SECONDS` | `86400` | Maximum age of a Telegram Login Widget payload. |
| `DOWNLOAD_SIGNING_SECRET` | Blob token | Optional separate secret used to sign short-lived private download links. |

Never commit actual tokens or secrets. `.env.example` lists the local and Vercel settings.

## 3. Connect a website converter

The Vercel upload route issues a short-lived upload token; the browser sends the video directly to
Vercel Blob. This avoids Vercel's request-body cap on Functions. The function then downloads the
private Blob to its temporary directory, converts it with bundled FFmpeg, stores a private result,
and streams progress as newline-delimited JSON (NDJSON).

The website needs `@vercel/blob` and can use this flow:

```ts
import { upload } from "@vercel/blob/client";

const blob = await upload(`sendable/uploads/${file.name}`, file, {
  access: "private",
  handleUploadUrl: `${API_ORIGIN}/api/upload`,
  multipart: true,
  contentType: file.type || "video/quicktime",
  // Add this only when WEB_API_KEY is configured:
  // headers: { "x-api-key": WEB_API_KEY },
});

const response = await fetch(`${API_ORIGIN}/api/convert`, {
  method: "POST",
  headers: {
    "content-type": "application/json",
    // Add this only when WEB_API_KEY is configured:
    // "x-api-key": WEB_API_KEY,
  },
  body: JSON.stringify({ url: blob.url, name: file.name, preset: "smaller" }),
});

if (!response.ok || !response.body) throw new Error("Conversion could not start");
const reader = response.body.getReader();
const decoder = new TextDecoder();
let pending = "";
for (;;) {
  const { value, done } = await reader.read();
  pending += decoder.decode(value, { stream: !done });
  const lines = pending.split("\n");
  pending = lines.pop() ?? "";
  for (const line of lines) {
    if (!line) continue;
    const event = JSON.parse(line);
    if (event.type === "progress") updateProgress(event.stage, event.progress);
    if (event.type === "error") throw new Error(event.error.message);
    if (event.type === "complete") {
      const playableUrl = new URL(event.job.url, API_ORIGIN).toString();
      const saveUrl = new URL(event.job.downloadUrl, API_ORIGIN).toString();
      // Use playableUrl in a <video>; use saveUrl for a download link.
    }
  }
  if (done) break;
}
```

The upload pathname must begin with `sendable/uploads/`. Accepted files are MOV, MP4, M4V, WebM,
and Matroska; uploaded files and outputs are private. The `complete` event contains source/output
sizes, dimensions, a short-lived root `/download?token=...` URL, and a separate `&inline=1` URL for
video playback. The download route supports byte ranges and sets a no-referrer policy. Uploads are
deleted after conversion, and old outputs/abandoned uploads are removed by the daily cron.

API routes:

- `GET /api/config` — presets and configured limits.
- `POST /api/upload` — Vercel Blob client-upload token exchange.
- `POST /api/convert` — JSON `{url, name, preset}` or `{url, name, width, height}`; returns progress and a final result as NDJSON.
- `GET /download?token=...` — root-level signed private output route (rewritten internally to `/api/download`); `&inline=1` displays it in a player. Supports `Range` and `HEAD`.
- `GET /api/health` (also `/health` and `/`) — deployment status.

## 4. Optional Telegram webhook and website sign-in

The Vercel deployment also has Telegram Login Widget verification and a webhook endpoint. Configure
`TELEGRAM_BOT_TOKEN`, `PUBLIC_URL` (the backend's canonical HTTPS domain), and
`TELEGRAM_WEBHOOK_SECRET`. Set the **website's** hostname—not necessarily the backend hostname—with
`/setdomain` in @BotFather for the Login Widget. After deployment, register the webhook once:

```bash
curl -X POST \
  -H "Authorization: Bearer $TELEGRAM_SETUP_SECRET" \
  https://YOUR-DOMAIN/api/telegram/setup
```

`TELEGRAM_SETUP_SECRET` must be set before registration. `GET /api/telegram/setup` checks the current
registration. The Vercel webhook responds immediately and continues updates with `waitUntil`; it
supports preset-based video conversion, but not the always-on bot's in-memory chat sessions, custom
sizes, `/cancel`, or channel archive. Telegram's hosted Bot API caps bot downloads at 20 MB and sends
at 50 MB. For the complete bot workflow or long videos, run `npm start` on an always-on host instead.

The website sign-in endpoint is `POST /telegram/login` (rewritten to `/api/telegram/login`). It
verifies the Login Widget signature server-side. If `WEB_API_KEY` is set, include it on the sign-in
request too. Configure `CORS_ORIGIN` to the website's origin when frontend and API use different
Vercel projects.

## 5. Local verification

```bash
npm ci
npm run typecheck
npm test
npm run build
```

For local development on Linux x64 the repository includes a compatible FFmpeg executable. On macOS
or Windows, install FFmpeg and put it on `PATH` or set `FFMPEG_PATH`.
