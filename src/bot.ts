import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Bot, GrammyError, InlineKeyboard, InputFile, type Context } from "grammy";
import { formatArchiveCaption } from "./archive.js";
import type { Config } from "./config.js";
import { CancelledError, resizeVideo } from "./ffmpeg.js";
import { buttons, messages } from "./messages.js";
import { outputFileName } from "./paths.js";
import { Semaphore } from "./semaphore.js";
import { downloadTelegramFile } from "./telegram-download.js";
import {
  PRESETS,
  findPreset,
  formatDuration,
  formatMB,
  isConvertOnly,
  parseCustomSize,
  presetChoice,
  type SizeChoice,
} from "./sizes.js";

type VideoInfo = {
  fileId: string;
  fileName: string;
  sizeBytes?: number;
  duration?: number;
};

type Preview = {
  /** Present when the preview lives in the optional Telegram channel archive. */
  archiveMessageId?: number;
  /** Present only when the preview is held temporarily on local disk. */
  dir?: string;
  file?: string;
  fileName: string;
};

type Session = {
  stage: "idle" | "choose" | "custom" | "confirm" | "processing" | "preview";
  video?: VideoInfo;
  choice?: SizeChoice;
  job?: AbortController;
  preview?: Preview;
  touched: number;
};

const SUPPORTED_MIME = new Set(["video/mp4", "video/quicktime", "video/x-m4v"]);
const SUPPORTED_EXT = /\.(mov|mp4|m4v)$/i;
const SESSION_TTL_MS = 6 * 60 * 60 * 1000;
const PROGRESS_EDIT_MS = 4000;

function sizeKeyboard(allowCustom: boolean) {
  const keyboard = new InlineKeyboard();
  for (const preset of PRESETS) keyboard.text(preset.label, `size:${preset.key}`).row();
  if (allowCustom) keyboard.text(buttons.custom, "size:custom").row();
  return keyboard.text(buttons.differentVideo, "new");
}

function sizeDetails(allowCustom: boolean) {
  const lines = PRESETS.map((preset) => `• ${preset.label}: ${preset.detail}`);
  if (allowCustom) lines.push(`• ${buttons.custom}: Enter a width and height in pixels.`);
  return lines.join("\n");
}

const confirmKeyboard = () =>
  new InlineKeyboard().text(buttons.createPreview, "go").row().text(buttons.changeSize, "change");

const cancelKeyboard = () => new InlineKeyboard().text(buttons.cancel, "cancel");

const previewKeyboard = (archiveMessageId?: number) =>
  new InlineKeyboard()
    .text(buttons.download, archiveMessageId ? `download:${archiveMessageId}` : "download")
    .row()
    .text(buttons.tryAnother, "change")
    .row()
    .text(buttons.differentVideo, "new");

const retryKeyboard = () =>
  new InlineKeyboard().text(buttons.tryAgain, "go").row().text(buttons.changeSize, "change");

async function removeDir(dir?: string) {
  if (dir) await rm(dir, { recursive: true, force: true }).catch(() => undefined);
}

export function createBot(config: Config, ffmpegBinary: string) {
  const bot = new Bot(config.token, { client: { apiRoot: config.apiRoot } });
  const sessions = new Map<number, Session>();
  const jobs = new Semaphore(config.maxConcurrentJobs);

  const getSession = (chatId: number) => {
    let session = sessions.get(chatId);
    if (!session) {
      session = { stage: "idle", touched: Date.now() };
      sessions.set(chatId, session);
    }
    session.touched = Date.now();
    return session;
  };

  const clearPreview = async (session: Session) => {
    const old = session.preview;
    session.preview = undefined;
    await removeDir(old?.dir);
  };

  // Forget idle chats and delete their leftover files.
  const sweep = setInterval(() => {
    const cutoff = Date.now() - SESSION_TTL_MS;
    for (const [chatId, session] of sessions) {
      if (session.touched < cutoff && !session.job) {
        void clearPreview(session);
        sessions.delete(chatId);
      }
    }
  }, 30 * 60 * 1000);
  sweep.unref();

  /** Removes the buttons from the message that was tapped so it can't be tapped twice. */
  const dropButtons = async (ctx: Context) => {
    await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => undefined);
  };

  const runJob = async (chatId: number, session: Session) => {
    const video = session.video;
    const choice = session.choice;
    if (!video || !choice) return;

    const controller = new AbortController();
    session.job = controller;
    session.stage = "processing";
    await clearPreview(session);

    const workDir = await mkdtemp(path.join(tmpdir(), "sendable-"));
    let keepWorkDir = false;
    let release: (() => void) | undefined;
    let statusId: number | undefined;

    const setStatus = async (text: string, withCancel = true) => {
      if (!statusId) return;
      await bot.api
        .editMessageText(chatId, statusId, text, withCancel ? { reply_markup: cancelKeyboard() } : {})
        .catch(() => undefined);
    };

    try {
      const status = await bot.api.sendMessage(
        chatId,
        jobs.isFull ? messages.queued : messages.processing(),
        { reply_markup: cancelKeyboard() },
      );
      statusId = status.message_id;

      release = await jobs.acquire(controller.signal);
      await setStatus(messages.processing());

      let input: string;
      try {
        input = await downloadTelegramFile(
          { api: bot.api, apiRoot: config.apiRoot, token: config.token, localApi: config.localApi },
          video.fileId,
          path.join(workDir, "input"),
          controller.signal,
        );
      } catch (error) {
        if (controller.signal.aborted) throw new CancelledError();
        console.error("Download failed:", error);
        await setStatus(messages.uploadFailed, false);
        session.stage = "idle";
        return;
      }

      const outputName = outputFileName(video.fileName, choice);
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
          void setStatus(messages.processing(percent));
        },
      });

      const outBytes = (await stat(output)).size;
      if (outBytes > config.maxOutputMB * 1024 * 1024) {
        await setStatus(messages.outputTooLarge(formatMB(outBytes), config.maxOutputMB), false);
        await bot.api.sendMessage(chatId, messages.pickAgain, { reply_markup: sizeKeyboard(config.allowCustom) });
        session.stage = "choose";
        return;
      }

      if (controller.signal.aborted) throw new CancelledError();

      const inputBytes = video.sizeBytes ?? (await stat(input)).size;
      // "Convert to MP4" is a format change, so it is always sent. Size options never send a larger copy.
      const convertOnly = isConvertOnly(choice);
      const smaller = outBytes < inputBytes;
      if (!convertOnly && !smaller) {
        await setStatus(messages.noSizeReduction, false);
        await bot.api.sendMessage(chatId, messages.noSizeReduction, {
          reply_markup: sizeKeyboard(config.allowCustom),
        });
        session.choice = undefined;
        session.stage = "choose";
        return;
      }

      if (controller.signal.aborted) throw new CancelledError();

      let archiveMessageId: number | undefined;
      let outgoingVideo: InputFile | string = new InputFile(output, outputName);
      // The archive only keeps reduced copies, so conversions that keep the size are not archived.
      if (config.archiveChatId && !convertOnly) {
        try {
          const archived = await bot.api.sendVideo(
            config.archiveChatId,
            new InputFile(output, outputName),
            {
              caption: formatArchiveCaption({
                sourceName: video.fileName,
                sourceBytes: inputBytes,
                outputBytes: outBytes,
                preset: choice.label,
                width: result.width,
                height: result.height,
              }),
              width: result.width,
              height: result.height,
              duration: result.duration ? Math.round(result.duration) : undefined,
              supports_streaming: true,
            },
          );
          archiveMessageId = archived.message_id;
          outgoingVideo = archived.video.file_id;
        } catch (error) {
          console.error("Could not save converted video to the archive channel:", error);
          await setStatus(messages.archiveFailed, false);
          await bot.api.sendMessage(chatId, messages.archiveFailed, {
            reply_markup: retryKeyboard(),
          });
          session.stage = "confirm";
          return;
        }
      }

      await bot.api.sendVideo(chatId, outgoingVideo, {
        caption: convertOnly
          ? messages.convertReady(formatMB(inputBytes), formatMB(outBytes), choice.label)
          : messages.previewReady(
              formatMB(inputBytes),
              formatMB(outBytes),
              choice.label,
              smaller,
              Boolean(archiveMessageId),
            ),
        width: result.width,
        height: result.height,
        duration: result.duration ? Math.round(result.duration) : undefined,
        supports_streaming: true,
        reply_markup: previewKeyboard(archiveMessageId),
      });

      if (statusId) await bot.api.deleteMessage(chatId, statusId).catch(() => undefined);
      session.preview = archiveMessageId
        ? { archiveMessageId, fileName: outputName }
        : { dir: workDir, file: output, fileName: outputName };
      keepWorkDir = !archiveMessageId;
      session.stage = "preview";
    } catch (error) {
      if (error instanceof CancelledError || controller.signal.aborted) {
        await setStatus(messages.cancelled, false);
        await bot.api
          .sendMessage(chatId, sizeDetails(config.allowCustom), { reply_markup: sizeKeyboard(config.allowCustom) })
          .catch(() => undefined);
        session.stage = "choose";
      } else {
        console.error(`Preview failed for chat ${chatId}:`, error);
        await setStatus(messages.previewFailed, false);
        await bot.api
          .sendMessage(chatId, messages.previewFailed, { reply_markup: retryKeyboard() })
          .catch(() => undefined);
        session.stage = "confirm";
      }
    } finally {
      release?.();
      if (session.job === controller) session.job = undefined;
      if (!keepWorkDir) await removeDir(workDir);
    }
  };

  const startJob = (chatId: number, session: Session) => {
    // Not awaited: long conversions must not block other chats' updates.
    void runJob(chatId, session).catch((error) => console.error("Job crashed:", error));
  };

  /* ---------- commands ---------- */

  bot.command("start", async (ctx) => {
    const session = getSession(ctx.chat.id);
    if (!session.job) session.stage = "idle";
    // The website links here with ?start=web-<telegram id> after someone signs in there.
    const payload = typeof ctx.match === "string" ? ctx.match.trim() : "";
    if (/^web-\d{1,18}$/.test(payload)) {
      await ctx.reply(messages.welcomeFromSite(config.maxUploadMB, Boolean(config.archiveChatId)));
      return;
    }
    await ctx.reply(messages.welcome(config.maxUploadMB, Boolean(config.archiveChatId)));
  });

  bot.command("help", (ctx) =>
    ctx.reply(messages.help(config.maxUploadMB, config.allowCustom, Boolean(config.archiveChatId))),
  );

  bot.command("cancel", async (ctx) => {
    const session = getSession(ctx.chat.id);
    if (session.job) {
      session.job.abort(); // runJob sends the "Cancelled" message.
      return;
    }
    if (session.video && session.stage !== "idle") {
      session.stage = "choose";
      session.choice = undefined;
      await ctx.reply(messages.cancelled, { reply_markup: sizeKeyboard(config.allowCustom) });
      return;
    }
    await ctx.reply(messages.nothingToCancel);
  });

  /* ---------- incoming videos ---------- */

  const acceptVideo = async (ctx: Context, video: VideoInfo) => {
    const session = getSession(ctx.chat!.id);
    if (session.job) {
      await ctx.reply(messages.busy);
      return;
    }

    const size = video.sizeBytes !== undefined ? formatMB(video.sizeBytes) : "unknown size";
    if (video.sizeBytes !== undefined && video.sizeBytes > config.maxUploadMB * 1024 * 1024) {
      session.stage = "idle";
      session.video = undefined;
      await ctx.reply(messages.tooLarge(video.fileName, size, config.maxUploadMB));
      return;
    }

    await clearPreview(session);
    session.video = video;
    session.choice = undefined;
    session.stage = "choose";
    await ctx.reply(
      `${messages.gotIt(video.fileName, size, formatDuration(video.duration), Boolean(config.archiveChatId))}\n\n${sizeDetails(config.allowCustom)}`,
      { reply_markup: sizeKeyboard(config.allowCustom) },
    );
  };

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
    const supported = (doc.mime_type && SUPPORTED_MIME.has(doc.mime_type)) || SUPPORTED_EXT.test(name);
    if (!supported) {
      await ctx.reply(messages.notSupported);
      return;
    }
    await acceptVideo(ctx, { fileId: doc.file_id, fileName: name, sizeBytes: doc.file_size });
  });

  bot.on(["message:animation", "message:video_note", "message:photo"], (ctx) =>
    ctx.reply(messages.notSupported),
  );

  /* ---------- text (custom sizes) ---------- */

  bot.on("message:text", async (ctx) => {
    const session = getSession(ctx.chat.id);
    if (session.stage !== "custom") {
      await ctx.reply(session.job ? messages.busy : messages.idleText);
      return;
    }
    const parsed = parseCustomSize(ctx.message.text, config.maxDimension);
    if (!parsed.ok) {
      await ctx.reply(
        parsed.reason === "tooLarge" ? messages.customTooLarge(config.maxDimension) : messages.customFormat,
      );
      return;
    }
    session.choice = parsed.choice;
    session.stage = "confirm";
    await ctx.reply(messages.confirm(parsed.choice.label), { reply_markup: confirmKeyboard() });
  });

  /* ---------- buttons ---------- */

  bot.callbackQuery(/^size:(\w+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const session = getSession(ctx.chat!.id);
    if (session.job) return void (await ctx.reply(messages.busy));
    if (!session.video) return void (await ctx.reply(messages.expired));
    await dropButtons(ctx);

    const key = ctx.match[1]!;
    if (key === "custom" && config.allowCustom) {
      session.stage = "custom";
      await ctx.reply(messages.askCustom);
      return;
    }
    const preset = findPreset(key);
    if (!preset) return;
    session.choice = presetChoice(preset);
    session.stage = "confirm";
    const prompt = isConvertOnly(session.choice) ? messages.confirmConvert(preset.label) : messages.confirm(preset.label);
    await ctx.reply(prompt, { reply_markup: confirmKeyboard() });
  });

  bot.callbackQuery("go", async (ctx) => {
    await ctx.answerCallbackQuery();
    const session = getSession(ctx.chat!.id);
    if (session.job) return void (await ctx.reply(messages.busy));
    if (!session.video || !session.choice) return void (await ctx.reply(messages.expired));
    await dropButtons(ctx);
    startJob(ctx.chat!.id, session);
  });

  bot.callbackQuery("change", async (ctx) => {
    await ctx.answerCallbackQuery();
    const session = getSession(ctx.chat!.id);
    if (session.job) return void (await ctx.reply(messages.busy));
    if (!session.video) return void (await ctx.reply(messages.expired));
    await dropButtons(ctx);
    session.stage = "choose";
    await ctx.reply(`${messages.pickAgain}\n\n${sizeDetails(config.allowCustom)}`, {
      reply_markup: sizeKeyboard(config.allowCustom),
    });
  });

  bot.callbackQuery("cancel", async (ctx) => {
    const session = getSession(ctx.chat!.id);
    if (session.job) {
      await ctx.answerCallbackQuery({ text: "Cancelling…" });
      session.job.abort();
    } else {
      await ctx.answerCallbackQuery({ text: "Nothing to cancel" });
      await dropButtons(ctx);
    }
  });

  bot.callbackQuery("new", async (ctx) => {
    await ctx.answerCallbackQuery();
    const session = getSession(ctx.chat!.id);
    if (session.job) return void (await ctx.reply(messages.busy));
    await dropButtons(ctx);
    await clearPreview(session);
    session.video = undefined;
    session.choice = undefined;
    session.stage = "idle";
    await ctx.reply(messages.sendAnother);
  });

  bot.callbackQuery(/^download(?::(\d+))?$/, async (ctx) => {
    const archiveMessageId = ctx.match[1] ? Number(ctx.match[1]) : undefined;
    if (archiveMessageId !== undefined) {
      if (!config.archiveChatId || !Number.isSafeInteger(archiveMessageId) || archiveMessageId < 1) {
        await ctx.answerCallbackQuery();
        await ctx.reply(messages.expired);
        return;
      }
      await ctx.answerCallbackQuery({ text: "Sending the file…" });
      try {
        await bot.api.copyMessage(ctx.chat!.id, config.archiveChatId, archiveMessageId, {
          caption: messages.saveHint,
        });
      } catch (error) {
        console.error("Copying archived video to the user failed:", error);
        await ctx.reply(messages.previewFailed);
      }
      return;
    }

    const session = getSession(ctx.chat!.id);
    const preview = session.preview;
    if (!preview?.file) {
      await ctx.answerCallbackQuery();
      await ctx.reply(messages.expired);
      return;
    }
    await ctx.answerCallbackQuery({ text: "Sending the file…" });
    await ctx.replyWithChatAction("upload_document").catch(() => undefined);
    try {
      await ctx.replyWithDocument(new InputFile(preview.file, preview.fileName), {
        caption: messages.saveHint,
      });
    } catch (error) {
      console.error("Sending document failed:", error);
      await ctx.reply(messages.previewFailed);
    }
  });

  // Buttons from before a restart, or anything unexpected.
  bot.on("callback_query:data", async (ctx) => {
    await ctx.answerCallbackQuery({ text: "That button has expired." });
  });

  bot.on("message", (ctx) => ctx.reply(messages.idleText));

  bot.catch((err) => {
    const description = err.error instanceof GrammyError ? err.error.description : err.error;
    console.error(`Error while handling update ${err.ctx.update.update_id}:`, description);
  });

  const stop = async () => {
    clearInterval(sweep);
    for (const session of sessions.values()) {
      session.job?.abort();
      await clearPreview(session);
    }
  };

  return { bot, stop };
}

export async function registerCommands(bot: Bot) {
  await bot.api.setMyCommands([
    { command: "start", description: "Start over" },
    { command: "help", description: "How it works and the limits" },
    { command: "cancel", description: "Stop the current resize" },
  ]);
  await bot.api.setMyShortDescription(
    "Try a high-quality iPhone video resize. Preview the size before downloading; original stays unchanged.",
  );
}
