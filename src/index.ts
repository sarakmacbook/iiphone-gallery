import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { webhookCallback } from "grammy";
import { validateArchiveTarget } from "./archive.js";
import { handleTelegramLoginRequest } from "./auth.js";
import { createBot, registerCommands } from "./bot.js";
import { loadConfig } from "./config.js";
import { checkFfmpeg, resolveFfmpeg } from "./ffmpeg.js";
import { messages } from "./messages.js";
import { createConvertApi } from "./web.js";

async function main() {
  const config = loadConfig();
  const ffmpeg = resolveFfmpeg(config.ffmpegPath);
  console.log(`Using ${await checkFfmpeg(ffmpeg)}`);

  // The Telegram half is optional: WEB_ONLY=true serves just the web API.
  const telegram = config.telegramEnabled ? createBot(config, ffmpeg) : undefined;
  let username = "";
  let handleWebhook: ((req: IncomingMessage, res: ServerResponse) => Promise<void>) | undefined;

  if (telegram) {
    await telegram.bot.init();
    username = telegram.bot.botInfo.username;
    if (config.archiveChatId) {
      const archiveChat = await telegram.bot.api.getChat(config.archiveChatId);
      const archiveMember = await telegram.bot.api.getChatMember(config.archiveChatId, telegram.bot.botInfo.id);
      validateArchiveTarget(archiveChat, archiveMember, config.archiveAllowPublic);
      const visibility = archiveChat.username ? `public @${archiveChat.username}` : "private channel";
      console.log(`Channel archive enabled: ${archiveChat.title ?? config.archiveChatId} (${visibility})`);
    }
    console.log(`Connected to Telegram as @${username} (https://t.me/${username})`);
    console.log(
      `Limits: ${config.maxUploadMB} MB in, ${config.maxOutputMB} MB out, ${config.maxDimension}px custom, ` +
        `${config.maxConcurrentJobs} job(s) at once`,
    );

    await registerCommands(telegram.bot).catch((error) =>
      console.warn("Could not register bot commands:", error instanceof Error ? error.message : error),
    );

    handleWebhook = config.webhookUrl
      ? webhookCallback(telegram.bot, "http", { secretToken: config.webhookSecret })
      : undefined;
  } else {
    console.log("WEB_ONLY=true: no Telegram bot, serving the website's conversion API only.");
  }

  // Website sign-in: verify Telegram Login Widget payloads for the site.
  // See "Website sign-in" in bot/README.md.
  const loginPath = "/telegram/login";
  const greetAfterLogin =
    telegram && config.loginGreeting
      ? (user: { id: number; firstName: string }) =>
          telegram.bot.api
            .sendMessage(user.id, messages.siteLoginGreeting(user.firstName))
            .then(() => undefined)
            .catch(() => undefined)
      : undefined;

  // Browser conversions: upload a video, shrink it with the same ffmpeg pipeline
  // the Telegram bot uses, then download the result. See bot/src/web.ts.
  const convertApi = config.webConvert
    ? createConvertApi({
        limits: {
          maxUploadMB: config.webMaxUploadMB,
          allowCustom: config.allowCustom,
          maxDimension: config.maxDimension,
          maxConcurrentJobs: config.maxConcurrentJobs,
          jobTtlMinutes: config.webJobTtlMinutes,
        },
        corsOrigin: config.corsOrigin,
        ffmpeg,
        apiKey: config.webApiKey,
      })
    : undefined;
  if (convertApi) {
    console.log(
      `Web conversion API on /api: up to ${config.webMaxUploadMB} MB, ` +
        `${config.maxConcurrentJobs} at a time, results kept ${config.webJobTtlMinutes} min` +
        `${config.webApiKey ? ", API key required" : ""}`,
    );
  }

  // A small HTTP server: health checks for your host, the login endpoint for the
  // website, the conversion API, plus the webhook in webhook mode.
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/health")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          ok: true,
          ...(username ? { bot: username, link: `https://t.me/${username}` } : {}),
          mode: !username ? "web-only" : handleWebhook ? "webhook" : "polling",
          login: loginPath,
          ...(convertApi
            ? {
                api: {
                  endpoints: {
                    config: "/api/config",
                    convert: "/api/convert",
                    job: "/api/jobs/:id",
                    download: "/api/jobs/:id/download",
                  },
                  maxUploadMB: config.webMaxUploadMB,
                  ...convertApi.stats(),
                },
              }
            : {}),
        }),
      );
      return;
    }
    if (convertApi?.handle(req, res, url)) return;
    if (url.pathname === loginPath && (req.method === "POST" || req.method === "OPTIONS")) {
      void handleTelegramLoginRequest(req, res, {
        token: config.token,
        corsOrigin: config.corsOrigin,
        maxAgeSeconds: config.loginMaxAgeSeconds,
        onVerified: greetAfterLogin,
      });
      return;
    }
    if (handleWebhook && req.method === "POST" && url.pathname === config.webhookPath) {
      void handleWebhook(req, res);
      return;
    }
    res.writeHead(404).end();
  });
  server.listen(config.port, "0.0.0.0", () => console.log(`Health check on port ${config.port}`));

  if (telegram && config.webhookUrl) {
    const webhook = `${config.webhookUrl}${config.webhookPath}`;
    await telegram.bot.api.setWebhook(webhook, {
      secret_token: config.webhookSecret,
      allowed_updates: ["message", "callback_query"],
      drop_pending_updates: false,
    });
    console.log(`Webhook mode: Telegram will send updates to ${webhook}`);
  } else if (telegram) {
    // bot.start() removes any old webhook first, so switching modes just works.
    void telegram.bot.start({
      allowed_updates: ["message", "callback_query"],
      onStart: () => console.log("Polling mode: listening for messages. Press Ctrl+C to stop."),
    });
  }

  const shutdown = async (signal: string) => {
    console.log(`${signal} received, shutting down…`);
    server.close();
    if (telegram && !config.webhookUrl) await telegram.bot.stop();
    await telegram?.stop();
    await convertApi?.shutdown();
    process.exit(0);
  };
  process.once("SIGINT", () => void shutdown("SIGINT"));
  process.once("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
