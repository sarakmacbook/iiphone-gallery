import assert from "node:assert/strict";
import test from "node:test";
import { loadVercelEnv } from "./env.js";
import {
  configBody,
  convertUpload,
  ndjsonResponse,
  parseByteRange,
  signDownloadToken,
  unavailableReason,
  verifyDownloadToken,
} from "./web-convert.js";

test("Vercel environment defaults are serverless-safe and use the production URL", () => {
  const env = loadVercelEnv({
    VERCEL_URL: "preview-123.vercel.app",
    VERCEL_PROJECT_PRODUCTION_URL: "sendable.vercel.app",
  });
  assert.equal(env.publicUrl, "https://sendable.vercel.app");
  assert.equal(env.webConvert, true);
  assert.equal(env.webMaxUploadMB, 100);
  assert.equal(env.webMaxOutputMB, 100);
  assert.equal(env.maxSeconds, 50);
  assert.equal(env.token, undefined);
  assert.equal(loadVercelEnv({ VERCEL_ENV: "preview", VERCEL_URL: "preview-123.vercel.app" }).publicUrl, undefined);
  assert.equal(loadVercelEnv({ VERCEL_ENV: "production", VERCEL_URL: "sendable.vercel.app" }).publicUrl, "https://sendable.vercel.app");
});

test("invalid serverless limits and insecure public URLs fail early", () => {
  assert.throws(() => loadVercelEnv({ WEB_MAX_UPLOAD_MB: "201" }), /WEB_MAX_UPLOAD_MB/);
  assert.throws(() => loadVercelEnv({ PUBLIC_URL: "http://sendable.example" }), /HTTPS/);
  assert.throws(() => loadVercelEnv({ PUBLIC_URL: "https://sendable.example/path" }), /origin/);
  assert.throws(() => loadVercelEnv({ PUBLIC_URL: "https://sendable.example?" }), /origin/);
  assert.throws(() => loadVercelEnv({ CORS_ORIGIN: "https://sendable.example/path" }), /origin/);
  assert.deepEqual(
    loadVercelEnv({ CORS_ORIGIN: "https://one.example/, https://two.example" }).corsOrigin,
    "https://one.example,https://two.example",
  );
  assert.throws(() => loadVercelEnv({ MAX_UPLOAD_MB: "21" }), /MAX_UPLOAD_MB/);
});

test("converter config advertises the Vercel Blob upload protocol and limits", () => {
  const env = loadVercelEnv({ BLOB_READ_WRITE_TOKEN: "test-token" });
  const config = configBody(env);
  assert.deepEqual(config.upload, {
    provider: "vercel-blob",
    endpoint: "/api/upload",
    access: "private",
    prefix: "sendable/uploads/",
  });
  assert.equal(unavailableReason(env), null);
  assert.equal(unavailableReason(loadVercelEnv({}))?.code, "blobNotConfigured");
});

test("signed Blob download links reject tampering and expiry", () => {
  const claims = {
    url: "https://store.public.blob.vercel-storage.com/sendable/outputs/a/video.mp4",
    name: "video_480p.mp4",
    expiresAt: 5000,
  };
  const token = signDownloadToken(claims, "test secret");
  assert.deepEqual(verifyDownloadToken(token, "test secret", 4999), claims);
  assert.equal(verifyDownloadToken(token, "wrong secret", 4999), null);
  assert.equal(verifyDownloadToken(token, "test secret", 5000), null);
  assert.equal(verifyDownloadToken(`${token}x`, "test secret", 4999), null);
});

test("byte range parsing supports normal, suffix, and open-ended ranges", () => {
  assert.deepEqual(parseByteRange("bytes=5-9", 20), { start: 5, end: 9 });
  assert.deepEqual(parseByteRange("bytes=-4", 20), { start: 16, end: 19 });
  assert.deepEqual(parseByteRange("bytes=18-", 20), { start: 18, end: 19 });
  assert.equal(parseByteRange("bytes=20-", 20), null);
  assert.equal(parseByteRange("bytes=1-2,4-5", 20), null);
});

test("a Vercel conversion without Blob configuration returns a useful NDJSON error", async () => {
  const env = loadVercelEnv({});
  const events = convertUpload(
    { url: "https://store.public.blob.vercel-storage.com/sendable/uploads/test.mov", name: "test.mov" },
    env,
    { ffmpeg: () => "ffmpeg" },
  );
  const response = ndjsonResponse(events);
  const lines = (await response.text()).trim().split("\n").map((line) => JSON.parse(line));
  assert.deepEqual(lines, [
    {
      type: "error",
      ok: false,
      error: { code: "blobNotConfigured", message: "Vercel Blob is not configured." },
    },
  ]);
});
