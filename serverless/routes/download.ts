/** GET/HEAD /download?token=... (rewritten to /api/download) — stream a short-lived private Blob download. */
import { withEnv } from "../http.js";
import { serveDownload } from "../web-convert.js";

const handler = withEnv((request, env) => serveDownload(request, env));
export const GET = handler;
export const HEAD = handler;
export const OPTIONS = handler;
