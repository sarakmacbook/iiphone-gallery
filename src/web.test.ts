import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createServer, type Server } from "node:http";
import { AddressInfo } from "node:net";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { resolveFfmpeg } from "./ffmpeg.js";
import { isSupportedUpload, parseRange, resolveChoice, createConvertApi, type ConvertApi } from "./web.js";

const ffmpeg = process.env.FFMPEG_PATH || resolveFfmpeg();
const hasFfmpeg = spawnSync(ffmpeg, ["-version"]).status === 0;
const skipReason = hasFfmpeg ? false : ("ffmpeg not found" as const);

/** A short 1920x1080 clip with audio, like a landscape iPhone recording. */
function makeClip(dir: string, name = "clip.mov"): { path: string; bytes: number } {
  const file = path.join(dir, name);
  const result = spawnSync(ffmpeg, [
    "-hide_banner",
    "-loglevel",
    "error",
    "-y",
    "-f",
    "lavfi",
    "-i",
    "testsrc2=size=1920x1080:rate=30:duration=3",
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=440:duration=3",
    "-c:v",
    "libx264",
    "-preset",
    "ultrafast",
    "-crf",
    "16",
    "-c:a",
    "aac",
    "-shortest",
    file,
  ]);
  assert.equal(result.status, 0, result.stderr.toString());
  return { path: file, bytes: statSync(file).size };
}

let workDir: string;
let api: ConvertApi;
let server: Server;
let base = "";

before(async () => {
  workDir = mkdtempSync(path.join(tmpdir(), "sendable-web-test-"));
  api = createConvertApi({
    limits: {
      maxUploadMB: 20,
      allowCustom: true,
      maxDimension: 3840,
      maxConcurrentJobs: 2,
      jobTtlMinutes: 60,
    },
    corsOrigin: "*",
    ffmpeg,
    workRoot: workDir,
  });
  server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (!api.handle(req, res, url)) res.writeHead(404).end("nope");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  await api.shutdown();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  rmSync(workDir, { recursive: true, force: true });
});

type JobJson = {
  id: string;
  state: string;
  progress: number;
  source: { name: string; bytes: number; width?: number; height?: number; duration?: number };
  choice: { kind: string; key?: string; label: string; width?: number; height?: number };
  output?: { name: string; bytes: number; width?: number; height?: number; smaller: boolean; url: string };
  error?: { code: string; message: string };
};

async function upload(
  file: { path: string; name?: string; type?: string },
  fields: Record<string, string> = {},
): Promise<Response> {
  const form = new FormData();
  for (const [key, value] of Object.entries(fields)) form.append(key, value);
  const bytes = await readFile(file.path);
  form.append(
    "video",
    new Blob([new Uint8Array(bytes)], { type: file.type ?? "video/quicktime" }),
    file.name ?? path.basename(file.path),
  );
  return fetch(`${base}/api/convert`, { method: "POST", body: form });
}

async function waitForJob(id: string, timeoutMs = 60_000): Promise<JobJson> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const response = await fetch(`${base}/api/jobs/${id}`);
    const body = (await response.json()) as { ok: boolean; job: JobJson };
    if (!["queued", "converting"].includes(body.job.state)) return body.job;
    if (Date.now() > deadline) throw new Error(`Job ${id} did not finish in time`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

test("pure helpers: uploads, choices and byte ranges", () => {
  assert.equal(isSupportedUpload("IMG_0001.MOV", "video/quicktime"), true);
  assert.equal(isSupportedUpload("clip.mp4", "application/octet-stream"), true);
  assert.equal(isSupportedUpload("notes.pdf", "application/pdf"), false);

  const balanced = resolveChoice({ preset: "balanced" }, { allowCustom: true, maxDimension: 3840 });
  assert.ok(balanced.ok && balanced.choice.kind === "preset" && balanced.choice.key === "balanced");
  assert.deepEqual(resolveChoice({}, { allowCustom: true, maxDimension: 3840 }), balanced);

  const custom = resolveChoice({ width: "720", height: "1280" }, { allowCustom: true, maxDimension: 3840 });
  assert.ok(custom.ok && custom.choice.kind === "custom" && custom.choice.width === 720);

  const disabled = resolveChoice({ width: "720", height: "1280" }, { allowCustom: false, maxDimension: 3840 });
  assert.equal(disabled.ok, false);
  if (!disabled.ok) assert.equal(disabled.code, "customDisabled");

  const unknown = resolveChoice({ preset: "huge" }, { allowCustom: true, maxDimension: 3840 });
  assert.equal(unknown.ok, false);
  if (!unknown.ok) assert.equal(unknown.code, "badPreset");

  const oversized = resolveChoice({ width: "9000", height: "9000" }, { allowCustom: true, maxDimension: 3840 });
  assert.equal(oversized.ok, false);
  if (!oversized.ok) assert.equal(oversized.code, "badDimensions");

  assert.deepEqual(parseRange("bytes=0-99", 1000), { start: 0, end: 99 });
  assert.deepEqual(parseRange("bytes=900-", 1000), { start: 900, end: 999 });
  assert.deepEqual(parseRange("bytes=-100", 1000), { start: 900, end: 999 });
  assert.deepEqual(parseRange("bytes=0-5000", 1000), { start: 0, end: 999 });
  assert.equal(parseRange("bytes=1000-2000", 1000), null);
  assert.equal(parseRange("items=0-1", 1000), null);
});

test("GET /api/config describes the presets and limits", async () => {
  const response = await fetch(`${base}/api/config`);
  assert.equal(response.status, 200);
  const body = (await response.json()) as {
    ok: boolean;
    limits: { maxUploadMB: number; allowCustom: boolean };
    presets: Array<{ key: string; label: string }>;
  };
  assert.equal(body.ok, true);
  assert.equal(body.limits.maxUploadMB, 20);
  assert.equal(body.limits.allowCustom, true);
  assert.deepEqual(
    body.presets.map((preset) => preset.key),
    ["convert", "keep", "balanced", "smaller"],
  );
});

test("converts an uploaded video and reports the real sizes", { skip: skipReason }, async () => {
  const clip = makeClip(workDir);
  const created = await upload(clip, { preset: "smaller" });
  assert.equal(created.status, 202);
  const createdBody = (await created.json()) as { ok: boolean; job: JobJson };
  assert.equal(createdBody.ok, true);
  assert.equal(createdBody.job.state, "queued");
  assert.equal(createdBody.job.source.name, "clip.mov");
  assert.equal(createdBody.job.source.width, 1920);
  assert.equal(createdBody.job.source.height, 1080);
  assert.ok(createdBody.job.source.duration && Math.abs(createdBody.job.source.duration - 3) < 0.3);

  const job = await waitForJob(createdBody.job.id);
  assert.equal(job.state, "done", JSON.stringify(job.error));
  assert.equal(job.progress, 1);
  assert.equal(job.output?.width, 854);
  assert.equal(job.output?.height, 480);
  assert.equal(job.output?.smaller, true);
  assert.equal(job.output?.name, "clip_480p.mp4");
  assert.ok(job.output!.bytes > 0);
  assert.ok(job.output!.bytes < job.source.bytes, `${job.output!.bytes} < ${job.source.bytes}`);

  // The download is the same file, and byte ranges work so the browser can seek.
  const full = await fetch(`${base}${job.output!.url}`);
  assert.equal(full.status, 200);
  assert.equal(full.headers.get("content-type"), "video/mp4");
  assert.match(full.headers.get("content-disposition") ?? "", /attachment; filename="clip_480p.mp4"/);
  const bytes = new Uint8Array(await full.arrayBuffer());
  assert.equal(bytes.length, job.output!.bytes);
  assert.equal(Buffer.from(bytes.subarray(4, 8)).toString(), "ftyp");

  const partial = await fetch(`${base}${job.output!.url}?inline=1`, { headers: { range: "bytes=0-99" } });
  assert.equal(partial.status, 206);
  assert.equal(partial.headers.get("content-length"), "100");
  assert.equal(partial.headers.get("content-range"), `bytes 0-99/${job.output!.bytes}`);
  assert.match(partial.headers.get("content-disposition") ?? "", /^inline/);
  assert.equal((await partial.arrayBuffer()).byteLength, 100);
});

test("accepts custom dimensions", { skip: skipReason }, async () => {
  const clip = makeClip(workDir, "custom.mov");
  const created = await upload(clip, { width: "640", height: "640" });
  const { job } = (await created.json()) as { job: JobJson };
  const finished = await waitForJob(job.id);
  assert.equal(finished.state, "done", JSON.stringify(finished.error));
  // Fit inside a 640x640 box without stretching: 16:9 becomes 640x360.
  assert.deepEqual([finished.output?.width, finished.output?.height], [640, 360]);
  assert.equal(finished.output?.name, "custom_640x640.mp4");
});

test("rejects bad requests before doing any work", { skip: skipReason }, async () => {
  const clip = makeClip(workDir, "bad.mov");

  const unknownPreset = await upload(clip, { preset: "gigantic" });
  assert.equal(unknownPreset.status, 400);
  const unknownBody = (await unknownPreset.json()) as { error: { code: string } };
  assert.equal(unknownBody.error.code, "badPreset");

  const pdf = path.join(workDir, "notes.pdf");
  await writeFile(pdf, "%PDF-1.4 not a video");
  const wrongType = await upload({ path: pdf, name: "notes.pdf", type: "application/pdf" });
  assert.equal(wrongType.status, 415);
  assert.equal(((await wrongType.json()) as { error: { code: string } }).error.code, "unsupported");

  const notMultipart = await fetch(`${base}/api/convert`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  assert.equal(notMultipart.status, 415);

  const missing = await fetch(`${base}/api/jobs/00000000-0000-0000-0000-000000000000`);
  assert.equal(missing.status, 404);
  assert.equal(((await missing.json()) as { error: { code: string } }).error.code, "expired");
});

test("an upload over the limit is refused", { skip: skipReason }, async () => {
  const tiny = createConvertApi({
    limits: {
      maxUploadMB: 1,
      allowCustom: true,
      maxDimension: 3840,
      maxConcurrentJobs: 1,
      jobTtlMinutes: 60,
    },
    corsOrigin: "*",
    ffmpeg,
    workRoot: workDir,
  });
  const tinyServer = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (!tiny.handle(req, res, url)) res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => tinyServer.listen(0, "127.0.0.1", resolve));
  const tinyBase = `http://127.0.0.1:${(tinyServer.address() as AddressInfo).port}`;
  try {
    const clip = makeClip(workDir, "big.mov");
    assert.ok(clip.bytes > 1024 * 1024, "the sample clip should be bigger than 1 MB");
    const form = new FormData();
    form.append("preset", "smaller");
    const bytes = await readFile(clip.path);
    form.append("video", new Blob([new Uint8Array(bytes)], { type: "video/quicktime" }), "big.mov");
    const response = await fetch(`${tinyBase}/api/convert`, { method: "POST", body: form });
    assert.equal(response.status, 413);
    assert.equal(((await response.json()) as { error: { code: string } }).error.code, "tooLarge");
  } finally {
    await tiny.shutdown();
    await new Promise<void>((resolve) => tinyServer.close(() => resolve()));
  }
});

test("DELETE cancels a job and deletes its files", { skip: skipReason }, async () => {
  const clip = makeClip(workDir, "cancel.mov");
  const jobsBefore = api.stats().jobs;
  const created = await upload(clip, { preset: "keep" });
  const { job } = (await created.json()) as { job: JobJson };
  assert.equal(api.stats().jobs, jobsBefore + 1);

  const cancelled = await fetch(`${base}/api/jobs/${job.id}`, { method: "DELETE" });
  assert.equal(cancelled.status, 200);
  assert.deepEqual(await cancelled.json(), { ok: true, cancelled: true });

  const after = await fetch(`${base}/api/jobs/${job.id}`);
  assert.equal(after.status, 404);
  assert.equal(api.stats().jobs, jobsBefore); // the job and its files are gone
});

test("a failed conversion reports its reason instead of expiring", { skip: skipReason }, async () => {
  // A stand-in ffmpeg: probing (4 arguments) works, encoding fails.
  const fake = path.join(workDir, "ffmpeg-that-fails");
  await writeFile(fake, `#!/bin/sh\nif [ "$#" -le 4 ]; then exec "${ffmpeg}" "$@"; fi\nexit 3\n`, {
    mode: 0o755,
  });

  const broken = createConvertApi({
    limits: {
      maxUploadMB: 20,
      allowCustom: true,
      maxDimension: 3840,
      maxConcurrentJobs: 1,
      jobTtlMinutes: 60,
    },
    corsOrigin: "*",
    ffmpeg: fake,
    workRoot: workDir,
  });
  const brokenServer = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (!broken.handle(req, res, url)) res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => brokenServer.listen(0, "127.0.0.1", resolve));
  const brokenBase = `http://127.0.0.1:${(brokenServer.address() as AddressInfo).port}`;
  try {
    const clip = makeClip(workDir, "doomed.mov");
    const form = new FormData();
    form.append("preset", "smaller");
    form.append(
      "video",
      new Blob([new Uint8Array(await readFile(clip.path))], { type: "video/quicktime" }),
      "doomed.mov",
    );
    const created = await fetch(`${brokenBase}/api/convert`, { method: "POST", body: form });
    assert.equal(created.status, 202); // the upload itself was fine
    const { job } = (await created.json()) as { job: JobJson };

    let final = job;
    for (let i = 0; i < 200 && ["queued", "converting"].includes(final.state); i++) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      const status = await fetch(`${brokenBase}/api/jobs/${job.id}`);
      assert.equal(status.status, 200, "the failed job must stay readable");
      final = ((await status.json()) as { job: JobJson }).job;
    }

    assert.equal(final.state, "error");
    assert.equal(final.error?.code, "convertFailed");
    assert.match(final.error?.message ?? "", /unchanged/);
    assert.equal(final.output, undefined);
  } finally {
    await broken.shutdown();
    await new Promise<void>((resolve) => brokenServer.close(() => resolve()));
  }
});

test("an API key is required when one is configured", async () => {
  const locked = createConvertApi({
    limits: {
      maxUploadMB: 20,
      allowCustom: true,
      maxDimension: 3840,
      maxConcurrentJobs: 1,
      jobTtlMinutes: 60,
    },
    corsOrigin: "https://example.com",
    ffmpeg,
    apiKey: "secret-key",
    workRoot: workDir,
  });
  const lockedServer = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (!locked.handle(req, res, url)) res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => lockedServer.listen(0, "127.0.0.1", resolve));
  const lockedBase = `http://127.0.0.1:${(lockedServer.address() as AddressInfo).port}`;
  try {
    const denied = await fetch(`${lockedBase}/api/convert`, { method: "POST" });
    assert.equal(denied.status, 401);

    const allowed = await fetch(`${lockedBase}/api/convert`, {
      method: "POST",
      headers: { "x-api-key": "secret-key", "content-type": "application/json" },
      body: "{}",
    });
    assert.equal(allowed.status, 415); // past auth, rejected for not being multipart

    const preflight = await fetch(`${lockedBase}/api/config`, {
      method: "OPTIONS",
      headers: { origin: "https://example.com" },
    });
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers.get("access-control-allow-origin"), "https://example.com");
  } finally {
    await locked.shutdown();
    await new Promise<void>((resolve) => lockedServer.close(() => resolve()));
  }
});
