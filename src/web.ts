/**
 * The web conversion API.
 *
 * This is the same ffmpeg pipeline the Telegram bot uses, exposed over plain
 * HTTP so a browser can upload a video straight from the phone's gallery:
 *
 *   GET    /api/config              presets and limits for the UI
 *   POST   /api/convert             multipart upload; starts a job, returns it
 *   GET    /api/jobs/:id            job status, progress and real file sizes
 *   GET    /api/jobs/:id/download   the converted MP4 (supports byte ranges)
 *   DELETE /api/jobs/:id            cancel a job and delete its files
 *
 * Jobs live in memory and their files live in a temporary directory that is
 * deleted on completion + TTL, on cancellation, and on shutdown.
 */

import { createReadStream } from "node:fs";
import { mkdtemp, open, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { applyCors, sendError, sendJson } from "./cors.js";
import { CancelledError, probeVideo, resizeVideo } from "./ffmpeg.js";
import { MalformedMultipartError, PayloadTooLargeError, parseBoundary, readMultipart } from "./multipart.js";
import { outputFileName } from "./paths.js";
import { Semaphore } from "./semaphore.js";
import {
  PRESETS,
  findPreset,
  parseCustomSize,
  presetChoice,
  type SizeChoice,
} from "./sizes.js";

export type JobState = "queued" | "converting" | "done" | "error" | "cancelled";

export type PublicJob = {
  id: string;
  state: JobState;
  progress: number;
  createdAt: number;
  updatedAt: number;
  source: {
    name: string;
    bytes: number;
    width?: number;
    height?: number;
    duration?: number;
  };
  choice: { kind: "preset" | "custom"; key?: string; label: string; width?: number; height?: number };
  output?: {
    name: string;
    bytes: number;
    width?: number;
    height?: number;
    smaller: boolean;
    /** Relative download URL; the UI prefixes it with the bot server address. */
    url: string;
  };
  error?: { code: string; message: string };
};

type Job = {
  id: string;
  state: JobState;
  progress: number;
  createdAt: number;
  updatedAt: number;
  dir: string;
  input: string;
  output?: string;
  sourceName: string;
  sourceBytes: number;
  sourceWidth?: number;
  sourceHeight?: number;
  duration?: number;
  choice: SizeChoice;
  outputBytes?: number;
  outputWidth?: number;
  outputHeight?: number;
  error?: { code: string; message: string };
  controller: AbortController;
};

export type ConvertApiLimits = {
  /** Largest accepted upload, in MB. */
  maxUploadMB: number;
  allowCustom: boolean;
  maxDimension: number;
  maxConcurrentJobs: number;
  /** How long a finished job and its file stay downloadable, in minutes. */
  jobTtlMinutes: number;
};

export type ConvertApiOptions = {
  limits: ConvertApiLimits;
  /** "*" or a comma-separated origin list; see config.ts. */
  corsOrigin: string;
  ffmpeg: string;
  /** Optional shared secret; when set every request must present it. */
  apiKey?: string;
  /** Where job folders are created. Defaults to the system temp directory. */
  workRoot?: string;
  /** Injectable clock, used by tests. */
  now?: () => number;
};

const SUPPORTED_EXT = /\.(mov|mp4|m4v)$/i;
const SUPPORTED_MIME = new Set([
  "video/mp4",
  "video/quicktime",
  "video/x-m4v",
  "video/x-matroska",
  "video/webm",
]);

/** Absolute age after which even a still-running job is torn down. */
const HARD_AGE_MS = 6 * 60 * 60 * 1000;

export function isSupportedUpload(filename: string, contentType: string): boolean {
  const type = contentType.split(";")[0]?.trim().toLowerCase() ?? "";
  return SUPPORTED_EXT.test(filename) || SUPPORTED_MIME.has(type);
}

export type ChoiceResult =
  | { ok: true; choice: SizeChoice }
  | { ok: false; code: "badPreset" | "badDimensions" | "customDisabled"; message: string };

/**
 * Turns the uploaded form fields into a size choice. Either `preset=smaller`
 * or `width=720&height=1280`.
 */
export function resolveChoice(
  fields: Record<string, string>,
  options: { allowCustom: boolean; maxDimension: number },
): ChoiceResult {
  const width = fields.width?.trim();
  const height = fields.height?.trim();
  if (width || height) {
    if (!options.allowCustom) {
      return {
        ok: false,
        code: "customDisabled",
        message: "Custom dimensions are turned off on this server.",
      };
    }
    const parsed = parseCustomSize(`${width ?? ""} x ${height ?? ""}`, options.maxDimension);
    if (!parsed.ok) {
      return {
        ok: false,
        code: "badDimensions",
        message:
          parsed.reason === "tooLarge"
            ? `Those dimensions are above this server's ${options.maxDimension} pixel limit.`
            : "Enter a width and height in pixels, like 720 x 1280.",
      };
    }
    return { ok: true, choice: parsed.choice };
  }

  const key = (fields.preset ?? "balanced").trim();
  const preset = findPreset(key);
  if (!preset) {
    return {
      ok: false,
      code: "badPreset",
      message: `Unknown size option "${key}". Use one of: ${PRESETS.map((p) => p.key).join(", ")}.`,
    };
  }
  return { ok: true, choice: presetChoice(preset) };
}

function toPublicJob(job: Job): PublicJob {
  const smaller = job.outputBytes !== undefined && job.outputBytes < job.sourceBytes;
  return {
    id: job.id,
    state: job.state,
    progress: job.progress,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    source: {
      name: job.sourceName,
      bytes: job.sourceBytes,
      ...(job.sourceWidth !== undefined ? { width: job.sourceWidth } : {}),
      ...(job.sourceHeight !== undefined ? { height: job.sourceHeight } : {}),
      ...(job.duration !== undefined ? { duration: job.duration } : {}),
    },
    choice:
      job.choice.kind === "custom"
        ? {
            kind: "custom",
            label: job.choice.label,
            width: job.choice.width,
            height: job.choice.height,
          }
        : { kind: "preset", key: job.choice.key, label: job.choice.label },
    ...(job.outputBytes !== undefined
      ? {
          output: {
            name: outputFileName(job.sourceName, job.choice),
            bytes: job.outputBytes,
            ...(job.outputWidth !== undefined ? { width: job.outputWidth } : {}),
            ...(job.outputHeight !== undefined ? { height: job.outputHeight } : {}),
            smaller,
            url: `/api/jobs/${job.id}/download`,
          },
        }
      : {}),
    ...(job.error ? { error: job.error } : {}),
  };
}

/** Parses "bytes=100-200" (either side optional). Returns null when unusable. */
export function parseRange(header: string, size: number): { start: number; end: number } | null {
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) return null;
  const rawStart = match[1];
  const rawEnd = match[2];
  let start: number;
  let end: number;
  if (rawStart === "" && rawEnd === "") return null;
  if (rawStart === "") {
    const suffix = Number(rawEnd);
    if (!Number.isFinite(suffix) || suffix <= 0) return null;
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(rawStart);
    end = rawEnd === "" ? size - 1 : Number(rawEnd);
  }
  if (!Number.isInteger(start) || !Number.isInteger(end)) return null;
  if (start < 0 || start >= size || end < start) return null;
  return { start, end: Math.min(end, size - 1) };
}

export type ConvertApi = {
  /** Returns true when the request belonged to this API and was handled. */
  handle: (req: IncomingMessage, res: ServerResponse, url: URL) => boolean;
  stats: () => { running: number; queued: number; jobs: number };
  shutdown: () => Promise<void>;
};

export function createConvertApi(options: ConvertApiOptions): ConvertApi {
  const { limits, ffmpeg } = options;
  const now = options.now ?? (() => Date.now());
  const workRoot = options.workRoot ?? tmpdir();
  const jobs = new Semaphore(limits.maxConcurrentJobs);
  const store = new Map<string, Job>();
  const maxUploadBytes = Math.round(limits.maxUploadMB * 1024 * 1024);

  const touch = (job: Job) => {
    job.updatedAt = now();
  };

  const discard = async (job: Job) => {
    store.delete(job.id);
    await rm(job.dir, { recursive: true, force: true }).catch(() => undefined);
  };

  const fail = (job: Job, code: string, message: string) => {
    job.state = "error";
    job.error = { code, message };
    job.progress = 0;
    touch(job);
    // Delete the files, but keep the record so the caller can read the reason;
    // the TTL sweep removes it later.
    void rm(job.dir, { recursive: true, force: true }).catch(() => undefined);
  };

  const run = async (job: Job) => {
    let release: (() => void) | undefined;
    try {
      release = await jobs.acquire(job.controller.signal);
      if (job.controller.signal.aborted) throw new CancelledError();
      job.state = "converting";
      touch(job);

      const info = await resizeVideo({
        binary: ffmpeg,
        input: job.input,
        output: job.output!,
        choice: job.choice,
        duration: job.duration,
        signal: job.controller.signal,
        onProgress: (fraction) => {
          job.progress = Math.max(0, Math.min(1, fraction));
          touch(job);
        },
      });

      const size = await stat(job.output!);
      job.outputBytes = size.size;
      job.outputWidth = info.width;
      job.outputHeight = info.height;
      job.progress = 1;
      job.state = "done";
      touch(job);
    } catch (error) {
      if (job.controller.signal.aborted || error instanceof CancelledError) {
        job.state = "cancelled";
        job.progress = 0;
        touch(job);
        await discard(job).catch(() => undefined);
        return;
      }
      console.error(`Web conversion ${job.id} failed:`, error);
      fail(job, "convertFailed", "The conversion failed. The original is unchanged; please try again.");
    } finally {
      release?.();
    }
  };

  /* ---------- request handlers ---------- */

  const authorized = (req: IncomingMessage, url: URL): boolean => {
    if (!options.apiKey) return true;
    const header = req.headers["x-api-key"] ?? req.headers.authorization?.replace(/^Bearer\s+/i, "");
    const presented = (typeof header === "string" ? header : "") || url.searchParams.get("key") || "";
    return presented === options.apiKey;
  };

  const sendConfig = (res: ServerResponse) => {
    sendJson(res, 200, {
      ok: true,
      limits: {
        maxUploadMB: limits.maxUploadMB,
        allowCustom: limits.allowCustom,
        maxDimension: limits.maxDimension,
        maxConcurrentJobs: limits.maxConcurrentJobs,
        jobTtlMinutes: limits.jobTtlMinutes,
      },
      presets: PRESETS.map((preset) => ({
        key: preset.key,
        label: preset.label,
        detail: preset.detail,
        shortSide: preset.shortSide,
      })),
      accepts: ["MOV", "MP4", "M4V"],
    });
  };

  const handleConvert = async (req: IncomingMessage, res: ServerResponse) => {
    const boundary = parseBoundary(req.headers["content-type"]);
    if (!boundary) {
      sendError(res, 415, "badRequest", "Send the video as multipart/form-data with a \"video\" field.");
      return;
    }
    const declared = Number(req.headers["content-length"] ?? 0);
    if (declared > maxUploadBytes) {
      sendError(res, 413, "tooLarge", `That video is over the ${limits.maxUploadMB} MB limit.`);
      return;
    }

    const dir = await mkdtemp(path.join(workRoot, "sendable-web-"));
    let stored: { name: string; path: string } | undefined;

    const removeUpload = async () => {
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    };

    try {
      const result = await readMultipart(req, boundary, {
        maxBytes: maxUploadBytes,
        openFile: async (info) => {
          if (stored) throw new MalformedMultipartError("Send one video at a time.");
          if (!isSupportedUpload(info.filename, info.contentType)) {
            throw new MalformedMultipartError("unsupported");
          }
          const target = path.join(dir, `input${path.extname(info.filename).toLowerCase() || ".mov"}`);
          const handle = await open(target, "w");
          stored = { name: info.filename, path: target };
          let position = 0;
          return {
            path: target,
            write: async (chunk) => {
              // Four arguments: buffer, buffer offset, length, file position.
              await handle.write(chunk, 0, chunk.length, position);
              position += chunk.length;
            },
            close: async () => {
              await handle.close().catch(() => undefined);
            },
          };
        },
      });

      const file = result.files[0];
      if (!file || !stored) {
        await removeUpload();
        sendError(res, 400, "noVideo", "Add a video file to the \"video\" field and try again.");
        return;
      }
      if (file.bytes === 0) {
        await removeUpload();
        sendError(res, 400, "emptyFile", "That file has no data in it. Please try again.");
        return;
      }
      const choice = resolveChoice(result.fields, {
        allowCustom: limits.allowCustom,
        maxDimension: limits.maxDimension,
      });
      if (!choice.ok) {
        await removeUpload();
        sendError(res, 400, choice.code, choice.message);
        return;
      }

      let probed;
      try {
        probed = await probeVideo(ffmpeg, file.path);
      } catch (error) {
        await removeUpload();
        console.error("Probe failed:", error);
        sendError(res, 422, "unreadable", "I can't read that video. Please send a MOV or MP4 file.");
        return;
      }

      const output = path.join(dir, outputFileName(stored.name, choice.choice));
      const job: Job = {
        id: randomUUID(),
        state: "queued",
        progress: 0,
        createdAt: now(),
        updatedAt: now(),
        dir,
        input: file.path,
        output,
        sourceName: stored.name,
        sourceBytes: file.bytes,
        sourceWidth: probed.width,
        sourceHeight: probed.height,
        duration: probed.duration,
        choice: choice.choice,
        controller: new AbortController(),
      };
      store.set(job.id, job);
      // Fire and forget: the client polls /api/jobs/:id for progress.
      void run(job);

      sendJson(res, 202, {
        ok: true,
        job: toPublicJob(job),
        queuePosition: jobs.queued,
      });
    } catch (error) {
      await removeUpload();
      if (res.headersSent) {
        res.destroy();
        return;
      }
      if (error instanceof PayloadTooLargeError) {
        sendError(res, 413, "tooLarge", `That video is over the ${limits.maxUploadMB} MB limit.`);
        return;
      }
      if (error instanceof MalformedMultipartError && error.message === "unsupported") {
        sendError(res, 415, "unsupported", "I can't read that file type. Please send a MOV or MP4 video.");
        return;
      }
      if (error instanceof MalformedMultipartError && error.message === "Send one video at a time.") {
        sendError(res, 400, "oneVideo", "Send one video at a time.");
        return;
      }
      sendError(res, 400, "badRequest", "The upload didn't finish. Check the connection and try again.");
    }
  };

  const sendJob = (res: ServerResponse, job: Job) => sendJson(res, 200, { ok: true, job: toPublicJob(job) });

  const streamOutput = (req: IncomingMessage, res: ServerResponse, job: Job, inline: boolean) => {
    const output = job.output;
    if (job.state !== "done" || !output || job.outputBytes === undefined) {
      sendError(res, 409, "notReady", "That conversion isn't finished yet.");
      return;
    }
    const size = job.outputBytes;
    const name = outputFileName(job.sourceName, job.choice);
    const disposition = inline ? "inline" : "attachment";
    const headers: Record<string, string | number> = {
      "content-type": "video/mp4",
      "content-disposition": `${disposition}; filename="${name.replace(/["\\]/g, "_")}"; filename*=UTF-8''${encodeURIComponent(name)}`,
      "accept-ranges": "bytes",
      "cache-control": "private, no-store",
    };

    const range = req.headers.range ? parseRange(req.headers.range, size) : null;
    if (req.headers.range && !range) {
      res.writeHead(416, { ...headers, "content-range": `bytes */${size}` });
      res.end();
      return;
    }

    if (range) {
      const length = range.end - range.start + 1;
      res.writeHead(206, {
        ...headers,
        "content-length": length,
        "content-range": `bytes ${range.start}-${range.end}/${size}`,
      });
      if (req.method === "HEAD") return res.end();
      createReadStream(output, { start: range.start, end: range.end }).pipe(res);
      return;
    }

    res.writeHead(200, { ...headers, "content-length": size });
    if (req.method === "HEAD") return res.end();
    createReadStream(output).pipe(res);
  };

  /* ---------- router ---------- */

  const handle = (req: IncomingMessage, res: ServerResponse, url: URL): boolean => {
    if (!url.pathname.startsWith("/api/")) return false;

    applyCors(req, res, options.corsOrigin, "GET, POST, DELETE, OPTIONS");
    if (req.method === "OPTIONS") {
      res.writeHead(204).end();
      return true;
    }

    if (url.pathname === "/api/config") {
      if (req.method !== "GET") {
        sendError(res, 405, "badMethod", "Use GET.");
        return true;
      }
      sendConfig(res);
      return true;
    }

    if (url.pathname === "/api/convert") {
      if (req.method !== "POST") {
        sendError(res, 405, "badMethod", "Use POST with a multipart form.");
        return true;
      }
      if (!authorized(req, url)) {
        sendError(res, 401, "unauthorized", "This server needs an API key for that request.");
        return true;
      }
      void handleConvert(req, res).catch((error) => {
        console.error("Conversion request failed:", error);
        if (!res.headersSent) sendError(res, 500, "serverError", "Something went wrong. Please try again.");
      });
      return true;
    }

    const jobMatch = /^\/api\/jobs\/([^/]+)(\/download)?$/.exec(url.pathname);
    if (!jobMatch) {
      sendError(res, 404, "notFound", "Unknown endpoint.");
      return true;
    }
    const id = jobMatch[1] ?? "";
    if (!/^[0-9a-f-]{8,64}$/i.test(id)) {
      sendError(res, 404, "expired", "That conversion has expired. Please upload the video again.");
      return true;
    }
    if (!authorized(req, url)) {
      sendError(res, 401, "unauthorized", "This server needs an API key for that request.");
      return true;
    }
    const job = store.get(id);
    if (!job) {
      sendError(res, 404, "expired", "That conversion has expired. Please upload the video again.");
      return true;
    }
    const wantsDownload = Boolean(jobMatch[2]);

    if (wantsDownload) {
      if (req.method !== "GET" && req.method !== "HEAD") {
        sendError(res, 405, "badMethod", "Use GET.");
        return true;
      }
      streamOutput(req, res, job, url.searchParams.get("inline") === "1");
      return true;
    }

    if (req.method === "GET") {
      sendJob(res, job);
      return true;
    }
    if (req.method === "DELETE") {
      job.controller.abort();
      job.state = "cancelled";
      touch(job);
      void discard(job).catch(() => undefined);
      sendJson(res, 200, { ok: true, cancelled: true });
      return true;
    }
    sendError(res, 405, "badMethod", "Use GET or DELETE.");
    return true;
  };

  /* ---------- lifecycle ---------- */

  const ttlMs = limits.jobTtlMinutes * 60 * 1000;
  const sweep = setInterval(() => {
    const cutoff = now();
    for (const job of store.values()) {
      const finished = job.state === "done" || job.state === "error" || job.state === "cancelled";
      if ((finished && cutoff - job.updatedAt > ttlMs) || cutoff - job.createdAt > HARD_AGE_MS) {
        job.controller.abort();
        void discard(job).catch(() => undefined);
      }
    }
  }, 60 * 1000);
  sweep.unref();

  const shutdown = async () => {
    clearInterval(sweep);
    for (const job of store.values()) job.controller.abort();
    for (const job of [...store.values()]) await discard(job).catch(() => undefined);
  };

  return {
    handle,
    stats: () => ({ running: jobs.running, queued: jobs.queued, jobs: store.size }),
    shutdown,
  };
}
