/**
 * Telegram Login Widget verification.
 *
 * The website embeds Telegram's official Login Widget. When someone signs in,
 * the widget hands the browser a payload (id, first_name, ..., auth_date, hash).
 * The browser POSTs that payload here, and this module proves it really came
 * from Telegram using the algorithm from https://core.telegram.org/widgets/login:
 *
 *   secret_key      = SHA256(bot_token)                      (raw bytes)
 *   data_check_string = "key=value" lines of every field except `hash`,
 *                       sorted alphabetically, joined with "\n"
 *   valid           = hex(HMAC_SHA256(data_check_string, secret_key)) === hash
 *
 * The token never leaves this server, and `auth_date` is checked for freshness
 * so an old payload can't be replayed.
 */

import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

export type VerifiedUser = {
  id: number;
  firstName: string;
  lastName?: string;
  username?: string;
  photoUrl?: string;
  authDate: number;
};

export type VerifyResult = { ok: true; user: VerifiedUser } | { ok: false; reason: string };

/** How far in the future auth_date may be, to tolerate small clock differences. */
const CLOCK_SKEW_SECONDS = 300;

const MAX_BODY_BYTES = 16 * 1024;

/** Keeps only the flat string/number fields the widget can produce, as strings. */
export function sanitizeAuthData(input: unknown): Record<string, string> | null {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return null;
  const data: Record<string, string> = {};
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    if (typeof value === "string") data[key] = value;
    else if (typeof value === "number" && Number.isFinite(value)) data[key] = String(value);
    else return null; // Anything nested or odd means this isn't a widget payload.
  }
  return data;
}

export function verifyTelegramAuth(
  token: string,
  raw: Record<string, string>,
  maxAgeSeconds = 86400,
): VerifyResult {
  const data = { ...raw };
  const hash = data.hash;
  delete data.hash;

  if (!hash || !/^[0-9a-f]{64}$/i.test(hash)) {
    return { ok: false, reason: "The sign-in data is missing its verification hash." };
  }

  const id = Number(data.id);
  const authDate = Number(data.auth_date);
  const firstName = data.first_name;
  if (!Number.isInteger(id) || id <= 0 || !firstName) {
    return { ok: false, reason: "The sign-in data is incomplete." };
  }
  if (!Number.isFinite(authDate) || authDate <= 0) {
    return { ok: false, reason: "The sign-in data has no valid auth_date." };
  }

  const ageSeconds = Date.now() / 1000 - authDate;
  if (ageSeconds > maxAgeSeconds) {
    return { ok: false, reason: "That sign-in is too old. Please try again." };
  }
  if (ageSeconds < -CLOCK_SKEW_SECONDS) {
    return { ok: false, reason: "That sign-in claims to be from the future. Please try again." };
  }

  const checkString = Object.keys(data)
    .sort()
    .map((key) => `${key}=${data[key]}`)
    .join("\n");
  const secretKey = createHash("sha256").update(token, "utf8").digest();
  const expected = createHmac("sha256", secretKey).update(checkString, "utf8").digest("hex");

  const expectedBuffer = Buffer.from(expected, "hex");
  const receivedBuffer = Buffer.from(hash.toLowerCase(), "hex");
  if (
    expectedBuffer.length !== receivedBuffer.length ||
    !timingSafeEqual(expectedBuffer, receivedBuffer)
  ) {
    return { ok: false, reason: "Telegram could not verify this sign-in." };
  }

  const user: VerifiedUser = {
    id,
    firstName,
    authDate,
    ...(data.last_name ? { lastName: data.last_name } : {}),
    ...(data.username ? { username: data.username } : {}),
    ...(data.photo_url ? { photoUrl: data.photo_url } : {}),
  };
  return { ok: true, user };
}

export type LoginHandlerOptions = {
  token: string;
  /** "*", or a comma-separated list of allowed website origins (https://...). */
  corsOrigin: string;
  maxAgeSeconds: number;
  /** Called after a payload verifies, e.g. to greet the user in Telegram. Failures are ignored. */
  onVerified?: (user: VerifiedUser) => void | Promise<void>;
};

function applyCors(req: IncomingMessage, res: ServerResponse, corsOrigin: string) {
  const configured = corsOrigin
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
  if (configured.includes("*")) {
    res.setHeader("Access-Control-Allow-Origin", "*");
  } else {
    const origin = req.headers.origin;
    if (origin && configured.some((allowed) => allowed.toLowerCase() === origin.toLowerCase())) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Vary", "Origin");
    }
  }
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Max-Age", "86400");
}

function sendJson(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

function readBody(req: IncomingMessage, limit: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

/**
 * Handles POST /telegram/login (and its OPTIONS preflight). Kept framework-free
 * so it drops straight into the bot's small HTTP server.
 */
export async function handleTelegramLoginRequest(
  req: IncomingMessage,
  res: ServerResponse,
  options: LoginHandlerOptions,
): Promise<void> {
  applyCors(req, res, options.corsOrigin);

  if (req.method === "OPTIONS") {
    res.writeHead(204).end();
    return;
  }
  if (req.method !== "POST") {
    sendJson(res, 405, { ok: false, error: "Use POST." });
    return;
  }

  let payload: Record<string, string> | null = null;
  try {
    const body = await readBody(req, MAX_BODY_BYTES);
    payload = sanitizeAuthData(JSON.parse(body));
  } catch {
    payload = null;
  }
  if (!payload) {
    sendJson(res, 400, { ok: false, error: "Expected the JSON object from the Telegram Login Widget." });
    return;
  }

  const result = verifyTelegramAuth(options.token, payload, options.maxAgeSeconds);
  if (!result.ok) {
    sendJson(res, 403, { ok: false, error: result.reason });
    return;
  }

  if (options.onVerified) {
    // Never make the website wait on (or fail because of) the greeting message.
    void Promise.resolve(options.onVerified(result.user)).catch(() => undefined);
  }

  sendJson(res, 200, {
    ok: true,
    user: {
      id: result.user.id,
      first_name: result.user.firstName,
      ...(result.user.lastName !== undefined ? { last_name: result.user.lastName } : {}),
      ...(result.user.username !== undefined ? { username: result.user.username } : {}),
      ...(result.user.photoUrl !== undefined ? { photo_url: result.user.photoUrl } : {}),
      auth_date: result.user.authDate,
    },
  });
}
