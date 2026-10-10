/**
 * Entry point for the MP4 converter bot (`npm run start:mp4`). It uses its own
 * MP4_BOT_TOKEN and long polling, so it needs no public address.
 */

import { loadMp4BotConfig } from "./config.js";
import { checkFfmpeg, resolveFfmpeg } from "./ffmpeg.js";
import { createMp4Bot, registerMp4Commands } from "./mp4-bot.js";

async function main() {
  const config = loadMp4BotConfig();
  const ffmpeg = resolveFfmpeg(config.ffmpegPath);
  console.log(`Using ${await checkFfmpeg(ffmpeg)}`);

  const { bot, stop } = createMp4Bot(config, ffmpeg);
  await bot.init();
  const username = bot.botInfo.username;
  console.log(`MP4 converter connected to Telegram as @${username} (https://t.me/${username})`);
  console.log(
    `Limits: ${config.maxUploadMB} MB in, ${config.maxOutputMB} MB out, ${config.maxConcurrentJobs} conversion(s) at once`,
  );

  await registerMp4Commands(bot).catch((error) =>
    console.warn("Could not register bot commands:", error instanceof Error ? error.message : error),
  );

  // bot.start() removes any old webhook first, so switching from webhook mode just works.
  void bot.start({
    allowed_updates: ["message", "callback_query"],
    onStart: () => console.log("Polling mode: listening for videos. Press Ctrl+C to stop."),
  });

  const shutdown = async (signal: string) => {
    console.log(`${signal} received, shutting down…`);
    await bot.stop();
    await stop();
    process.exit(0);
  };
  process.once("SIGINT", () => void shutdown("SIGINT"));
  process.once("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
