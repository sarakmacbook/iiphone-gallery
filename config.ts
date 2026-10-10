/** GET /api/config — presets and limits for the website's converter (Vercel mode). */
import { corsHeaders, hasApiKey, json, jsonError, withEnv } from "../serverless/http.js";
import { configBody, unavailableReason } from "../serverless/web-convert.js";

const METHODS = "GET, OPTIONS";

export const OPTIONS = withEnv((request, env) => new Response(null, { status: 204, headers: corsHeaders(request, env.corsOrigin, METHODS) }));

export const GET = withEnv((request, env) => {
  const cors = corsHeaders(request, env.corsOrigin, METHODS);
  if (!hasApiKey(request, env.webApiKey)) return jsonError(401, "unauthorized", "This server needs an API key.", cors);
  const problem = unavailableReason(env);
  if (problem) return jsonError(503, problem.code, problem.message, cors);
  return json(configBody(env), 200, cors);
});
