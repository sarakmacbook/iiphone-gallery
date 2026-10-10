/**
 * POST /api/upload — Vercel Blob client-upload token exchange. The browser's
 * upload() call talks to this route, then sends the video straight to Blob, so
 * the function's 4.5 MB request limit never applies to the video itself.
 */
import type { HandleUploadBody } from "@vercel/blob/client";
import { corsHeaders, hasApiKey, json, jsonError, withEnv } from "../serverless/http.js";
import { handleUploadToken, unavailableReason } from "../serverless/web-convert.js";

const METHODS = "POST, OPTIONS";

export const OPTIONS = withEnv((request, env) => new Response(null, { status: 204, headers: corsHeaders(request, env.corsOrigin, METHODS) }));

export const POST = withEnv(async (request, env) => {
  const cors = corsHeaders(request, env.corsOrigin, METHODS);
  const problem = unavailableReason(env);
  if (problem) return jsonError(503, problem.code, problem.message, cors);

  let body: HandleUploadBody;
  try {
    body = (await request.json()) as HandleUploadBody;
  } catch {
    return jsonError(400, "badRequest", "Expected a JSON body from @vercel/blob's upload().", cors);
  }
  // Blob's own "upload completed" callback is signed by Vercel and carries no API key.
  if (body?.type !== "blob.upload-completed" && !hasApiKey(request, env.webApiKey)) {
    return jsonError(401, "unauthorized", "This server needs an API key.", cors);
  }
  try {
    return json(await handleUploadToken(request, env, body), 200, cors);
  } catch (error) {
    return jsonError(400, "uploadRejected", (error as Error).message, cors);
  }
});
