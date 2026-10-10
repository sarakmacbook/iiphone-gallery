/**
 * Shared CORS + JSON helpers for the bot's small HTTP server, used by both the
 * sign-in endpoint (auth.ts) and the web conversion API (web.ts).
 */

import type { IncomingMessage, ServerResponse } from "node:http";

/**
 * Applies CORS headers. `corsOrigin` is "*" or a comma-separated list of plain
 * origins (validated in config.ts).
 */
export function applyCors(
  req: IncomingMessage,
  res: ServerResponse,
  corsOrigin: string,
  methods = "POST, OPTIONS",
): void {
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
  res.setHeader("Access-Control-Allow-Methods", methods);
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Api-Key, Authorization");
  res.setHeader("Access-Control-Expose-Headers", "Content-Length, Content-Range");
  res.setHeader("Access-Control-Max-Age", "86400");
}

export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

export function sendError(
  res: ServerResponse,
  status: number,
  code: string,
  message: string,
): void {
  sendJson(res, status, { ok: false, error: { code, message } });
}
