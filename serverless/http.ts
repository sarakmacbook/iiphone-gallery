import { timingSafeEqual } from "node:crypto";
import type { VercelEnv } from "./env.js";
import { loadVercelEnv } from "./env.js";

export function corsHeaders(request: Request, allowedOrigin: string, methods: string): Headers {
  const headers = new Headers({
    "Access-Control-Allow-Methods": methods,
    "Access-Control-Allow-Headers": "Content-Type, X-Api-Key, Authorization, Range",
    "Access-Control-Expose-Headers": "Content-Length, Content-Range, Content-Disposition, Accept-Ranges",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  });
  const origin = request.headers.get("origin");
  const configured = allowedOrigin.split(",").map((entry) => entry.trim()).filter(Boolean);
  if (configured.includes("*")) {
    headers.set("Access-Control-Allow-Origin", "*");
    headers.delete("Vary");
  } else if (origin && configured.some((entry) => entry.toLowerCase() === origin.toLowerCase())) {
    headers.set("Access-Control-Allow-Origin", origin);
  }
  return headers;
}

export function json(body: unknown, status = 200, headers?: HeadersInit): Response {
  const resultHeaders = new Headers(headers);
  if (!resultHeaders.has("content-type")) resultHeaders.set("content-type", "application/json; charset=utf-8");
  resultHeaders.set("cache-control", "no-store");
  return new Response(JSON.stringify(body), { status, headers: resultHeaders });
}

export function jsonError(
  status: number,
  code: string,
  message: string,
  headers?: HeadersInit,
): Response {
  return json({ ok: false, error: { code, message } }, status, headers);
}

export function hasApiKey(request: Request, required?: string): boolean {
  if (!required) return true;
  const authorization = request.headers.get("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1];
  const presented = request.headers.get("x-api-key") || authorization || "";
  const actualBuffer = Buffer.from(presented);
  const requiredBuffer = Buffer.from(required);
  return actualBuffer.length === requiredBuffer.length && timingSafeEqual(actualBuffer, requiredBuffer);
}

export type EnvHandler = (request: Request, env: VercelEnv) => Response | Promise<Response>;

/** Common environment loading and error boundary for Vercel/Fetch-style routes. */
export function withEnv(handler: EnvHandler): (request: Request) => Promise<Response> {
  return async (request) => {
    try {
      return await handler(request, loadVercelEnv());
    } catch (error) {
      console.error("Vercel function failed:", error);
      return jsonError(500, "serverError", "Something went wrong. Please try again.");
    }
  };
}
