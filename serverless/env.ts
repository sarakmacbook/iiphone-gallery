const DEFAULT_TELEGRAM_API_ROOT = "https://api.telegram.org";

type Source = Record<string, string | undefined>;

export type VercelEnv = {
  token?: string;
  telegramApiRoot: string;
  webhookSecret?: string;
  setupSecret?: string;
  publicUrl?: string;
  corsOrigin: string;
  loginMaxAgeSeconds: number;
  loginGreeting: boolean;
  webConvert: boolean;
  webApiKey?: string;
  blobToken?: string;
  downloadSecret?: string;
  webMaxUploadMB: number;
  webMaxOutputMB: number;
  webJobTtlMinutes: number;
  maxDimension: number;
  allowCustom: boolean;
  maxSeconds: number;
  maxTelegramUploadMB: number;
  maxTelegramOutputMB: number;
  cronSecret?: string;
  ffmpegPath?: string;
};

function readNumber(source: Source, name: string, fallback: number, min: number, max: number): number {
  const raw = source[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < min || value > max) {
    throw new Error(`${name} must be a number between ${min} and ${max}.`);
  }
  return value;
}

function readBoolean(source: Source, name: string, fallback: boolean): boolean {
  const raw = source[name]?.trim().toLowerCase();
  if (!raw) return fallback;
  if (["1", "true", "yes", "on"].includes(raw)) return true;
  if (["0", "false", "no", "off"].includes(raw)) return false;
  throw new Error(`${name} must be true or false.`);
}

function normalizedUrl(input: string | undefined): string | undefined {
  if (!input?.trim()) return undefined;
  const value = input.trim();
  const candidate = value.includes("://") ? value : `https://${value}`;
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    throw new Error("PUBLIC_URL must be a valid HTTPS URL, such as https://sendable.vercel.app.");
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash ||
    candidate.includes("?") ||
    candidate.includes("#")
  ) {
    throw new Error("PUBLIC_URL must be a plain HTTPS origin with no credentials, path, query, or fragment.");
  }
  return url.origin;
}

function readCorsOrigin(source: Source): string {
  const entries = (source.CORS_ORIGIN?.split(",") ?? []).map((entry) => entry.trim()).filter(Boolean);
  if (!entries.length) return "*";
  const normalized: string[] = [];
  for (const origin of entries) {
    if (origin === "*") {
      normalized.push(origin);
      continue;
    }
    try {
      const url = new URL(origin);
      if (
        (url.protocol !== "http:" && url.protocol !== "https:") ||
        !url.hostname ||
        url.username ||
        url.password ||
        url.pathname !== "/" ||
        url.search ||
        url.hash ||
        origin.includes("?") ||
        origin.includes("#")
      ) {
        throw new Error();
      }
      normalized.push(url.origin);
    } catch {
      throw new Error(`CORS_ORIGIN entries must be "*" or a plain HTTP(S) origin (got "${origin}").`);
    }
  }
  return [...new Set(normalized)].join(",");
}

function vercelOrigin(source: Source): string | undefined {
  const explicit = normalizedUrl(source.PUBLIC_URL);
  if (explicit) return explicit;
  // Never register a Telegram webhook on a preview deployment.
  const production = source.VERCEL_PROJECT_PRODUCTION_URL?.trim();
  if (production) return normalizedUrl(production);
  if (source.VERCEL_ENV?.trim().toLowerCase() === "production") return normalizedUrl(source.VERCEL_URL);
  return undefined;
}

/** Read and validate serverless settings on each request so local env changes take effect. */
export function loadVercelEnv(source: Source = process.env): VercelEnv {
  const rawToken = source.TELEGRAM_BOT_TOKEN?.trim();
  const token = rawToken || undefined;
  if (token && !/^\d+:[\w-]{30,}$/.test(token)) {
    throw new Error("TELEGRAM_BOT_TOKEN doesn't look like a token from @BotFather.");
  }

  const telegramApiRoot = (source.TELEGRAM_API_ROOT?.trim() || DEFAULT_TELEGRAM_API_ROOT).replace(/\/+$/, "");
  let apiUrl: URL;
  try {
    apiUrl = new URL(telegramApiRoot);
  } catch {
    throw new Error("TELEGRAM_API_ROOT must be a valid URL.");
  }
  if (apiUrl.protocol !== "https:" && apiUrl.hostname !== "localhost" && apiUrl.hostname !== "127.0.0.1") {
    throw new Error("TELEGRAM_API_ROOT must use HTTPS outside local development.");
  }

  const webMaxUploadMB = readNumber(source, "WEB_MAX_UPLOAD_MB", 100, 1, 200);
  const webMaxOutputMB = readNumber(source, "WEB_MAX_OUTPUT_MB", 100, 1, 200);
  const webJobTtlMinutes = readNumber(source, "WEB_JOB_TTL_MINUTES", 60, 1, 1440);
  const maxSeconds = readNumber(source, "WEB_MAX_SECONDS", 50, 5, 300);
  const maxDimension = readNumber(source, "MAX_DIMENSION", 3840, 16, 8192);
  const maxTelegramUploadMB = readNumber(source, "MAX_UPLOAD_MB", 20, 1, 20);
  const maxTelegramOutputMB = readNumber(source, "MAX_OUTPUT_MB", 50, 1, 50);
  const webhookSecret = source.TELEGRAM_WEBHOOK_SECRET?.trim() || source.WEBHOOK_SECRET?.trim() || undefined;
  if (webhookSecret && !/^[A-Za-z0-9_-]{1,256}$/.test(webhookSecret)) {
    throw new Error("TELEGRAM_WEBHOOK_SECRET must contain 1–256 letters, numbers, underscores, or hyphens.");
  }

  return {
    token,
    telegramApiRoot,
    webhookSecret,
    setupSecret: source.TELEGRAM_SETUP_SECRET?.trim() || undefined,
    publicUrl: vercelOrigin(source),
    corsOrigin: readCorsOrigin(source),
    loginMaxAgeSeconds: readNumber(source, "LOGIN_MAX_AGE_SECONDS", 86400, 60, 604800),
    loginGreeting: readBoolean(source, "LOGIN_GREETING", true),
    webConvert: readBoolean(source, "WEB_CONVERT", true),
    webApiKey: source.WEB_API_KEY?.trim() || undefined,
    blobToken: source.BLOB_READ_WRITE_TOKEN?.trim() || undefined,
    downloadSecret: source.DOWNLOAD_SIGNING_SECRET?.trim() || undefined,
    webMaxUploadMB,
    webMaxOutputMB,
    webJobTtlMinutes,
    maxDimension,
    allowCustom: readBoolean(source, "ALLOW_CUSTOM", true),
    maxSeconds,
    maxTelegramUploadMB,
    maxTelegramOutputMB,
    cronSecret: source.CRON_SECRET?.trim() || undefined,
    ffmpegPath: source.FFMPEG_PATH?.trim() || undefined,
  };
}
