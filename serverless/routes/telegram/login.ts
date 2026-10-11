/** POST /api/telegram/login (also /telegram/login) — website "Sign in with Telegram" verification. */
import { waitUntil } from "@vercel/functions";
import { withEnv } from "../../http.js";
import { handleLogin } from "../../telegram-routes.js";

const handler = withEnv((request, env) => handleLogin(request, env, waitUntil));
export const POST = handler;
export const OPTIONS = handler;
