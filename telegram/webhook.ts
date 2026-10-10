/**
 * POST /api/telegram/webhook — Telegram delivers bot updates here.
 * Answers immediately, then finishes the update (which may be a whole video
 * conversion) in the background with waitUntil, up to the function's maxDuration.
 */
import { waitUntil } from "@vercel/functions";
import { serverlessFfmpeg } from "../../serverless/ffmpeg.js";
import { withEnv } from "../../serverless/http.js";
import { acceptWebhook, getWebhookBot } from "../../serverless/telegram-routes.js";

export const POST = withEnv(async (request, env) => {
  const { response, work } = await acceptWebhook(request, env, () =>
    getWebhookBot(env, () => serverlessFfmpeg(env.ffmpegPath)),
  );
  if (work) waitUntil(work);
  return response;
});
