/**
 * GET /api/telegram/setup — is Telegram pointed at this deployment?
 * GET /api/telegram/setup?register=1 (or POST) — point it here. Safe to repeat.
 * Production builds also do this automatically (scripts/vercel-build.mjs).
 */
import type { VercelEnv } from "../../serverless/env.js";
import { json, jsonError, withEnv } from "../../serverless/http.js";
import { runSetup } from "../../serverless/telegram-routes.js";

async function setup(register: boolean, env: VercelEnv) {
  try {
    const report = await runSetup(env, register);
    return json(report, report.ok ? 200 : 409);
  } catch (error) {
    return jsonError(502, "telegram", `Telegram rejected the request: ${(error as Error).message}`);
  }
}

export const GET = withEnv((request, env) => setup(new URL(request.url).searchParams.get("register") === "1", env));
export const POST = withEnv((_request, env) => setup(true, env));
