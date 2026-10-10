import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { AddressInfo } from "node:net";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import type { Mp4BotConfig } from "./config.js";
import { buildArgs, probeVideo, resizeVideo, resolveFfmpeg } from "./ffmpeg.js";
import { createMp4Bot, isVideoFileName, isVideoMime, mp4Choice, mp4FileName, mp4Messages } from "./mp4-bot.js";

const ffmpeg = process.env.FFMPEG_PATH || resolveFfmpeg();
const hasFfmpeg = spawnSync(ffmpeg, ["-version"]).status === 0;
const skipReason = hasFfmpeg ? false : ("ffmpeg not found" as const);

test("recognizes video files by name and MIME type", () => {
  for (const name of ["IMG_0001.MOV", "clip.mp4", "a.m4v", "movie.mkv", "x.WEBM", "old.avi", "cam.3gp", "rec.MTS"]) {
    assert.ok(isVideoFileName(name), name);
  }
  for (const name of ["photo.jpg", "notes.pdf", "song.mp3", "README", "clip.mp4.zip"]) {
    assert.ok(!isVideoFileName(name), name);
  }
  assert.ok(isVideoMime("video/x-matroska"));
  assert.ok(isVideoMime("Video/MP4"));
  assert.ok(!isVideoMime("application/octet-stream"));
  assert.ok(!isVideoMime(undefined));
});

test("output names end in .mp4 and are made safe", () => {
  assert.equal(mp4FileName("IMG_0001.MOV"), "IMG_0001.mp4");
  assert.equal(mp4FileName("holiday.final.mkv"), "holiday.final.mp4");
  assert.equal(mp4FileName("../../etc/we<ird>.avi"), "we_ird_.mp4");
  assert.equal(mp4FileName(""), "video.mp4");
});

test("the conversion keeps the resolution and uses H.264 with CRF 20 and no metadata", () => {
  const args = buildArgs("in.mkv", "out.mp4", mp4Choice());
  assert.equal(args[args.indexOf("-crf") + 1], "20");
  assert.equal(args[args.indexOf("-c:v") + 1], "libx264");
  assert.equal(args[args.indexOf("-c:a") + 1], "aac");
  assert.equal(args[args.indexOf("-map_metadata") + 1], "-1");
  // Even sides, but no scaling to a smaller size.
  assert.match(args[args.indexOf("-vf") + 1]!, /scale=w='trunc\(iw\/2\)\*2':h='trunc\(ih\/2\)\*2'/);
});

function makeMkv(dir: string): { path: string; bytes: number } {
  // Odd dimensions on purpose: H.264 needs even sides, so the output must be 640x360.
  const file = path.join(dir, "clip.mkv");
  const result = spawnSync(ffmpeg, [
    "-hide_banner", "-loglevel", "error", "-y",
    "-f", "lavfi", "-i", "testsrc2=size=641x361:rate=25:duration=2",
    "-f", "lavfi", "-i", "sine=frequency=330:duration=2",
    "-c:v", "mpeg4", "-q:v", "3", "-c:a", "aac", "-shortest", file,
  ]);
  assert.equal(result.status, 0, result.stderr.toString());
  return { path: file, bytes: statSync(file).size };
}

test("converts an MKV to an H.264 + AAC MP4 at the same resolution", { skip: skipReason }, async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "mp4test-"));
  try {
    const input = makeMkv(dir);
    const output = path.join(dir, "out.mp4");
    const result = await resizeVideo({ binary: ffmpeg, input: input.path, output, choice: mp4Choice() });
    assert.equal(result.width, 640);
    assert.equal(result.height, 360);

    const info = await probeVideo(ffmpeg, output);
    assert.equal(info.codec, "h264");
    assert.equal(info.hasAudio, true);
    assert.equal(info.width, 640);
    assert.equal(info.height, 360);
    assert.equal(readFileSync(output).subarray(4, 8).toString("latin1"), "ftyp", "output is an MP4 container");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/* ---------- end to end, against a local stand-in for the Telegram Bot API ---------- */

const TOKEN = `123456:${"A".repeat(35)}`;
const CHAT_ID = 4242;

type RecordedCall = { method: string; body: Buffer; contentType: string };

/** Serves getMe/getFile/sendMessage/... like api.telegram.org, plus the file bytes the bot downloads. */
function startFakeTelegram(fileBytes: Buffer, options: { hangDownload?: boolean } = {}) {
  const calls: RecordedCall[] = [];
  let nextMessageId = 100;
  const server: Server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const body = Buffer.concat(chunks);
    const url = new URL(req.url ?? "/", "http://fake");

    if (url.pathname.startsWith(`/file/bot${TOKEN}/`)) {
      if (options.hangDownload) return; // Never answers, so the test can cancel mid-download.
      res.writeHead(200, { "content-type": "application/octet-stream" }).end(fileBytes);
      return;
    }
    const method = url.pathname.match(/^\/bot[^/]+\/(\w+)$/)?.[1] ?? "unknown";
    calls.push({ method, body, contentType: req.headers["content-type"] ?? "" });

    let result: unknown = true;
    if (method === "getMe") {
      result = {
        id: 123456, is_bot: true, first_name: "MP4", username: "mp4_fake_bot",
        can_join_groups: true, can_read_all_group_messages: false, supports_inline_queries: false,
      };
    } else if (method === "getFile") {
      result = { file_id: "F", file_unique_id: "U", file_size: fileBytes.length, file_path: "videos/file_1.mkv" };
    } else if (method === "sendMessage" || method === "editMessageText") {
      result = { message_id: nextMessageId++, date: 0, chat: { id: CHAT_ID, type: "private" }, text: "" };
    } else if (method === "sendVideo") {
      result = {
        message_id: nextMessageId++, date: 0, chat: { id: CHAT_ID, type: "private" },
        video: { file_id: "OUT", file_unique_id: "OU", width: 640, height: 360, duration: 2 },
      };
    }
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ok: true, result }));
  });

  const waitFor = async (method: string, timeoutMs = 60_000): Promise<RecordedCall> => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const found = calls.find((call) => call.method === method);
      if (found) return found;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error(`Timed out waiting for ${method}; saw ${calls.map((c) => c.method).join(", ")}`);
  };

  return { server, calls, waitFor };
}

/** Polls until a recorded call matches, so tests don't depend on fixed sleeps. */
async function waitUntil(calls: RecordedCall[], matches: (call: RecordedCall) => boolean, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const found = calls.find(matches);
    if (found) return found;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("Timed out waiting for the expected Telegram call");
}

/** Splits a multipart/form-data body into its parts (headers and raw bytes). */
function multipartParts(body: Buffer, contentType: string): Array<{ headers: string; data: Buffer }> {
  const boundary = contentType.match(/boundary=(.+)$/)?.[1];
  assert.ok(boundary, "multipart boundary");
  const delimiter = Buffer.from(`--${boundary}`);
  const parts: Array<{ headers: string; data: Buffer }> = [];
  let position = body.indexOf(delimiter);
  while (position !== -1) {
    const next = body.indexOf(delimiter, position + delimiter.length);
    if (next === -1) break;
    const part = body.subarray(position + delimiter.length, next);
    const headerEnd = part.indexOf("\r\n\r\n");
    parts.push({
      headers: part.subarray(0, headerEnd).toString("utf8"),
      data: part.subarray(headerEnd + 4, part.length - 2),
    });
    position = next;
  }
  return parts;
}

const servers: Server[] = [];
let workDir: string;

before(() => {
  workDir = mkdtempSync(path.join(tmpdir(), "mp4bot-test-"));
});

after(() => {
  for (const server of servers) {
    server.closeAllConnections();
    server.close();
  }
  rmSync(workDir, { recursive: true, force: true });
});

async function startFake(fileBytes: Buffer, options?: { hangDownload?: boolean }) {
  const fake = startFakeTelegram(fileBytes, options);
  servers.push(fake.server);
  await new Promise<void>((resolve) => fake.server.listen(0, "127.0.0.1", resolve));
  const apiRoot = `http://127.0.0.1:${(fake.server.address() as AddressInfo).port}`;
  return { ...fake, apiRoot };
}

function config(apiRoot: string, overrides: Partial<Mp4BotConfig> = {}): Mp4BotConfig {
  return {
    token: TOKEN,
    apiRoot,
    localApi: false,
    maxUploadMB: 20,
    maxOutputMB: 50,
    maxConcurrentJobs: 2,
    ffmpegPath: ffmpeg,
    ...overrides,
  };
}

function documentUpdate(fileName: string, mimeType: string | undefined, fileSize: number) {
  return {
    update_id: 1,
    message: {
      message_id: 7,
      date: 0,
      chat: { id: CHAT_ID, type: "private", first_name: "Tester" },
      from: { id: CHAT_ID, is_bot: false, first_name: "Tester" },
      document: {
        file_id: "F",
        file_unique_id: "U",
        file_name: fileName,
        ...(mimeType ? { mime_type: mimeType } : {}),
        file_size: fileSize,
      },
    },
  };
}

test("a video sent to the bot comes back as a real MP4", { skip: skipReason }, async () => {
  const input = makeMkv(workDir);
  const fake = await startFake(readFileSync(input.path));
  const { bot } = createMp4Bot(config(fake.apiRoot), ffmpeg);
  await bot.init();

  await bot.handleUpdate(documentUpdate("holiday.mkv", "video/x-matroska", input.bytes) as never);
  const upload = await fake.waitFor("sendVideo");
  assert.match(upload.contentType, /multipart\/form-data/);

  const parts = multipartParts(upload.body, upload.contentType);
  const file = parts.find((part) => /filename="?holiday\.mp4"?/.test(part.headers));
  assert.ok(file, "the MP4 is uploaded as holiday.mp4");
  assert.equal(file.data.subarray(4, 8).toString("latin1"), "ftyp", "the uploaded file is an MP4");
  const caption = parts.find((part) => part.headers.includes('name="caption"'));
  assert.match(caption?.data.toString("utf8") ?? "", /^MP4 ready\. Original: /);

  const status = fake.calls.find((c) => c.method === "sendMessage");
  assert.ok(status, "the bot posted a status message first");
  assert.match(status.body.toString("utf8"), /Converting to MP4/);
  await fake.waitFor("editMessageText");
});

test("a non-video document is refused without downloading anything", { skip: skipReason }, async () => {
  const fake = await startFake(Buffer.from("not a video"));
  const { bot } = createMp4Bot(config(fake.apiRoot), ffmpeg);
  await bot.init();

  await bot.handleUpdate(documentUpdate("notes.pdf", "application/pdf", 11) as never);
  const reply = await fake.waitFor("sendMessage");
  assert.match(reply.body.toString("utf8"), /doesn't look like a video/);
  assert.equal(fake.calls.some((c) => c.method === "getFile"), false, "nothing was downloaded");
});

test("a video over the upload limit is refused before download", { skip: skipReason }, async () => {
  const fake = await startFake(Buffer.from("unused"));
  const { bot } = createMp4Bot(config(fake.apiRoot, { maxUploadMB: 1 }), ffmpeg);
  await bot.init();

  await bot.handleUpdate(documentUpdate("big.mp4", "video/mp4", 5 * 1024 * 1024) as never);
  const reply = await fake.waitFor("sendMessage");
  assert.match(reply.body.toString("utf8"), /over this bot's 1 MB limit/);
  assert.equal(fake.calls.some((c) => c.method === "getFile"), false);
});

test("a file that is not a readable video gets a clear failure message", { skip: skipReason }, async () => {
  const fake = await startFake(Buffer.from("this is not a video at all, just text"));
  const { bot } = createMp4Bot(config(fake.apiRoot), ffmpeg);
  await bot.init();

  await bot.handleUpdate(documentUpdate("broken.mp4", "video/mp4", 40) as never);
  const failure = await waitUntil(
    fake.calls,
    (c) => c.method === "sendMessage" && c.body.toString("utf8").includes(mp4Messages.failed.slice(0, 30)),
  );
  assert.ok(failure, "the user is told the conversion failed");
  assert.equal(fake.calls.some((c) => c.method === "sendVideo"), false, "nothing was sent");
});

test("/cancel stops a conversion that is still downloading", { skip: skipReason }, async () => {
  const fake = await startFake(Buffer.from("unused"), { hangDownload: true });
  const { bot } = createMp4Bot(config(fake.apiRoot), ffmpeg);
  await bot.init();

  await bot.handleUpdate(documentUpdate("long.mkv", "video/x-matroska", 1000) as never);
  await fake.waitFor("getFile");
  await bot.handleUpdate({
    update_id: 2,
    message: {
      message_id: 8,
      date: 0,
      chat: { id: CHAT_ID, type: "private", first_name: "Tester" },
      from: { id: CHAT_ID, is_bot: false, first_name: "Tester" },
      text: "/cancel",
      entities: [{ type: "bot_command", offset: 0, length: 7 }],
    },
  } as never);

  // The status message is edited several times; wait for the one that says "Cancelled".
  const cancelled = await waitUntil(
    fake.calls,
    (c) => c.method === "editMessageText" && c.body.toString("utf8").includes(mp4Messages.cancelled.slice(0, 30)),
  );
  assert.ok(cancelled, "the status message says the conversion was cancelled");
  assert.equal(fake.calls.some((c) => c.method === "sendVideo"), false);
});
