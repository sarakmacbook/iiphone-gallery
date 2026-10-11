/**
 * GET /api/telegram/setup — check the registered webhook.
 * POST /api/telegram/setup — register it (requires TELEGRAM_SETUP_SECRET).
 */
import type { VercelEnv } from "../../env.js";
import { hasApiKey, json, jsonError, withEnv } from "../../http.js";
import { runSetup } from "../../telegram-routes.js";

async function setup(request: Request, register: boolean, env: VercelEnv): Promise<Response> {
  if (register) {
    if (!env.setupSecret) {
      return jsonError(503, "setupSecretMissing", "Set TELEGRAM_SETUP_SECRET before registering the webhook.");
    }
    if (!hasApiKey(request, env.setupSecret)) {
      return jsonError(401, "unauthorized", "Use Authorization: Bearer <TELEGRAM_SETUP_SECRET> to register the webhook.");
    }
  }
  try {
    const report = await runSetup(env, register);
    return json(report, report.ok ? 200 : 409);
  } catch (error) {
    console.error("Telegram webhook setup failed:", error);
    return jsonError(502, "telegram", "Telegram rejected the webhook setup request.");
  }
}

export const GET = withEnv((request, env) =>
  setup(request, new URL(request.url).searchParams.get("register") === "1", env),
);
export const POST = withEnv((request, env) => setup(request, true, env));
