/**
 * Everything the bot says, matching the message guide on the Sendable website.
 */

const archiveDisclosure =
  "When you create a preview, the finished copy will also be saved in the bot owner's Telegram archive channel. Anyone with access to that channel—including the public if it is public—may view it.";

const welcomeText = (limitMB: number, archiveEnabled = false) =>
  `Hi, I'm Sendable. Send an iPhone video and I'll convert it to a standard MP4, or make a smaller copy, for you to review. ` +
  `Videos up to ${limitMB} MB work best. Re-encoding can change detail slightly, and not every video can be made smaller without a quality trade-off. Your original is never changed.\n\n` +
  `Tip: send it as a file (📎 → File) to keep the full quality of your original.` +
  (archiveEnabled ? `\n\n${archiveDisclosure}` : "");

export const messages = {
  welcome: welcomeText,

  /** Shown when someone opens the bot from the website after signing in there (start payload "web-<id>"). */
  welcomeFromSite: (limitMB: number, archiveEnabled = false) =>
    `Connected! You signed in on the Sendable website, and this chat is where your resized videos arrive.\n\n` +
    welcomeText(limitMB, archiveEnabled),

  /** Sent by the login endpoint right after a website sign-in verifies. */
  siteLoginGreeting: (firstName: string) =>
    `Hi ${firstName}! You just signed in on the Sendable website. ✅\n\n` +
    `You're connected: send a video here whenever you want a smaller copy to preview and download.`,

  help: (limitMB: number, allowCustom: boolean, archiveEnabled = false) =>
    `I make a copy of a video you send.\n\n` +
    `1. Send a video (MOV or MP4, up to ${limitMB} MB).\n` +
    `2. Choose Convert to MP4 (same dimensions) to get a standard MP4 at the original size, ` +
    `High quality (same dimensions), Recommended (720p), or Smaller (480p)` +
    `${allowCustom ? ", or your own width and height" : ""}.\n` +
    `3. Preview it and check the real file size before downloading.\n\n` +
    `Convert to MP4 always sends the MP4, even if it's bigger. The size options only send a copy that's smaller than your original. ` +
    `Re-encoding can change detail slightly. Your original is never changed.\n\n` +
    (archiveEnabled ? `${archiveDisclosure}\n\n` : "") +
    `Commands:\n/help: show this message\n/cancel: stop the current resize`,

  gotIt: (name: string, size: string, length?: string, archiveEnabled = false) =>
    `Got it: ${name} (${size}${length ? `, ${length}` : ""}). What matters most to you? ` +
    `Pick a size below. You can review the result before downloading.` +
    (archiveEnabled ? `\n\n${archiveDisclosure}` : ""),

  tooLarge: (name: string, size: string, limitMB: number) =>
    `${name} is ${size}, which is over this bot's current ${limitMB} MB limit. ` +
    `Try a shorter video, or one saved at a smaller size. Nothing was saved.`,

  notSupported: "I can't read this video. Please send a MOV or MP4 file, or tap /help.",

  askCustom:
    "Enter a width and height in pixels, like 720 x 1280. I'll fit the video inside those dimensions so it keeps its shape.",

  customFormat: "Enter a width and height in pixels, like 720 x 1280.",

  customTooLarge: (max: number) =>
    `Those dimensions are above this bot's ${max} pixel limit. Choose a smaller width and height.`,

  confirmConvert: (label: string) =>
    `I'll convert this video to an MP4 using ${label}. The resolution stays the same, and the MP4 is sent even if it's bigger than your original. ` +
    `Re-encoding can change detail slightly. Your original stays unchanged, and this MP4 isn't saved to the archive channel. Create the MP4 now?`,

  confirm: (label: string) =>
    `I'll make a copy using ${label}. Re-encoding can change detail slightly, and this setting may not make every file smaller. ` +
    `You'll see the real size before downloading. Your original stays unchanged. Create a preview first?`,

  queued: "You're in line. I'll start your preview as soon as possible.",

  processing: (percent?: number) =>
    `Preparing your preview${percent !== undefined ? ` (${percent}%)` : ""}…\n` +
    `Longer videos take longer. You can keep chatting in the meantime.`,

  previewReady: (
    original: string,
    resized: string,
    label: string,
    smaller: boolean,
    archived = false,
  ) =>
    `Your preview is ready.\n\n` +
    `${label}\nOriginal: ${original}\nNew copy: ${resized}\n\n` +
    (smaller
      ? "Watch it and check the size before downloading. Re-encoding can change detail slightly."
      : "This setting didn't make the file smaller. Try a smaller size instead.") +
    (archived ? "\n\nA copy was saved to the bot owner's Telegram archive channel." : ""),

  convertReady: (original: string, converted: string, label: string) =>
    `Your MP4 is ready.\n\n` +
    `${label}\nOriginal: ${original}\nNew MP4: ${converted}\n\n` +
    `The resolution is unchanged. Check it before downloading. The MP4 may be bigger or smaller than the original.`,

  saveHint:
    "Here's the file. Tap the download icon on it to save it, or Share to send it. Your original is still unchanged.",

  pickAgain: "No problem. Pick a different size below.",
  sendAnother: "Sure. Send me another video whenever you're ready.",
  cancelled: "Cancelled. Your original is unchanged. Pick a size when you're ready.",
  nothingToCancel: "There's nothing to cancel right now. Send a video to get started.",
  sendVideoFirst: "Please send a video first. Tap /help to see how it works.",
  expired: "That button has expired. Please send the video again.",
  busy: "I'm still working on your last preview. Wait for it to finish, or tap /cancel.",
  idleText: "Send me a video to get started, or tap /help.",

  uploadFailed: "The upload didn't finish. Check your connection and send the video again.",
  previewFailed: "I couldn't make a preview this time. Your original is unchanged. Please try once more.",
  outputTooLarge: (size: string, limitMB: number) =>
    `The new copy is ${size}, which is over the ${limitMB} MB Telegram lets me send back. Try a smaller size.`,
  noSizeReduction:
    "This setting didn't make the file smaller, so I haven't sent or stored a larger copy. Your original is unchanged. Try 720p or 480p if reducing the size matters more.",
  archiveFailed:
    "I couldn't save the preview to the configured archive channel, so I haven't sent an unarchived copy. Please try again later or contact the bot owner.",
} as const;

export const buttons = {
  differentVideo: "Send a different video",
  createPreview: "Create preview",
  changeSize: "Change size",
  cancel: "Cancel",
  download: "Download this version",
  tryAnother: "Try another size",
  tryAgain: "Try again",
  custom: "Custom dimensions",
} as const;
