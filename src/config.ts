/**
 * Every setting comes from an environment variable, so the same build can run
 * anywhere. See bot/.env.example for the full list.
 */

import { normalizeArchiveChatId } from "./archive.js";

const DEFAULT_API_ROOT = "https://api.telegram.org";

function readNumber(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < min || value > max) {
    throw new Error(`${name} must be a number between ${min} and ${max} (got "${raw}").`);
  }
  return value;
}

function readBoolean(name: string, fallback: boolean): boolean {
  const raw = process.env[name]?.trim().toLowerCase();
  if (!raw) return fallback;
  if (["1", "true", "yes", "on"].includes(raw)) return true;
  if (["0", "false", "no", "off"].includes(raw)) return false;
  throw new Error(`${name} must be true or false (got "${raw}").`);
}

export type Config = {
  token: string;
  /** False when the server runs the web API only, with no Telegram bot. */
  telegramEnabled: boolean;
  apiRoot: string;
  /** True when TELEGRAM_API_ROOT points at a self-hosted Bot API server. */
  localApi: boolean;
  maxUploadMB: number;
  maxOutputMB: number;
  maxDimension: number;
  allowCustom: boolean;
  maxConcurrentJobs: number;
  ffmpegPath?: string;
  webhookUrl?: string;
  webhookPath: string;
  webhookSecret?: string;
  port: number;
  /** "*", or a comma-separated list of website origins allowed to call the login endpoint. */
  corsOrigin: string;
  /** How long a Telegram Login Widget payload stays acceptable, in seconds. */
  loginMaxAgeSeconds: number;
  /** Send a "you signed in on the website" message in Telegram after a verified sign-in. */
  loginGreeting: boolean;
  /** Optional Telegram channel where completed, smaller copies are kept. */
  archiveChatId?: string;
  /** Require an explicit opt-in before writing to a public archive channel. */
  archiveAllowPublic: boolean;
  /** Serve the browser conversion API (GET /api/config, POST /api/convert, ...). */
  webConvert: boolean;
  /** Largest video the browser may upload, in MB. */
  webMaxUploadMB: number;
  /** How long a finished conversion stays downloadable, in minutes. */
  webJobTtlMinutes: number;
  /** Optional shared secret for the web API. Empty means open. */
  webApiKey?: string;
};

export function loadConfig(): Config {
  const token = process.env.TELEGRAM_BOT_TOKEN?.trim() ?? "";
  // WEB_ONLY=true runs the browser conversion API without a Telegram bot, which
  // is handy for local testing and for hosts that only serve the website.
  const webOnly = readBoolean("WEB_ONLY", false);
  if (!token && !webOnly) {
    throw new Error(
      "TELEGRAM_BOT_TOKEN is missing. Create a bot with @BotFather, then set the token in bot/.env or your host's environment settings. " +
        "To run just the website's conversion API without Telegram, set WEB_ONLY=true.",
    );
  }
  if (token && !/^\d+:[\w-]{30,}$/.test(token)) {
    throw new Error("TELEGRAM_BOT_TOKEN doesn't look like a token from @BotFather (expected 123456:ABC...).");
  }

  const apiRoot = (process.env.TELEGRAM_API_ROOT?.trim() || DEFAULT_API_ROOT).replace(/\/+$/, "");
  const localApi = apiRoot !== DEFAULT_API_ROOT;

  // Telegram's hosted Bot API only lets bots download files up to 20 MB and
  // upload files up to 50 MB. A self-hosted Bot API server raises both to 2000 MB.
  const downloadCap = localApi ? 2000 : 20;
  const uploadCap = localApi ? 2000 : 50;

  const maxUploadMB = readNumber("MAX_UPLOAD_MB", downloadCap, 1, 2000);
  if (maxUploadMB > downloadCap) {
    throw new Error(
      `MAX_UPLOAD_MB is ${maxUploadMB}, but Telegram's hosted Bot API only lets bots download files up to ${downloadCap} MB. ` +
        "Lower MAX_UPLOAD_MB, or run your own Bot API server and set TELEGRAM_API_ROOT.",
    );
  }

  const webhookUrl = process.env.WEBHOOK_URL?.trim().replace(/\/+$/, "") || undefined;
  if (webhookUrl && !webhookUrl.startsWith("https://")) {
    throw new Error("WEBHOOK_URL must start with https:// (Telegram only sends webhooks over HTTPS).");
  }

  const corsOrigin = (process.env.CORS_ORIGIN?.trim() || "*").replace(/\s+/g, "");
  for (const origin of corsOrigin.split(",").filter(Boolean)) {
    if (origin !== "*" && !/^https?:\/\/[^/]+$/i.test(origin)) {
      throw new Error(
        `CORS_ORIGIN entries must be "*" or a plain origin like https://sendable.vercel.app (got "${origin}").`,
      );
    }
  }

  const webMaxUploadMB = readNumber("WEB_MAX_UPLOAD_MB", 200, 1, 2000);

  return {
    token,
    telegramEnabled: Boolean(token),
    apiRoot,
    localApi,
    maxUploadMB,
    maxOutputMB: uploadCap,
    maxDimension: readNumber("MAX_DIMENSION", 3840, 16, 8192),
    allowCustom: readBoolean("ALLOW_CUSTOM", true),
    maxConcurrentJobs: readNumber("MAX_CONCURRENT_JOBS", 2, 1, 32),
    ffmpegPath: process.env.FFMPEG_PATH?.trim() || undefined,
    webhookUrl,
    webhookPath: process.env.WEBHOOK_PATH?.trim() || "/telegram/webhook",
    webhookSecret: process.env.WEBHOOK_SECRET?.trim() || undefined,
    port: readNumber("PORT", 8080, 1, 65535),
    corsOrigin,
    loginMaxAgeSeconds: readNumber("LOGIN_MAX_AGE_SECONDS", 86400, 60, 604800),
    loginGreeting: readBoolean("LOGIN_GREETING", true),
    archiveChatId: normalizeArchiveChatId(process.env.TELEGRAM_ARCHIVE_CHAT_ID),
    archiveAllowPublic: readBoolean("TELEGRAM_ARCHIVE_ALLOW_PUBLIC", false),
    webConvert: readBoolean("WEB_CONVERT", true),
    webMaxUploadMB,
    webJobTtlMinutes: readNumber("WEB_JOB_TTL_MINUTES", 60, 1, 1440),
    webApiKey: process.env.WEB_API_KEY?.trim() || undefined,
  };
}

export type Mp4BotConfig = {
  token: string;
  apiRoot: string;
  /** True when TELEGRAM_API_ROOT points at a self-hosted Bot API server. */
  localApi: boolean;
  /** Largest video the MP4 bot will download, in MB. */
  maxUploadMB: number;
  /** Largest MP4 the MP4 bot will send back, in MB. */
  maxOutputMB: number;
  maxConcurrentJobs: number;
  ffmpegPath?: string;
};

/**
 * Settings for the MP4 converter bot (src/mp4-index.ts). It has its own token,
 * so it can run next to the Sendable bot. Shares TELEGRAM_API_ROOT, FFMPEG_PATH
 * and the Telegram size limits with the main bot.
 */
export function loadMp4BotConfig(): Mp4BotConfig {
  const token = process.env.MP4_BOT_TOKEN?.trim() ?? "";
  if (!token) {
    throw new Error(
      "MP4_BOT_TOKEN is missing. Create a second bot with @BotFather (/newbot) and set its token in bot/.env as MP4_BOT_TOKEN.",
    );
  }
  if (!/^\d+:[\w-]{30,}$/.test(token)) {
    throw new Error("MP4_BOT_TOKEN doesn't look like a token from @BotFather (expected 123456:ABC...).");
  }

  const apiRoot = (process.env.TELEGRAM_API_ROOT?.trim() || DEFAULT_API_ROOT).replace(/\/+$/, "");
  const localApi = apiRoot !== DEFAULT_API_ROOT;
  const downloadCap = localApi ? 2000 : 20;
  const uploadCap = localApi ? 2000 : 50;

  const maxUploadMB = readNumber("MP4_MAX_UPLOAD_MB", downloadCap, 1, 2000);
  if (maxUploadMB > downloadCap) {
    throw new Error(
      `MP4_MAX_UPLOAD_MB is ${maxUploadMB}, but Telegram's hosted Bot API only lets bots download files up to ${downloadCap} MB. ` +
        "Lower it, or run your own Bot API server and set TELEGRAM_API_ROOT.",
    );
  }

  return {
    token,
    apiRoot,
    localApi,
    maxUploadMB,
    maxOutputMB: uploadCap,
    maxConcurrentJobs: readNumber("MP4_MAX_CONCURRENT_JOBS", 2, 1, 32),
    ffmpegPath: process.env.FFMPEG_PATH?.trim() || undefined,
  };
}
