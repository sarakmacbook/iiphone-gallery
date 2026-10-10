/** GET /api/health (also /health) — what this deployment has switched on. */
import { json, withEnv } from "../serverless/http.js";
import { unavailableReason } from "../serverless/web-convert.js";

export const GET = withEnv((_request, env) =>
  json({
    ok: true,
    mode: "vercel",
    telegram: env.token
      ? { webhook: "/api/telegram/webhook", setup: "/api/telegram/setup", publicUrl: env.publicUrl ?? null }
      : null,
    login: env.token ? "/telegram/login" : null,
    converter: unavailableReason(env) ?? { ok: true, maxUploadMB: env.webMaxUploadMB, maxSeconds: env.maxSeconds },
  }),
);
