/**
 * The MP4 converter bot. Send it a video in almost any format (MOV, MKV, WebM,
 * AVI, 3GP, ...) and it sends back a standard MP4: H.264 video and AAC audio, at
 * the original resolution, with iPhone rotation applied and location metadata
 * removed. It is a separate bot with its own token, and it does not change the
 * Sendable bot. Run it with `npm run start:mp4`.
 */

import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Bot, GrammyError, InlineKeyboard, InputFile, type Context } from "grammy";
import type { Mp4BotConfig } from "./config.js";
import { CancelledError, resizeVideo } from "./ffmpeg.js";
import { baseName } from "./paths.js";
import { Semaphore } from "./semaphore.js";
import { downloadTelegramFile, type TelegramFileSource } from "./telegram-download.js";
import { findPreset, formatMB, presetChoice, type SizeChoice } from "./sizes.js";

const MB = 1024 * 1024;
const PROGRESS_EDIT_MS = 4000;

/** Container extensions the bot accepts when Telegram doesn't report a video MIME type. */
const VIDEO_EXTENSIONS = [
  "mov", "mp4", "m4v", "mkv", "webm", "avi", "3gp", "3g2", "mpg", "mpeg", "mpe",
  "mts", "m2ts", "ts", "wmv", "flv", "ogv", "vob", "mxf", "dv",
];
const VIDEO_EXT_RE = new RegExp(`\\.(${VIDEO_EXTENSIONS.join("|")})$`, "i");

export function isVideoFileName(name: string): boolean {
  return VIDEO_EXT_RE.test(name);
}

export function isVideoMime(mime: string | undefined): boolean {
  return Boolean(mime && mime.toLowerCase().startsWith("video/"));
}

/** The download name, like "IMG_0001.mp4" for "IMG_0001.MOV". Unsafe characters are removed. */
export function mp4FileName(sourceName: string): string {
  return `${baseName(sourceName)}.mp4`;
}

/**
 * The conversion: the same "Convert to MP4 (same dimensions)" settings the
 * Sendable bot uses (H.264 CRF 20, AAC 128k stereo, +faststart, no metadata),
 * which keep the original resolution and never upscale.
 */
export function mp4Choice(): SizeChoice {
  const preset = findPreset("convert");
  if (!preset) throw new Error("The \"convert\" preset is missing from sizes.ts");
  return presetChoice(preset);
}

type VideoInfo = {
  fileId: string;
  fileName: string;
  sizeBytes?: number;
  duration?: number;
};

const cancelKeyboard = () => new InlineKeyboard().text("Cancel", "cancel");

export const mp4Messages = {
  welcome: (limitMB: number) =>
    `Hi! I convert videos to MP4. Send me a video in almost any format (MOV, MKV, WebM, AVI, 3GP and more), ` +
    `and I'll send back a standard MP4 with H.264 video and AAC audio.\n\n` +
    `The resolution stays the same, iPhone rotation is applied so the video plays upright, and location data is removed. ` +
    `Videos up to ${limitMB} MB work best. Your original file is never changed.\n\n` +
    `Send a video to get started, or tap /help.`,

  help: (limitMB: number, maxOutputMB: number) =>
    `Send me a video and I'll convert it to an MP4.\n\n` +
    `1. Send a video as a video or as a file (📎 → File) to keep the full quality of the original.\n` +
    `2. Wait while I convert it. Longer videos take longer.\n` +
    `3. Download the MP4 I send back.\n\n` +
    `Limits: videos up to ${limitMB} MB, and MP4s up to ${maxOutputMB} MB (Telegram's limit for bots). ` +
    `Re-encoding can change detail slightly. Your original is never changed.\n\n` +
    `Commands:\n/help: show this message\n/cancel: stop the current conversion`,

  working: (percent?: number) =>
    `Converting to MP4${percent !== undefined ? ` (${percent}%)` : ""}…\n` +
    `Longer videos take longer. You can keep chatting in the meantime.`,

  queued: "You're in line. I'll start converting as soon as possible.",

  busy: "I'm still converting your last video. Wait for it to finish, or tap /cancel.",

  tooLarge: (size: string, limitMB: number) =>
    `This video is ${size}, which is over this bot's ${limitMB} MB limit. Try a shorter video. Nothing was saved.`,

  notVideo:
    "That doesn't look like a video. Send a video file (MOV, MP4, MKV, WebM, AVI and more), or tap /help.",

  uploadFailed: "The download didn't finish. Check your connection and send the video again.",

  failed:
    "I couldn't convert this video. Make sure it's a complete video file, then send it again. Your original is unchanged.",

  outputTooLarge: (size: string, limitMB: number) =>
    `The MP4 is ${size}, which is over the ${limitMB} MB Telegram lets bots send, so I can't send it here. Try a shorter video.`,

  cancelled: "Cancelled. Your original is unchanged. Send another video whenever you're ready.",

  finished: "Done ✅",

  caption: (original: string, converted: string) =>
    `MP4 ready. Original: ${original}, MP4: ${converted}. Your original is unchanged.`,

  nothingToCancel: "There's nothing to cancel right now. Send a video to get started.",

  expired: "That button has expired. Send the video again to start a new conversion.",
} as const;

export function createMp4Bot(config: Mp4BotConfig, ffmpegBinary: string) {
  const bot = new Bot(config.token, { client: { apiRoot: config.apiRoot } });
  const jobs = new Semaphore(config.maxConcurrentJobs);
  /** One conversion at a time per chat, keyed by chat id. */
  const active = new Map<number, AbortController>();
  const choice = mp4Choice();
  const maxInputBytes = config.maxUploadMB * MB;
  const maxOutputBytes = config.maxOutputMB * MB;
  const source: TelegramFileSource = {
    api: bot.api,
    apiRoot: config.apiRoot,
    token: config.token,
    localApi: config.localApi,
  };

  const runConversion = async (chatId: number, video: VideoInfo, controller: AbortController) => {
    let workDir: string | undefined;
    let statusId: number | undefined;
    let release: (() => void) | undefined;

    const setStatus = async (text: string, withCancel = true) => {
      if (!statusId) return;
      await bot.api
        .editMessageText(chatId, statusId, text, withCancel ? { reply_markup: cancelKeyboard() } : {})
        .catch(() => undefined);
    };
    const say = (text: string) => bot.api.sendMessage(chatId, text).catch(() => undefined);

    try {
      workDir = await mkdtemp(path.join(tmpdir(), "mp4bot-"));
      const status = await bot.api.sendMessage(chatId, jobs.isFull ? mp4Messages.queued : mp4Messages.working(), {
        reply_markup: cancelKeyboard(),
      });
      statusId = status.message_id;

      release = await jobs.acquire(controller.signal);
      await setStatus(mp4Messages.working());

      const input = await downloadTelegramFile(source, video.fileId, path.join(workDir, "input"), controller.signal).catch(
        (error: unknown) => {
          if (controller.signal.aborted) throw new CancelledError();
          throw new DownloadError(error);
        },
      );
      const inputBytes = video.sizeBytes ?? (await stat(input)).size;

      const outputName = mp4FileName(video.fileName);
      const output = path.join(workDir, outputName);
      let lastEdit = Date.now();
      let lastPercent = -1;

      const result = await resizeVideo({
        binary: ffmpegBinary,
        input,
        output,
        choice,
        duration: video.duration,
        signal: controller.signal,
        onProgress: (fraction) => {
          const percent = Math.floor(fraction * 100);
          if (Date.now() - lastEdit < PROGRESS_EDIT_MS || percent === lastPercent || percent >= 100) return;
          lastEdit = Date.now();
          lastPercent = percent;
          void setStatus(mp4Messages.working(percent));
        },
      });

      if (controller.signal.aborted) throw new CancelledError();

      const outBytes = (await stat(output)).size;
      if (outBytes > maxOutputBytes) {
        await setStatus(mp4Messages.outputTooLarge(formatMB(outBytes), config.maxOutputMB), false);
        await say(mp4Messages.outputTooLarge(formatMB(outBytes), config.maxOutputMB));
        return;
      }

      await bot.api.sendVideo(chatId, new InputFile(output, outputName), {
        caption: mp4Messages.caption(formatMB(inputBytes), formatMB(outBytes)),
        width: result.width,
        height: result.height,
        duration: result.duration ? Math.round(result.duration) : undefined,
        supports_streaming: true,
      });
      await setStatus(mp4Messages.finished, false);
    } catch (error) {
      if (error instanceof CancelledError || controller.signal.aborted) {
        await setStatus(mp4Messages.cancelled, false);
        return;
      }
      if (error instanceof DownloadError) {
        console.error("Download failed:", error.reason);
        await setStatus(mp4Messages.uploadFailed, false);
        return;
      }
      console.error(`MP4 conversion failed for chat ${chatId}:`, error);
      await setStatus(mp4Messages.failed, false);
      await say(mp4Messages.failed);
    } finally {
      release?.();
      if (active.get(chatId) === controller) active.delete(chatId);
      if (workDir) await rm(workDir, { recursive: true, force: true }).catch(() => undefined);
    }
  };

  const acceptVideo = async (ctx: Context, video: VideoInfo) => {
    const chatId = ctx.chat!.id;
    if (active.has(chatId)) {
      await ctx.reply(mp4Messages.busy);
      return;
    }
    if (video.sizeBytes !== undefined && video.sizeBytes > maxInputBytes) {
      await ctx.reply(mp4Messages.tooLarge(formatMB(video.sizeBytes), config.maxUploadMB));
      return;
    }

    const controller = new AbortController();
    active.set(chatId, controller);
    // Not awaited: a long conversion must not hold up updates from other chats.
    void runConversion(chatId, video, controller).catch((error) => console.error("MP4 job crashed:", error));
  };

  /* ---------- commands ---------- */

  bot.command("start", (ctx) => ctx.reply(mp4Messages.welcome(config.maxUploadMB)));

  bot.command("help", (ctx) => ctx.reply(mp4Messages.help(config.maxUploadMB, config.maxOutputMB)));

  bot.command("cancel", async (ctx) => {
    const controller = active.get(ctx.chat.id);
    if (controller) {
      controller.abort(); // runConversion edits the status message to "Cancelled".
      return;
    }
    await ctx.reply(mp4Messages.nothingToCancel);
  });

  /* ---------- incoming videos ---------- */

  bot.on("message:video", (ctx) => {
    const v = ctx.message.video;
    return acceptVideo(ctx, {
      fileId: v.file_id,
      fileName: v.file_name ?? "video.mp4",
      sizeBytes: v.file_size,
      duration: v.duration,
    });
  });

  bot.on("message:document", async (ctx) => {
    const doc = ctx.message.document;
    const name = doc.file_name ?? "video";
    if (!isVideoMime(doc.mime_type) && !isVideoFileName(name)) {
      await ctx.reply(mp4Messages.notVideo);
      return;
    }
    await acceptVideo(ctx, { fileId: doc.file_id, fileName: name, sizeBytes: doc.file_size });
  });

  bot.on("message:animation", (ctx) => {
    const a = ctx.message.animation;
    return acceptVideo(ctx, {
      fileId: a.file_id,
      fileName: a.file_name ?? "animation.mp4",
      sizeBytes: a.file_size,
      duration: a.duration,
    });
  });

  bot.on("message:video_note", (ctx) => {
    const n = ctx.message.video_note;
    return acceptVideo(ctx, {
      fileId: n.file_id,
      fileName: "video_note.mp4",
      sizeBytes: n.file_size,
      duration: n.duration,
    });
  });

  /* ---------- buttons ---------- */

  bot.callbackQuery("cancel", async (ctx) => {
    const controller = active.get(ctx.chat!.id);
    if (controller) {
      await ctx.answerCallbackQuery({ text: "Cancelling…" });
      controller.abort();
    } else {
      await ctx.answerCallbackQuery({ text: "Nothing to cancel" });
      await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => undefined);
    }
  });

  bot.on("callback_query:data", (ctx) => ctx.answerCallbackQuery({ text: mp4Messages.expired }));

  bot.on("message", (ctx) => ctx.reply(mp4Messages.notVideo));

  bot.catch((err) => {
    const description = err.error instanceof GrammyError ? err.error.description : err.error;
    console.error(`Error while handling update ${err.ctx.update.update_id}:`, description);
  });

  const stop = async () => {
    for (const controller of active.values()) controller.abort();
  };

  return { bot, stop };
}

/** Wraps a failure to download the file, so it can be told apart from ffmpeg errors. */
class DownloadError extends Error {
  constructor(readonly reason: unknown) {
    super("Download failed");
    this.name = "DownloadError";
  }
}

export async function registerMp4Commands(bot: Bot) {
  await bot.api.setMyCommands([
    { command: "start", description: "Start over" },
    { command: "help", description: "How it works and the limits" },
    { command: "cancel", description: "Stop the current conversion" },
  ]);
  await bot.api.setMyShortDescription("Converts almost any video to a standard MP4 (H.264 + AAC) at the original resolution.");
}
