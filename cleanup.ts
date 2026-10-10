/**
 * GET /api/cleanup — run daily by the cron in vercel.json. Deletes converted
 * files and stray uploads older than WEB_JOB_TTL_MINUTES from Vercel Blob.
 */
import { json, jsonError, withEnv } from "../serverless/http.js";
import { cleanupBlobs } from "../serverless/web-convert.js";

export const GET = withEnv(async (request, env) => {
  // Vercel sends "Authorization: Bearer <CRON_SECRET>" with cron calls when CRON_SECRET is set.
  if (env.cronSecret && request.headers.get("authorization") !== `Bearer ${env.cronSecret}`) {
    return jsonError(401, "unauthorized", "Cron calls only.");
  }
  const removed = await cleanupBlobs(env);
  return json({ ok: true, removed });
});
