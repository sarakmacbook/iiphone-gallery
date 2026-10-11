import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { del, get, head, list, put } from "@vercel/blob";
import { handleUpload, type HandleUploadBody } from "@vercel/blob/client";
import { probeVideo, resizeVideo, type ProbeResult, type ResizeResult } from "../src/ffmpeg.js";
import { outputFileName } from "../src/paths.js";
import { PRESETS, type SizeChoice } from "../src/sizes.js";
import { isSupportedUpload, resolveChoice } from "../src/web.js";
import type { VercelEnv } from "./env.js";
import { corsHeaders } from "./http.js";

export const UPLOAD_PREFIX = "sendable/uploads/";
export const OUTPUT_PREFIX = "sendable/outputs/";
const ALLOWED_CONTENT_TYPES = [
  "video/mp4",
  "video/quicktime",
  "video/x-m4v",
  "video/webm",
  "video/x-matroska",
  "application/octet-stream",
];
const UPLOAD_TTL_SECONDS = 60 * 60;
const MAX_UPLOAD_PATH_LENGTH = 240;
const SUPPORTED_UPLOAD_NAME = /\.(mov|mp4|m4v|webm|mkv)$/i;

export type ConvertRequest = {
  url: string;
  name?: string;
  preset?: string;
  width?: number | string;
  height?: number | string;
};

export type ConvertSource = { name: string; bytes: number; width?: number; height?: number; duration?: number };
export type ConvertChoice = { kind: "preset" | "custom"; label: string; key?: string; width?: number; height?: number };

export type ConvertEvent =
  | { type: "progress"; stage: "download" | "probe" | "convert" | "store"; progress?: number }
  | {
      type: "complete";
      ok: true;
      job: {
        name: string;
        bytes: number;
        url: string;
        downloadUrl: string;
        smaller: boolean;
        width?: number;
        height?: number;
        duration?: number;
        source: ConvertSource;
        choice: ConvertChoice;
      };
    }
  | { type: "error"; ok: false; error: { code: string; message: string } };

class ConversionError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ConversionError";
  }
}

class AsyncQueue<T> implements AsyncIterableIterator<T> {
  private readonly values: T[] = [];
  private readonly waiting: Array<(result: IteratorResult<T>) => void> = [];
  private closed = false;

  push(value: T): void {
    if (this.closed) return;
    const waiter = this.waiting.shift();
    if (waiter) waiter({ value, done: false });
    else this.values.push(value);
  }

  close(): void {
    this.closed = true;
    for (const waiter of this.waiting.splice(0)) waiter({ value: undefined, done: true });
  }

  next(): Promise<IteratorResult<T>> {
    const value = this.values.shift();
    if (value !== undefined) return Promise.resolve({ value, done: false });
    if (this.closed) return Promise.resolve({ value: undefined, done: true });
    return new Promise((resolve) => this.waiting.push(resolve));
  }

  async return(): Promise<IteratorResult<T>> {
    this.close();
    return { value: undefined, done: true };
  }

  [Symbol.asyncIterator](): AsyncIterableIterator<T> {
    return this;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function uploadName(pathname: string): string | undefined {
  if (pathname.length > MAX_UPLOAD_PATH_LENGTH || !pathname.startsWith(UPLOAD_PREFIX)) return undefined;
  const leaf = pathname.slice(UPLOAD_PREFIX.length);
  if (!leaf || leaf.includes("/") || leaf.includes("\\") || leaf === "." || leaf === "..") return undefined;
  return leaf;
}

function validUploadUrl(value: string): boolean {
  if (value.length > 4096) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password;
  } catch {
    return false;
  }
}

/** Request a constrained Vercel Blob client-upload token. The video itself never passes through a Function. */
export async function handleUploadToken(
  request: Request,
  env: VercelEnv,
  body: HandleUploadBody,
): Promise<unknown> {
  if (!env.blobToken) throw new Error("Vercel Blob is not configured.");
  return handleUpload({
    request,
    body,
    token: env.blobToken,
    onBeforeGenerateToken: async (pathname) => {
      const name = uploadName(pathname);
      if (!name || !SUPPORTED_UPLOAD_NAME.test(name)) {
        throw new Error("Upload a MOV, MP4, M4V, WebM, or Matroska video under the sendable/uploads/ prefix.");
      }
      return {
        allowedContentTypes: ALLOWED_CONTENT_TYPES,
        maximumSizeInBytes: Math.floor(env.webMaxUploadMB * 1024 * 1024),
        validUntil: Date.now() + UPLOAD_TTL_SECONDS * 1000,
        addRandomSuffix: true,
        allowOverwrite: false,
        cacheControlMaxAge: 60,
        tokenPayload: JSON.stringify({ purpose: "sendable-video-upload", version: 1 }),
      };
    },
  });
}

export function unavailableReason(env: VercelEnv): { code: string; message: string } | null {
  if (!env.webConvert) {
    return { code: "converterDisabled", message: "Website conversion is disabled on this deployment." };
  }
  if (!env.blobToken) {
    return {
      code: "blobNotConfigured",
      message: "Connect a Vercel Blob store and set BLOB_READ_WRITE_TOKEN before using the converter.",
    };
  }
  return null;
}

export function configBody(env: VercelEnv): Record<string, unknown> {
  return {
    ok: true,
    mode: "vercel",
    upload: {
      provider: "vercel-blob",
      endpoint: "/api/upload",
      access: "private",
      prefix: UPLOAD_PREFIX,
    },
    limits: {
      maxUploadMB: env.webMaxUploadMB,
      maxOutputMB: env.webMaxOutputMB,
      allowCustom: env.allowCustom,
      maxDimension: env.maxDimension,
      maxSeconds: env.maxSeconds,
      jobTtlMinutes: env.webJobTtlMinutes,
    },
    presets: PRESETS.map((preset) => ({
      key: preset.key,
      label: preset.label,
      detail: preset.detail,
      shortSide: preset.shortSide,
    })),
    accepts: ["MOV", "MP4", "M4V", "WEBM", "MKV"],
  };
}

export function signDownloadToken(
  claims: { url: string; name: string; expiresAt: number },
  secret: string,
): string {
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  const signature = createHmac("sha256", secret).update(payload).digest("base64url");
  return `${payload}.${signature}`;
}

export function verifyDownloadToken(
  token: string,
  secret: string,
  now = Date.now(),
): { url: string; name: string; expiresAt: number } | null {
  if (token.length > 8192) return null;
  const [payload, signature, extra] = token.split(".");
  if (!payload || !signature || extra !== undefined || !/^[A-Za-z0-9_-]+$/.test(signature)) return null;
  const expected = createHmac("sha256", secret).update(payload).digest();
  let received: Buffer;
  try {
    received = Buffer.from(signature, "base64url");
  } catch {
    return null;
  }
  if (expected.length !== received.length || !timingSafeEqual(expected, received)) return null;

  try {
    const decoded: unknown = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    if (!isRecord(decoded)) return null;
    const { url, name, expiresAt } = decoded;
    if (
      typeof url !== "string" ||
      !validUploadUrl(url) ||
      typeof name !== "string" ||
      name.length < 1 ||
      name.length > 180 ||
      /[\r\n"\\]/.test(name) ||
      typeof expiresAt !== "number" ||
      !Number.isSafeInteger(expiresAt) ||
      expiresAt <= now
    ) {
      return null;
    }
    return { url, name, expiresAt };
  } catch {
    return null;
  }
}

function downloadLink(url: string, name: string, env: VercelEnv, inline = false): string {
  const secret = env.downloadSecret || env.blobToken;
  if (!secret) throw new Error("A signing secret is required to create a download link.");
  const token = signDownloadToken(
    { url, name, expiresAt: Math.floor(Date.now() + env.webJobTtlMinutes * 60 * 1000) },
    secret,
  );
  return `/download?token=${encodeURIComponent(token)}${inline ? "&inline=1" : ""}`;
}

function choiceBody(choice: SizeChoice): ConvertChoice {
  return choice.kind === "custom"
    ? { kind: "custom", label: choice.label, width: choice.width, height: choice.height }
    : { kind: "preset", label: choice.label, key: choice.key };
}

function toSafeName(input: unknown, fallback: string): string {
  const value = typeof input === "string" && input.trim() ? input.trim() : fallback;
  const leaf = value.replace(/\\/g, "/").split("/").pop() ?? "";
  return leaf.slice(0, 200) || fallback;
}

async function safeDelete(url: string | undefined, env: VercelEnv): Promise<void> {
  if (!url || !env.blobToken) return;
  await del(url, { token: env.blobToken }).catch((error) => console.warn("Could not remove a temporary Blob:", error));
}

function eventError(error: unknown, timedOut: boolean, signal: AbortSignal): ConvertEvent {
  if (timedOut) {
    return {
      type: "error",
      ok: false,
      error: { code: "timeout", message: "That video took too long to convert. Try a shorter or smaller video." },
    };
  }
  if (signal.aborted) {
    return { type: "error", ok: false, error: { code: "cancelled", message: "The conversion was cancelled." } };
  }
  if (error instanceof ConversionError) {
    return { type: "error", ok: false, error: { code: error.code, message: error.message } };
  }
  console.error("Vercel video conversion failed:", error);
  return {
    type: "error",
    ok: false,
    error: { code: "convertFailed", message: "The conversion failed. Please check the video and try again." },
  };
}

async function convertWork(
  body: ConvertRequest,
  env: VercelEnv,
  binary: string,
  signal: AbortSignal,
  emit: (event: ConvertEvent) => void,
): Promise<void> {
  if (!isRecord(body) || typeof body.url !== "string" || !validUploadUrl(body.url)) {
    throw new ConversionError("badRequest", "Expected a Blob URL from the upload step.");
  }
  if (!env.blobToken) throw new ConversionError("blobNotConfigured", "Vercel Blob is not configured.");

  let remote: Awaited<ReturnType<typeof get>>;
  try {
    remote = await get(body.url, { access: "private", token: env.blobToken, useCache: false, abortSignal: signal });
  } catch (error) {
    throw new ConversionError(
      "uploadNotFound",
      error instanceof Error && /Invalid URL/.test(error.message)
        ? "That URL is not a Vercel Blob upload."
        : "I couldn't read that upload. Please upload the video again.",
    );
  }
  if (!remote || remote.statusCode !== 200) {
    throw new ConversionError("uploadNotFound", "That upload has expired or could not be found.");
  }

  const blobUrl = remote.blob.url;
  if (!remote.blob.pathname.startsWith(UPLOAD_PREFIX)) {
    await remote.stream.cancel().catch(() => undefined);
    throw new ConversionError("uploadRejected", "That Blob is not an upload created for this converter.");
  }
  if (remote.blob.size <= 0) {
    await remote.stream.cancel().catch(() => undefined);
    await safeDelete(blobUrl, env);
    throw new ConversionError("emptyFile", "That file has no video data. Please upload it again.");
  }
  if (remote.blob.size > env.webMaxUploadMB * 1024 * 1024) {
    await remote.stream.cancel().catch(() => undefined);
    await safeDelete(blobUrl, env);
    throw new ConversionError("tooLarge", `That video is over the ${env.webMaxUploadMB} MB limit.`);
  }

  const fallbackName = path.posix.basename(remote.blob.pathname);
  const sourceName = toSafeName(body.name, fallbackName);
  if (!SUPPORTED_UPLOAD_NAME.test(sourceName) && !isSupportedUpload(sourceName, remote.blob.contentType)) {
    await remote.stream.cancel().catch(() => undefined);
    await safeDelete(blobUrl, env);
    throw new ConversionError("unsupported", "Please upload a MOV, MP4, M4V, WebM, or Matroska video.");
  }

  const fields: Record<string, string> = {};
  if (typeof body.preset === "string") fields.preset = body.preset;
  if (typeof body.width === "number" || typeof body.width === "string") fields.width = String(body.width);
  if (typeof body.height === "number" || typeof body.height === "string") fields.height = String(body.height);
  const selection = resolveChoice(fields, { allowCustom: env.allowCustom, maxDimension: env.maxDimension });
  if (!selection.ok) {
    await remote.stream.cancel().catch(() => undefined);
    await safeDelete(blobUrl, env);
    throw new ConversionError(selection.code, selection.message);
  }
  const choice = selection.choice;

  let dir: string | undefined;
  let outputBlobUrl: string | undefined;
  let downloadedBytes = 0;
  let lastDownloadEvent = 0;

  try {
    dir = await mkdtemp(path.join(tmpdir(), "sendable-vercel-"));
    const inputPath = path.join(dir, "input" + (path.extname(sourceName).toLowerCase() || ".mov"));
    const outputName = outputFileName(sourceName, choice);
    const outputPath = path.join(dir, outputName);
    emit({ type: "progress", stage: "download", progress: 0 });
    const progress = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        downloadedBytes += chunk.length;
        const now = Date.now();
        if (now - lastDownloadEvent >= 500 || downloadedBytes >= remote.blob.size) {
          lastDownloadEvent = now;
          emit({
            type: "progress",
            stage: "download",
            progress: Math.min(1, downloadedBytes / remote.blob.size),
          });
        }
        callback(null, chunk);
      },
    });
    await pipeline(
      Readable.fromWeb(remote.stream as import("node:stream/web").ReadableStream),
      progress,
      createWriteStream(inputPath),
      { signal },
    );
    await remote.stream.cancel().catch(() => undefined);

    emit({ type: "progress", stage: "probe" });
    let sourceInfo: ProbeResult;
    try {
      sourceInfo = await probeVideo(binary, inputPath, signal);
    } catch {
      throw new ConversionError("unreadable", "I can't read that video. Please upload a MOV or MP4 video.");
    }

    emit({ type: "progress", stage: "convert", progress: 0 });
    let lastProgress = -1;
    let lastProgressAt = 0;
    let result: ResizeResult;
    try {
      result = await resizeVideo({
        binary,
        input: inputPath,
        output: outputPath,
        choice,
        duration: sourceInfo.duration,
        signal,
        onProgress(fraction) {
          const percentage = Math.floor(fraction * 100);
          const now = Date.now();
          if (percentage === lastProgress || (now - lastProgressAt < 500 && percentage < 100)) return;
          lastProgress = percentage;
          lastProgressAt = now;
          emit({ type: "progress", stage: "convert", progress: Math.max(0, Math.min(1, fraction)) });
        },
      });
    } catch (error) {
      if (signal.aborted) throw error;
      throw new ConversionError("convertFailed", "The conversion failed. Please try again with a different video.");
    }

    const outputBytes = (await stat(outputPath)).size;
    if (outputBytes > env.webMaxOutputMB * 1024 * 1024) {
      throw new ConversionError("outputTooLarge", `The converted file is over the ${env.webMaxOutputMB} MB output limit.`);
    }

    emit({ type: "progress", stage: "store", progress: 0 });
    const stored = await put(
      `${OUTPUT_PREFIX}${randomUUID()}/${outputName}`,
      createReadStream(outputPath),
      {
        access: "private",
        token: env.blobToken,
        abortSignal: signal,
        contentType: "video/mp4",
        cacheControlMaxAge: 60,
        multipart: outputBytes > 5 * 1024 * 1024,
      },
    );
    outputBlobUrl = stored.url;
    emit({ type: "progress", stage: "store", progress: 1 });

    const source: ConvertSource = {
      name: sourceName,
      bytes: remote.blob.size,
      ...(sourceInfo.width !== undefined ? { width: sourceInfo.width } : {}),
      ...(sourceInfo.height !== undefined ? { height: sourceInfo.height } : {}),
      ...(sourceInfo.duration !== undefined ? { duration: sourceInfo.duration } : {}),
    };
    const downloadUrl = downloadLink(stored.url, outputName, env);
    const inlineUrl = downloadLink(stored.url, outputName, env, true);
    emit({
      type: "complete",
      ok: true,
      job: {
        name: outputName,
        bytes: outputBytes,
        url: inlineUrl,
        downloadUrl,
        smaller: outputBytes < remote.blob.size,
        ...(result.width !== undefined ? { width: result.width } : {}),
        ...(result.height !== undefined ? { height: result.height } : {}),
        ...(result.duration !== undefined ? { duration: result.duration } : {}),
        source,
        choice: choiceBody(choice),
      },
    });
    outputBlobUrl = undefined; // The result stays in Blob until its signed link expires.
  } finally {
    await remote.stream.cancel().catch(() => undefined);
    await safeDelete(blobUrl, env);
    if (outputBlobUrl) await safeDelete(outputBlobUrl, env);
    if (dir) await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

/** Stream one conversion's download, ffmpeg, and Blob-store progress as NDJSON events. */
export async function* convertUpload(
  body: ConvertRequest,
  env: VercelEnv,
  options: { ffmpeg: () => string },
  clientSignal?: AbortSignal,
): AsyncGenerator<ConvertEvent> {
  const queue = new AsyncQueue<ConvertEvent>();
  const controller = new AbortController();
  let timedOut = false;
  let finished = false;
  const abortFromClient = () => controller.abort(clientSignal?.reason);
  clientSignal?.addEventListener("abort", abortFromClient, { once: true });
  if (clientSignal?.aborted) abortFromClient();
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort(new Error("Conversion time limit reached."));
  }, env.maxSeconds * 1000);
  timer.unref?.();

  const work = Promise.resolve()
    .then(() => convertWork(body, env, options.ffmpeg(), controller.signal, (event) => queue.push(event)))
    .catch((error) => queue.push(eventError(error, timedOut, controller.signal)))
    .finally(() => {
      finished = true;
      clearTimeout(timer);
      clientSignal?.removeEventListener("abort", abortFromClient);
      queue.close();
    });

  try {
    for await (const event of queue) yield event;
  } finally {
    if (!finished) controller.abort(new Error("Response closed."));
    await work.catch(() => undefined);
  }
}

/** Convert an AsyncIterable of events to a back-pressure-aware NDJSON Response. */
export function ndjsonResponse(events: AsyncIterable<ConvertEvent>, headers?: HeadersInit): Response {
  const iterator = events[Symbol.asyncIterator]();
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const item = await iterator.next();
        if (item.done) {
          controller.close();
          return;
        }
        controller.enqueue(encoder.encode(`${JSON.stringify(item.value)}\n`));
      } catch (error) {
        controller.enqueue(
          encoder.encode(
            `${JSON.stringify({ type: "error", ok: false, error: { code: "serverError", message: "The conversion failed." } })}\n`,
          ),
        );
        controller.close();
      }
    },
    async cancel() {
      await iterator.return?.();
    },
  });
  const responseHeaders = new Headers(headers);
  responseHeaders.set("content-type", "application/x-ndjson; charset=utf-8");
  responseHeaders.set("cache-control", "no-store, no-transform");
  responseHeaders.set("x-content-type-options", "nosniff");
  return new Response(stream, { status: 200, headers: responseHeaders });
}

/** Remove expired converter uploads and outputs. The Blob paths isolate this app from other store users. */
export async function cleanupBlobs(env: VercelEnv, now = Date.now()): Promise<number> {
  if (!env.blobToken) return 0;
  const cutoff = now - env.webJobTtlMinutes * 60 * 1000;
  let removed = 0;
  for (const prefix of [UPLOAD_PREFIX, OUTPUT_PREFIX]) {
    let cursor: string | undefined;
    do {
      const page = await list({
        prefix,
        limit: 1000,
        ...(cursor ? { cursor } : {}),
        token: env.blobToken,
      });
      const expired = page.blobs.filter((blob) => blob.uploadedAt.getTime() < cutoff).map((blob) => blob.url);
      if (expired.length) {
        await del(expired, { token: env.blobToken });
        removed += expired.length;
      }
      cursor = page.hasMore ? page.cursor : undefined;
    } while (cursor);
  }
  return removed;
}

/** Read a private converted Blob through a short-lived signed URL, including byte ranges for video previews. */
export async function serveDownload(request: Request, env: VercelEnv): Promise<Response> {
  const cors = corsHeaders(request, env.corsOrigin, "GET, HEAD, OPTIONS");
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response("Method not allowed", { status: 405, headers: { ...Object.fromEntries(cors), Allow: "GET, HEAD, OPTIONS" } });
  }
  if (!env.blobToken) return new Response("Storage unavailable", { status: 503, headers: cors });
  const secret = env.downloadSecret || env.blobToken;
  const token = new URL(request.url).searchParams.get("token") ?? "";
  const claims = verifyDownloadToken(token, secret);
  if (!claims) return new Response("This download link is invalid or has expired.", { status: 404, headers: cors });

  let metadata;
  try {
    metadata = await head(claims.url, { token: env.blobToken, abortSignal: request.signal });
  } catch {
    return new Response("This download is no longer available.", { status: 404, headers: cors });
  }
  if (!metadata.pathname.startsWith(OUTPUT_PREFIX)) {
    return new Response("This download is no longer available.", { status: 404, headers: cors });
  }

  const rangeHeader = request.headers.get("range");
  const range = rangeHeader ? parseByteRange(rangeHeader, metadata.size) : undefined;
  if (rangeHeader && !range) {
    const headers = new Headers(cors);
    headers.set("accept-ranges", "bytes");
    headers.set("content-range", `bytes */${metadata.size}`);
    return new Response(null, { status: 416, headers });
  }
  const start = range?.start;
  const end = range?.end;
  const length = range ? end! - start! + 1 : metadata.size;
  const headers = new Headers(cors);
  headers.set("content-type", "video/mp4");
  headers.set("content-length", String(length));
  headers.set("accept-ranges", "bytes");
  headers.set("cache-control", "private, no-store");
  headers.set("x-content-type-options", "nosniff");
  headers.set("referrer-policy", "no-referrer");
  headers.set(
    "content-disposition",
    contentDisposition(claims.name, new URL(request.url).searchParams.get("inline") === "1"),
  );
  if (range) headers.set("content-range", `bytes ${start}-${end}/${metadata.size}`);
  if (request.method === "HEAD") return new Response(null, { status: range ? 206 : 200, headers });

  try {
    const result = await get(claims.url, {
      access: "private",
      token: env.blobToken,
      useCache: false,
      abortSignal: request.signal,
      ...(range ? { headers: { range: `bytes=${start}-${end}` } } : {}),
    });
    if (!result || result.statusCode !== 200 || !result.stream) {
      return new Response("This download is no longer available.", { status: 404, headers: cors });
    }
    return new Response(result.stream, { status: range ? 206 : 200, headers });
  } catch {
    return new Response("This download is no longer available.", { status: 404, headers: cors });
  }
}

export function parseByteRange(header: string, size: number): { start: number; end: number } | null {
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match || size < 1) return null;
  const rawStart = match[1] ?? "";
  const rawEnd = match[2] ?? "";
  if (!rawStart && !rawEnd) return null;
  let start: number;
  let end: number;
  if (!rawStart) {
    const suffix = Number(rawEnd);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return null;
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(rawStart);
    end = rawEnd ? Number(rawEnd) : size - 1;
  }
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start >= size || end < start) {
    return null;
  }
  return { start, end: Math.min(end, size - 1) };
}

function contentDisposition(name: string, inline: boolean): string {
  const safe = name.replace(/[\r\n"\\]/g, "_");
  return `${inline ? "inline" : "attachment"}; filename="${safe}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}
