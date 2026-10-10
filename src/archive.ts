/**
 * Telegram-channel-backed archive for completed, smaller video conversions.
 * This is an append-only media archive, not a relational database.
 */

export type ArchiveChat = {
  type: string;
  username?: string;
  title?: string;
};

export type ArchiveMember = {
  status: string;
  can_post_messages?: boolean;
};

export type ArchiveRecord = {
  sourceName: string;
  sourceBytes?: number;
  outputBytes: number;
  preset: string;
  width?: number;
  height?: number;
  savedAt?: string;
};

/** Accept a Telegram channel ID (usually -100...) or a public @channel username. */
export function normalizeArchiveChatId(input?: string): string | undefined {
  const value = input?.trim();
  if (!value) return undefined;
  if (/^-?\d{1,20}$/.test(value) || /^@[A-Za-z][A-Za-z0-9_]{4,31}$/.test(value)) return value;
  throw new Error(
    'TELEGRAM_ARCHIVE_CHAT_ID must be a numeric Telegram channel ID (for example "-1001234567890") or @channelusername.',
  );
}

/** Fail fast unless the destination is a channel the bot can safely post to. */
export function validateArchiveTarget(
  chat: ArchiveChat,
  member: ArchiveMember,
  allowPublic: boolean,
): void {
  if (chat.type !== "channel") {
    throw new Error("TELEGRAM_ARCHIVE_CHAT_ID must point to a Telegram channel.");
  }
  if (chat.username && !allowPublic) {
    throw new Error(
      `The archive channel @${chat.username} is public. Use a private channel, or explicitly set TELEGRAM_ARCHIVE_ALLOW_PUBLIC=true.`,
    );
  }
  if (member.status !== "creator" && !(member.status === "administrator" && member.can_post_messages)) {
    throw new Error(
      "The bot must be a channel administrator with permission to post messages in the archive channel.",
    );
  }
}

function safeText(value: string, maxLength: number): string {
  return value
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength) || "unknown";
}

/** A compact, searchable record stored as the archived video's caption. */
export function formatArchiveCaption(record: ArchiveRecord): string {
  const dimensions =
    record.width && record.height ? `${record.width} × ${record.height}` : "unknown";
  return [
    "Sendable archive record",
    `Saved (UTC): ${record.savedAt ?? new Date().toISOString()}`,
    `Source: ${safeText(record.sourceName, 120)}`,
    `Original bytes: ${record.sourceBytes ?? "unknown"}`,
    `Converted bytes: ${record.outputBytes}`,
    `Preset: ${safeText(record.preset, 100)}`,
    `Dimensions: ${dimensions}`,
  ].join("\n");
}
