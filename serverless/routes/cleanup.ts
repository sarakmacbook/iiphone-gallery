/**
 * GET /api/cleanup — run daily by the Vercel Cron in vercel.json. Deletes
 * converter uploads and outputs older than WEB_JOB_TTL_MINUTES from Blob.
 */
import { json, jsonError, withEnv } from "../http.js";
import { cleanupBlobs } from "../web-convert.js";

export const GET = withEnv(async (request, env) => {
  if (!env.cronSecret) {
    return jsonError(503, "cronSecretMissing", "Set CRON_SECRET before enabling the cleanup endpoint.");
  }
  if (request.headers.get("authorization") !== `Bearer ${env.cronSecret}`) {
    return jsonError(401, "unauthorized", "Cron calls only.");
  }
  const removed = await cleanupBlobs(env);
  return json({ ok: true, removed });
});
