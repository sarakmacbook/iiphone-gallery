import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Bot, GrammyError, InlineKeyboard, InputFile, type Api, type Context } from "grammy";
import { verifyTelegramAuth, sanitizeAuthData } from "../src/auth.js";
import { downloadTelegramFile } from "../src/telegram-download.js";
import { CancelledError, probeVideo, resizeVideo } from "../src/ffmpeg.js";
import { outputFileName } from "../src/paths.js";
import { PRESETS, findPreset, formatMB, isConvertOnly, presetChoice, type SizeChoice } from "../src/sizes.js";
import type { VercelEnv } from "./env.js";
import { corsHeaders, json, jsonError, hasApiKey } from "./http.js";

export type WaitUntil = (promise: Promise<unknown>) => void | undefined;

type TelegramApiResponse<T> = { ok: boolean; result?: T; description?: string };
type SetupReport = {
  ok: boolean;
  configured: boolean;
  registered?: boolean;
  expectedUrl?: string;
  currentUrl?: string;
  description?: string;
};

async function callTelegram<T>(env: VercelEnv, method: string, body?: Record<string, unknown>): Promise<T> {
  if (!env.token) throw new Error("TELEGRAM_BOT_TOKEN is not configured.");
  const response = await fetch(`${env.telegramApiRoot}/bot${env.token}/${method}`, {
    method: body ? "POST" : "GET",
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = (await response.json().catch(() => null)) as TelegramApiResponse<T> | null;
  if (!response.ok || !data?.ok || data.result === undefined) {
    throw new Error(data?.description || `Telegram ${method} failed with HTTP ${response.status}.`);
  }
  return data.result;
}

/** Verify a Telegram Login Widget payload and optionally send the configured greeting. */
export async function handleLogin(request: Request, env: VercelEnv, waitUntil: WaitUntil): Promise<Response> {
  const cors = corsHeaders(request, env.corsOrigin, "POST, OPTIONS");
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  if (request.method !== "POST") return jsonError(405, "badMethod", "Use POST.", cors);
  if (!env.token) return jsonError(503, "telegramNotConfigured", "Set TELEGRAM_BOT_TOKEN to enable Telegram sign-in.", cors);
  if (!hasApiKey(request, env.webApiKey)) return jsonError(401, "unauthorized", "This server needs an API key.", cors);

  const declared = Number(request.headers.get("content-length") ?? 0);
  if (declared > 16 * 1024) return jsonError(413, "tooLarge", "The sign-in payload is too large.", cors);
  let payload: Record<string, string> | null = null;
  try {
    const text = await request.text();
    if (Buffer.byteLength(text) > 16 * 1024) return jsonError(413, "tooLarge", "The sign-in payload is too large.", cors);
    payload = sanitizeAuthData(JSON.parse(text));
  } catch {
    payload = null;
  }
  if (!payload) {
    return jsonError(400, "badRequest", "Expected the JSON object from the Telegram Login Widget.", cors);
  }

  const result = verifyTelegramAuth(env.token, payload, env.loginMaxAgeSeconds);
  if (!result.ok) return jsonError(403, "invalidLogin", result.reason, cors);

  if (env.loginGreeting) {
    const greeting = callTelegram(env, "sendMessage", {
      chat_id: result.user.id,
      text: `Hi ${result.user.firstName}! Your Telegram account is connected to the website.`,
    }).catch((error) => console.warn("Telegram website-login greeting failed:", error));
    try {
      waitUntil(greeting);
    } catch {
      // The greeting is optional; never fail a verified sign-in because a host lacks waitUntil.
    }
  }

  return json(
    {
      ok: true,
      user: {
        id: result.user.id,
        first_name: result.user.firstName,
        ...(result.user.lastName !== undefined ? { last_name: result.user.lastName } : {}),
        ...(result.user.username !== undefined ? { username: result.user.username } : {}),
        ...(result.user.photoUrl !== undefined ? { photo_url: result.user.photoUrl } : {}),
        auth_date: result.user.authDate,
      },
    },
    200,
    cors,
  );
}

/** Check the webhook, or register this Vercel deployment with Telegram. */
export async function runSetup(env: VercelEnv, register: boolean): Promise<SetupReport> {
  if (!env.token) return { ok: false, configured: false, description: "Set TELEGRAM_BOT_TOKEN first." };
  if (!env.publicUrl) {
    return {
      ok: false,
      configured: true,
      description: "Set PUBLIC_URL to the canonical HTTPS production domain before registering a webhook.",
    };
  }
  if (register && !env.webhookSecret) {
    return {
      ok: false,
      configured: true,
      description: "Set TELEGRAM_WEBHOOK_SECRET before registering the webhook.",
    };
  }

  const expectedUrl = `${env.publicUrl}/api/telegram/webhook`;
  if (register) {
    await callTelegram(env, "setWebhook", {
      url: expectedUrl,
      ...(env.webhookSecret ? { secret_token: env.webhookSecret } : {}),
      allowed_updates: ["message", "callback_query"],
      drop_pending_updates: false,
    });
  }
  const info = await callTelegram<{ url?: string; pending_update_count?: number; last_error_message?: string }>(
    env,
    "getWebhookInfo",
  );
  const currentUrl = info.url || "";
  return {
    ok: currentUrl === expectedUrl,
    configured: true,
    ...(register ? { registered: currentUrl === expectedUrl } : {}),
    expectedUrl,
    currentUrl,
    ...(info.last_error_message ? { description: info.last_error_message } : {}),
  };
}

/** Minimal stateless webhook bot: each size button carries its context in the replied-to video message. */
export function getWebhookBot(env: VercelEnv, ffmpeg: () => string): Bot {
  if (!env.token) throw new Error("TELEGRAM_BOT_TOKEN is not configured.");
  const cacheKey = JSON.stringify({
    token: env.token,
    telegramApiRoot: env.telegramApiRoot,
    maxTelegramUploadMB: env.maxTelegramUploadMB,
    maxTelegramOutputMB: env.maxTelegramOutputMB,
    webMaxUploadMB: env.webMaxUploadMB,
    maxSeconds: env.maxSeconds,
  });
  if (cachedWebhookBot?.key === cacheKey) return cachedWebhookBot.bot;

  const bot = new Bot(env.token, { client: { apiRoot: env.telegramApiRoot } });

  bot.command("start", async (ctx) => {
    await ctx.reply(
      `Send an iPhone video and choose a size. The original stays unchanged. Vercel accepts Telegram videos up to ${env.maxTelegramUploadMB} MB.`,
    );
  });
  bot.command("help", async (ctx) => {
    await ctx.reply(
      `Choose one of the size buttons on the message replying to your video. This serverless bot supports the listed presets; use the website converter for custom sizes and larger uploads (up to ${env.webMaxUploadMB} MB).`,
    );
  });
  bot.command("cancel", async (ctx) => {
    await ctx.reply("This Vercel webhook bot cannot cancel a conversion after it starts. Use the website converter for long videos.");
  });

  bot.on("message:video", async (ctx) => {
    const video = ctx.message.video;
    await offerVideo(ctx, env, ctx.message.message_id, video.file_name ?? "video.mp4", video.file_size);
  });
  bot.on("message:document", async (ctx) => {
    const document = ctx.message.document;
    const filename = document.file_name ?? "video";
    if (!isSupportedDocument(filename, document.mime_type)) {
      await ctx.reply("Please send a MOV, MP4, or M4V video.");
      return;
    }
    await offerVideo(ctx, env, ctx.message.message_id, filename, document.file_size);
  });
  bot.on("message", async (ctx) => {
    if (ctx.message.text && !ctx.message.text.startsWith("/")) {
      await ctx.reply("Send a video as a video or document, then choose one of the size buttons.");
    }
  });

  bot.callbackQuery(/^size:(convert|keep|balanced|smaller)$/, async (ctx) => {
    const key = ctx.match[1];
    const preset = findPreset(key ?? "");
    const message = ctx.callbackQuery.message;
    const replied = message && "reply_to_message" in message ? message.reply_to_message : undefined;
    const media = replied ? mediaFromMessage(replied) : undefined;
    if (!preset || !message || !media) {
      await ctx.answerCallbackQuery({ text: "That button has expired. Send the video again." });
      return;
    }

    const chatId = message.chat.id;
    const conversionKey = `${chatId}:${message.message_id}`;
    if (activeTelegramConversions.has(conversionKey)) {
      await ctx.answerCallbackQuery({ text: "This video is already converting." });
      return;
    }
    activeTelegramConversions.add(conversionKey);
    let statusMessageId: number | undefined;
    try {
      await ctx.answerCallbackQuery({ text: "Starting conversion…" });
      await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => undefined);
      const choice = presetChoice(preset);
      const binary = ffmpeg();
      const status = await bot.api.sendMessage(chatId, `Converting ${media.name} with ${preset.label}…`);
      statusMessageId = status.message_id;
      await convertAndSend(bot.api, chatId, status.message_id, media, choice, env, binary);
      statusMessageId = undefined;
    } catch (error) {
      console.error("Vercel Telegram conversion failed:", error);
      if (statusMessageId !== undefined) await bot.api.deleteMessage(chatId, statusMessageId).catch(() => undefined);
      await bot.api.sendMessage(chatId, "I couldn't start that conversion. Please try again later.").catch(() => undefined);
    } finally {
      activeTelegramConversions.delete(conversionKey);
    }
  });
  bot.callbackQuery("callback_query:data", async (ctx) => {
    await ctx.answerCallbackQuery({ text: "That button has expired." });
  });

  bot.catch((error) => {
    const reason = error.error instanceof GrammyError ? error.error.description : error.error;
    console.error(`Error handling Telegram update ${error.ctx.update.update_id}:`, reason);
  });

  cachedWebhookBot = { key: cacheKey, bot };
  return bot;
}

let cachedWebhookBot: { key: string; bot: Bot } | undefined;
const activeTelegramConversions = new Set<string>();

async function offerVideo(
  ctx: Context,
  env: VercelEnv,
  sourceMessageId: number,
  filename: string,
  fileSize?: number,
): Promise<void> {
  if (fileSize !== undefined && fileSize > env.maxTelegramUploadMB * 1024 * 1024) {
    await ctx.reply(`That video is over the ${env.maxTelegramUploadMB} MB Telegram download limit.`);
    return;
  }
  await ctx.reply(`Choose how to convert ${filename} (up to ${env.maxTelegramUploadMB} MB):`, {
    reply_parameters: { message_id: sourceMessageId, allow_sending_without_reply: true },
    reply_markup: sizeKeyboard(),
  });
}

function sizeKeyboard(): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  for (const preset of PRESETS) keyboard.text(preset.label, `size:${preset.key}`).row();
  return keyboard;
}

type TelegramMedia = {
  fileId: string;
  name: string;
  size?: number;
  duration?: number;
};

function mediaFromMessage(message: unknown): TelegramMedia | undefined {
  if (!isRecord(message)) return undefined;
  const video = message.video;
  if (isRecord(video) && typeof video.file_id === "string") {
    return {
      fileId: video.file_id,
      name: typeof video.file_name === "string" ? video.file_name : "video.mp4",
      ...(typeof video.file_size === "number" ? { size: video.file_size } : {}),
      ...(typeof video.duration === "number" ? { duration: video.duration } : {}),
    };
  }
  const document = message.document;
  if (
    isRecord(document) &&
    typeof document.file_id === "string" &&
    isSupportedDocument(
      typeof document.file_name === "string" ? document.file_name : undefined,
      typeof document.mime_type === "string" ? document.mime_type : undefined,
    )
  ) {
    return {
      fileId: document.file_id,
      name: typeof document.file_name === "string" ? document.file_name : "video.mp4",
      ...(typeof document.file_size === "number" ? { size: document.file_size } : {}),
    };
  }
  return undefined;
}

function isSupportedDocument(name?: string, mimeType?: string): boolean {
  return /\.(mov|mp4|m4v)$/i.test(name ?? "") || ["video/mp4", "video/quicktime", "video/x-m4v"].includes(mimeType ?? "");
}

async function convertAndSend(
  api: Api,
  chatId: number,
  statusMessageId: number,
  media: TelegramMedia,
  choice: SizeChoice,
  env: VercelEnv,
  binary: string,
): Promise<void> {
  const dir = await mkdtemp(path.join(tmpdir(), "sendable-vercel-telegram-"));
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new Error("Vercel function conversion deadline reached.")), env.maxSeconds * 1000);
  timeout.unref?.();
  const inputPath = path.join(dir, "input");

  try {
    const outputName = outputFileName(media.name, choice);
    const outputPath = path.join(dir, outputName);
    await api.sendChatAction(chatId, "upload_video").catch(() => undefined);
    const input = await downloadTelegramFile(
      { api, apiRoot: env.telegramApiRoot, token: env.token!, localApi: false },
      media.fileId,
      inputPath,
      controller.signal,
    );
    const sourceSize = media.size ?? (await stat(input)).size;
    if (sourceSize > env.maxTelegramUploadMB * 1024 * 1024) {
      throw new Error(`That video is over the ${env.maxTelegramUploadMB} MB Telegram download limit.`);
    }
    const info = await probeVideo(binary, input, controller.signal);
    const result = await resizeVideo({
      binary,
      input,
      output: outputPath,
      choice,
      duration: media.duration ?? info.duration,
      signal: controller.signal,
    });
    const outputSize = (await stat(outputPath)).size;
    if (outputSize > env.maxTelegramOutputMB * 1024 * 1024) {
      throw new Error(`The converted file is over Telegram's ${env.maxTelegramOutputMB} MB send limit.`);
    }

    const convertOnly = isConvertOnly(choice);
    if (!convertOnly && outputSize >= sourceSize) {
      throw new Error("That preset did not make the file smaller. Try a smaller size or use the website converter.");
    }
    await api.sendVideo(chatId, new InputFile(outputPath, outputName), {
      caption: `${choice.label}\n${formatMB(sourceSize)} → ${formatMB(outputSize)}${outputSize < sourceSize ? " (smaller)" : ""}`,
      width: result.width,
      height: result.height,
      duration: result.duration ? Math.round(result.duration) : undefined,
      supports_streaming: true,
    });
  } catch (error) {
    const message =
      controller.signal.aborted || error instanceof CancelledError
        ? "That conversion reached the Vercel time limit. Try a shorter video or use the website converter."
        : error instanceof Error
          ? error.message
          : "The conversion failed. Please try again.";
    await api.sendMessage(chatId, message).catch(() => undefined);
  } finally {
    clearTimeout(timeout);
    await api.deleteMessage(chatId, statusMessageId).catch(() => undefined);
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

/** Verify the Telegram webhook secret, acknowledge immediately, and return work for Vercel waitUntil. */
export async function acceptWebhook(
  request: Request,
  env: VercelEnv,
  getBot: () => Bot,
): Promise<{ response: Response; work?: Promise<unknown> }> {
  if (request.method !== "POST") {
    return { response: jsonError(405, "badMethod", "Use POST.", { Allow: "POST" }) };
  }
  if (!env.token) return { response: jsonError(503, "telegramNotConfigured", "Set TELEGRAM_BOT_TOKEN to enable the webhook.") };
  if (!env.webhookSecret) {
    return { response: jsonError(503, "webhookSecretMissing", "Set TELEGRAM_WEBHOOK_SECRET before enabling the webhook.") };
  }
  if (request.headers.get("x-telegram-bot-api-secret-token") !== env.webhookSecret) {
    return { response: jsonError(401, "unauthorized", "Invalid Telegram webhook secret.") };
  }

  const length = Number(request.headers.get("content-length") ?? 0);
  if (length > 1024 * 1024) return { response: jsonError(413, "tooLarge", "Telegram update is too large.") };
  let update: unknown;
  try {
    const text = await request.text();
    if (Buffer.byteLength(text) > 1024 * 1024) {
      return { response: jsonError(413, "tooLarge", "Telegram update is too large.") };
    }
    update = JSON.parse(text);
  } catch {
    return { response: jsonError(400, "badRequest", "Expected a Telegram update in JSON.") };
  }
  if (!isTelegramUpdate(update)) return { response: jsonError(400, "badRequest", "The Telegram update is invalid.") };

  const work = getBot()
    .handleUpdate(update)
    .catch((error) => console.error(`Telegram webhook update ${update.update_id} failed:`, error));
  return { response: new Response("ok", { status: 200, headers: { "cache-control": "no-store" } }), work };
}

function isTelegramUpdate(value: unknown): value is { update_id: number } & Record<string, unknown> {
  return isRecord(value) && Number.isSafeInteger(value.update_id) && Number(value.update_id) >= 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
