# Sendable bot

The working Telegram bot behind the Sendable website. Someone sends an iPhone video and chooses
**Convert to MP4 (same dimensions)**, **High quality (same dimensions)**, **Recommended (720p)**,
**Smaller (480p)**, or **Custom dimensions**. They get a preview with the real before-and-after file
size, and can then download it as a file. The original video is never changed.

**Convert to MP4** is for getting a standard, widely playable MP4 (H.264 video + AAC audio) from an
iPhone's HEVC `.MOV` at the original resolution. Unlike the size options, it is always sent, even when
the MP4 ends up bigger than the original, and its preview says so. Because it is a format change rather
than a size reduction, these copies are **not** saved to the archive channel.

The same server also exposes a small **HTTP API**, so the website's "Convert here" section can upload
a video straight from a phone's gallery, convert it with the identical ffmpeg pipeline, and offer the
smaller file for download — no Telegram account needed. See [Convert from the website](#5-convert-from-the-website-http-api).

It's built with [grammY](https://grammy.dev) and uses ffmpeg (H.264 + AAC MP4, `+faststart`) to make
the copy. The high-quality option keeps the source resolution and uses a quality-biased encode, but
no re-encode can guarantee an identical picture or a smaller file. If a setting does not reduce the
file, the bot will not send or archive a larger copy. The 720p/480p options reduce resolution and may
soften detail. Videos are never stretched or upscaled, iPhone rotation is respected, and metadata such
as GPS location is removed from the copy.

> **Prefer one Vercel project with no server to run?** The same bot, sign-in check and website converter
> also run as Vercel Functions. See [Option A in DEPLOY.md](../DEPLOY.md#option-a-deploy-everything-to-vercel).
> This folder is the always-on server version (no per-video time limit, `/cancel`, and the MP4 bot).

## 1. Create your bot

1. In Telegram, open [@BotFather](https://t.me/BotFather) and send `/newbot`.
2. Pick a display name, then a username that ends in `bot` (for example `MyVideoBot`).
3. BotFather replies with a **token** like `123456789:AA…`. Treat it like a password and never commit it.

## 2. Run it

You need Node.js 22+ and ffmpeg (`brew install ffmpeg`, `sudo apt install ffmpeg`, or
`winget install ffmpeg`).

```bash
cd bot
cp .env.example .env        # then paste your token into TELEGRAM_BOT_TOKEN
npm install
npm run build
npm start
```

You should see:

```
Using ffmpeg version 7.x
Connected to Telegram as @MyVideoBot (https://t.me/MyVideoBot)
Web conversion API on /api: up to 200 MB, 2 at a time, results kept 60 min
Health check on port 8080
Polling mode: listening for messages. Press Ctrl+C to stop.
```

Only want the website's converter, with no Telegram bot? Leave `TELEGRAM_BOT_TOKEN` empty and set
`WEB_ONLY=true`; the server then serves the HTTP API alone.

Open the link and send it a video. For development, `npm run dev` restarts the bot when you change a file.

### With Docker

```bash
docker build -t sendable-bot bot
docker run --env-file bot/.env -p 8080:8080 sendable-bot
```

The image installs ffmpeg for you.

## Optional: use a Telegram channel as a video archive

The bot can keep each successfully reduced output in your Telegram channel and uses the archived
message as the persistent download source. This survives bot restarts and leaves a searchable record
in the video's caption. It archives **only the smaller converted copy**; original uploads, the
**Convert to MP4** copies, and conversions that did not reduce the file are not stored there.

1. Create a **private** Telegram channel for the archive.
2. Add your bot to the channel as an administrator with permission to post messages.
3. Set `TELEGRAM_ARCHIVE_CHAT_ID` in `bot/.env` (or your host's environment variables) to the
   channel's numeric ID, usually starting with `-100`:

   ```bash
   TELEGRAM_ARCHIVE_CHAT_ID=-1001234567890
   ```

4. Restart the bot. It checks that the destination is a channel and that it can post there. Public
   channels are rejected by default. Set `TELEGRAM_ARCHIVE_ALLOW_PUBLIC=true` only if you explicitly
   intend to make archived user videos public.

When archive mode is enabled, the bot tells people before conversion that the finished copy will be
saved and that anyone with access to the channel may view it. Archive posts remain until a channel
admin deletes them. Use a private channel with only trusted admins/members. A Telegram channel is an
append-only media archive, **not** a relational database; it is best suited to storing outputs and
simple caption metadata, not private user profiles or searchable application records.

Leave `TELEGRAM_ARCHIVE_CHAT_ID` empty to keep the existing temporary-file-only behavior.

## 3. Connect the website

On the website, open the **Connect** section and enter your bot's username. Every "Open in
Telegram" button then opens your bot. The choice is saved in that browser. You can also:

- link to the site with `?bot=MyVideoBot` to preselect a bot, or
- make it the default for everyone by building the site with
  `VITE_TELEGRAM_BOT_USERNAME=MyVideoBot npm run build` (or by setting it in Vercel's environment variables).

The website only ever needs the public username. The token stays on the bot server.

## 4. Sign-in on the website (Telegram Login Widget)

The Connect section also has a **"Sign in with Telegram"** button — Telegram's official
[Login Widget](https://core.telegram.org/widgets/login) — so visitors can link their Telegram
account to the site with one tap. It works like this:

1. The visitor taps the button and confirms in Telegram. The widget hands the browser a signed
   payload: `id`, `first_name`, `last_name`, `username`, `photo_url`, `auth_date` and a `hash`.
2. The site POSTs that payload to **`POST /telegram/login`** on this bot server.
3. The server proves it really came from Telegram (HMAC-SHA-256 of the data-check-string, keyed
   with `SHA256(token)` — the official algorithm), rejects stale payloads, and answers
   `{ok: true, user: {...}}`. With `LOGIN_GREETING=true` (default) the bot also sends the visitor
   a short "you signed in on the website" message in Telegram.
4. The site shows a signed-in card and links back into the chat with `?start=web-<id>`, which this
   bot answers with a "Connected!" welcome.

The token never leaves this server, and the site never trusts the payload until the server
verifies it.

### One-time setup

1. **Link the site's domain to your bot.** In Telegram, send `/setdomain` to
   [@BotFather](https://t.me/BotFather), pick your bot, and enter the domain the site runs on
   (for example `sendable.vercel.app`). Telegram only shows the login button on that exact
   domain — without this step the widget refuses to work.
2. **Tell the site where this server is.** Enter the address in the Connect section's
   "Your bot's server address" field (saved per browser), or build the site with
   `VITE_BOT_API_URL=https://your-bot.example.com npm run build`. The site calls
   `VITE_BOT_API_URL + /telegram/login`.
3. **Allow the site's origin (recommended).** `CORS_ORIGIN` defaults to `*`, which already works.
   To tighten it, list your origins: `CORS_ORIGIN=https://sendable.vercel.app,https://staging.example`.

By default the widget asks for "write" access (`VITE_TELEGRAM_REQUEST_ACCESS=write` on the site),
which is what lets the bot send the greeting to people who haven't started a chat yet. Build the
site with `VITE_TELEGRAM_REQUEST_ACCESS=read` (or any non-`write` value) to ask for the profile
only — the greeting then works only for people who have pressed Start on the bot.

> Local note: Telegram compares the page's domain with the one you set via `/setdomain`, so the
> widget only works on that domain. Test it on your deployed site (or a tunnel/preview domain you
> registered with BotFather), not on `localhost`. Everything else — including
> `POST /telegram/login` — works locally.

## 5. Convert from the website (HTTP API)

The website's **Convert here** section is a real converter, not a mock-up: it uploads the video you
pick from your gallery, this server converts it with ffmpeg, and the page shows the actual
before-and-after file size with the finished MP4 to play and save.

| Method and path | What it does |
| --- | --- |
| `GET /api/config` | Presets and limits, so the UI matches the server |
| `POST /api/convert` | Multipart upload (`video` file + `preset=smaller`, or `width`/`height`); returns a job |
| `GET /api/jobs/:id` | Job state, progress, and the real source and output sizes |
| `GET /api/jobs/:id/download` | The converted MP4 (`?inline=1` to play it; supports `Range` so the player can seek) |
| `DELETE /api/jobs/:id` | Cancel a running job and delete its files |

From a terminal:

```bash
curl -F "video=@holiday.MOV" -F "preset=smaller" http://localhost:8080/api/convert
# {"ok":true,"job":{"id":"8f0c...","state":"queued",...}}

curl http://localhost:8080/api/jobs/8f0c...
# {"ok":true,"job":{"state":"done","progress":1,
#   "source":{"bytes":10393514,"width":1920,"height":1080},
#   "output":{"name":"holiday_480p.mp4","bytes":286698,"width":854,"height":480,"smaller":true,...}}}

curl -OJ http://localhost:8080/api/jobs/8f0c.../download
```

Uploads stream straight to a temporary directory, so memory use doesn't grow with the video size.
Each job keeps its own folder, which is deleted when the job is cancelled, `WEB_JOB_TTL_MINUTES`
after it finishes, and on shutdown. Conversions share the bot's `MAX_CONCURRENT_JOBS` limit; anything
extra waits in line. Metadata such as GPS is stripped from the copy, videos are never stretched or
upscaled, and — as in Telegram — the original is never touched.

**Pointing the website at it.** The site calls `VITE_BOT_API_URL + /api/...`, or the address entered in
the Connect section. In development the Vite dev server proxies `/api` to `http://127.0.0.1:8080` (or
`BOT_API_PORT`), so running the bot and `npm run dev` side by side just works:

```bash
cd bot && WEB_ONLY=true npm run dev   # terminal 1
npm run dev                           # terminal 2, opens the site with a working converter
```

Because this is a plain HTTP upload, `WEB_MAX_UPLOAD_MB` (default 200) is not tied to Telegram's
20 MB bot limit — only to your host's disk and your users' patience. Set `WEB_API_KEY` if you want to
require a shared secret; note that a browser can only send it if you bake it into the site with
`VITE_BOT_API_KEY`, which makes it public, so it deters abuse rather than hiding anything.

## 6. MP4 converter bot (a second, separate bot)

The repository also has a **MP4 converter bot**. It does one thing: someone sends it a video and it
sends back a standard **MP4** (H.264 video + AAC audio). It accepts almost any format, including
MOV, MKV, WebM, AVI, 3GP, MTS, WMV, and FLV, plus GIF-style animations and round video notes. The
resolution stays the same, iPhone rotation is applied so the video plays upright, and location
metadata is removed. The original file is never changed.

It is a separate Telegram bot with its own token, so it runs next to the Sendable bot without
interfering with it. It uses the same ffmpeg pipeline and the same "Convert to MP4 (same dimensions)"
settings as Sendable.

### Set it up

1. In [@BotFather](https://t.me/BotFather), send `/newbot` again to create a **second** bot (for
   example `MyMp4Bot`), and copy its token.
2. Put the token in `bot/.env`:

   ```bash
   MP4_BOT_TOKEN=987654321:BB…
   ```

3. Run it (it uses the same ffmpeg, Node.js and `.env` as the Sendable bot):

   ```bash
   cd bot
   npm install
   npm run build
   npm run start:mp4
   ```

   You should see `MP4 converter connected to Telegram as @MyMp4Bot`, then
   `Polling mode: listening for videos`. For development, `npm run dev:mp4` restarts it when you change a file.

To run it in Docker, use the same image with a different command:

```bash
docker build -t sendable-bot bot
docker run --env-file bot/.env sendable-bot node dist/mp4-index.js
```

### Limits and behavior

- **Input**: up to `MP4_MAX_UPLOAD_MB` (default `20`, Telegram's download limit for bots). For larger
  videos, run a self-hosted Bot API server and set `TELEGRAM_API_ROOT` (see
  [About the 20 MB limit](#about-the-20-mb-limit)).
- **Output**: the MP4 is sent back as a video, so it must be under Telegram's 50 MB upload limit for
  bots. A longer or higher-bitrate video can produce a bigger MP4 than that. The bot then says so and
  sends nothing.
- **One conversion per chat**: a second video waits until the first one finishes. `/cancel` stops it.
  At most `MP4_MAX_CONCURRENT_JOBS` (default `2`) conversions run at once across all chats.
- **Storage**: each video is handled in a temporary folder that is deleted when the conversion
  finishes or is cancelled. Nothing is archived, and the MP4 bot does not use the Telegram archive channel.
- **Commands**: `/start`, `/help`, `/cancel`.

Because re-encoding can change detail slightly, check the MP4 before you rely on it. The MP4 bot is
polling-only and needs no public address.

## Polling or webhook?

- **Polling** (default, when `WEBHOOK_URL` is empty): the bot asks Telegram for new messages. It works
  anywhere, including a laptop, a VPS, Railway, Fly.io, or a Render background worker. No public URL is needed.
- **Webhook**: set `WEBHOOK_URL=https://your-bot.example.com` (and ideally `WEBHOOK_SECRET`).
  Telegram then POSTs updates to `WEBHOOK_URL + WEBHOOK_PATH` (default `/telegram/webhook`). Use this
  on hosts that sleep when idle or only run web services.

Either way, `GET /health` on `PORT` returns `{"ok":true,"bot":"MyVideoBot",...}` for your host's health checks, and `POST /telegram/login` on the same port verifies website sign-ins (below).

The bot isn't a good fit for Vercel serverless functions. Converting a video takes longer than
those functions are allowed to run, and the bot keeps each chat's state in memory. Deploy the website
to Vercel and run the bot on a host that keeps a process running.

## Settings

All settings are environment variables. See [`.env.example`](.env.example).

| Variable | Default | What it does |
| --- | --- | --- |
| `TELEGRAM_BOT_TOKEN` | (required) | Token from @BotFather |
| `MAX_UPLOAD_MB` | `20` | Largest video accepted |
| `ALLOW_CUSTOM` | `true` | Show the "Custom dimensions" option |
| `MAX_DIMENSION` | `3840` | Largest custom width or height, in pixels |
| `MAX_CONCURRENT_JOBS` | `2` | Videos converted at the same time; others wait in line |
| `FFMPEG_PATH` | auto | ffmpeg binary (ffmpeg-static if it installed, otherwise `ffmpeg` on PATH) |
| `TELEGRAM_API_ROOT` | `https://api.telegram.org` | Point at a self-hosted Bot API server |
| `TELEGRAM_ARCHIVE_CHAT_ID` | (empty) | Optional channel ID; stores successfully reduced outputs as searchable archive posts |
| `TELEGRAM_ARCHIVE_ALLOW_PUBLIC` | `false` | Explicitly allow a public archive channel (not recommended) |
| `WEBHOOK_URL` / `WEBHOOK_PATH` / `WEBHOOK_SECRET` | (empty) | Turn on webhook mode |
| `PORT` | `8080` | Health check and webhook port |
| `CORS_ORIGIN` | `*` | Website origins allowed to call `POST /telegram/login` (`*`, or a comma-separated list like `https://a.com,https://b.com`) |
| `LOGIN_MAX_AGE_SECONDS` | `86400` | How long a website sign-in payload stays acceptable |
| `LOGIN_GREETING` | `true` | Message the user in Telegram after a verified website sign-in |
| `WEB_ONLY` | `false` | Run the HTTP server only, with no Telegram bot (token may stay empty) |
| `WEB_CONVERT` | `true` | Serve the website's conversion API on `/api` |
| `WEB_MAX_UPLOAD_MB` | `200` | Largest video the website may upload |
| `WEB_JOB_TTL_MINUTES` | `60` | How long a finished conversion stays downloadable |
| `WEB_API_KEY` | (empty) | Optional shared secret for every `/api` request |
| `MP4_BOT_TOKEN` | (required for the MP4 bot) | Token of the second bot that converts videos to MP4 (`npm run start:mp4`) |
| `MP4_MAX_UPLOAD_MB` | `20` | Largest video the MP4 bot accepts |
| `MP4_MAX_CONCURRENT_JOBS` | `2` | Conversions the MP4 bot runs at once, across all chats |

### About the 20 MB limit

Telegram's hosted Bot API only lets bots **download files up to 20 MB** and **send files up to
50 MB**. Most iPhone videos longer than about 10 seconds are bigger than that. To accept large videos
(up to 2000 MB), run the official [telegram-bot-api](https://github.com/tdlib/telegram-bot-api) server
in `--local` mode next to the bot. Then set:

```
TELEGRAM_API_ROOT=http://localhost:8081
MAX_UPLOAD_MB=2000
```

If you set `MAX_UPLOAD_MB` higher than the API allows, the bot refuses to start and tells you why.
That's better than failing on someone's upload.

## Commands

- `/start`: welcome message and the current size limit
- `/help`: how it works, the limits, and the commands
- `/cancel`: stop the current conversion (the original is untouched)

## Tests

```bash
npm test
```

The MP4 bot's tests run a real conversion (MKV in, H.264/AAC MP4 out, odd dimensions rounded to even)
and drive the bot through a local stand-in for the Telegram Bot API: a video in, an MP4 out, plus
refusals, failures and `/cancel`.

These cover the size parsing, archive target checks, and real conversions with ffmpeg. They check
the output dimensions for portrait, landscape, custom and no-upscale cases, and that cancelling works.
They also cover the HTTP side: the streaming multipart reader (boundaries split across chunks, size
caps) and the conversion API end to end — upload, progress, real before-and-after sizes, ranged
download, custom dimensions, cancellation, size limits and the optional API key.

## Privacy

By default, videos are downloaded to a temporary folder only while they are being converted. A
finished preview is kept so the "Download this version" button can send it; it is deleted when the
person sends another video, picks a new size, or after 6 hours of inactivity. Nothing is written
anywhere else.

Videos uploaded through the website's converter are handled the same way: they are written to a
temporary folder only while the job runs, the finished copy stays downloadable for
`WEB_JOB_TTL_MINUTES`, and then the whole folder is deleted. Nothing is archived unless you configure
the Telegram channel below.

If `TELEGRAM_ARCHIVE_CHAT_ID` is configured, only a smaller completed output is posted to that
channel. The input and temporary files are still removed as above. The archive copy persists until a
channel admin deletes it, and is visible to that channel's members/admins (or the public if the
explicit public-channel override is enabled). The bot displays this before a user creates a preview.
