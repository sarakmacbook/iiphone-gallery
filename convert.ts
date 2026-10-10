/**
 * POST /api/convert — converts a video the browser already uploaded to Vercel
 * Blob, streaming progress as JSON lines. See serverless/web-convert.ts.
 */
import { waitUntil } from "@vercel/functions";
import { serverlessFfmpeg } from "../serverless/ffmpeg.js";
import { corsHeaders, hasApiKey, jsonError, withEnv } from "../serverless/http.js";
import { cleanupBlobs, convertUpload, ndjsonResponse, unavailableReason, type ConvertRequest } from "../serverless/web-convert.js";

const METHODS = "POST, OPTIONS";
let lastSweep = 0;

export const OPTIONS = withEnv((request, env) => new Response(null, { status: 204, headers: corsHeaders(request, env.corsOrigin, METHODS) }));

export const POST = withEnv(async (request, env) => {
  const cors = corsHeaders(request, env.corsOrigin, METHODS);
  if (!hasApiKey(request, env.webApiKey)) return jsonError(401, "unauthorized", "This server needs an API key.", cors);
  const problem = unavailableReason(env);
  if (problem) return jsonError(503, problem.code, problem.message, cors);

  let body: ConvertRequest;
  try {
    body = (await request.json()) as ConvertRequest;
  } catch {
    return jsonError(400, "badRequest", "Expected JSON: {url, name, preset} or {url, name, width, height}.", cors);
  }

  // Between daily cron runs, warm instances also tidy up old files now and then.
  if (Date.now() - lastSweep > 10 * 60 * 1000) {
    lastSweep = Date.now();
    waitUntil(cleanupBlobs(env).catch((error) => console.warn("Blob cleanup failed:", error)));
  }

  const events = convertUpload(body, env, { ffmpeg: () => serverlessFfmpeg(env.ffmpegPath) }, request.signal);
  return ndjsonResponse(events, cors);
});
