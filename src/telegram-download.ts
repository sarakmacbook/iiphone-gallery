/**
 * Downloads a file a person sent to a bot. Shared by the Sendable bot and the
 * MP4 converter bot so both handle the self-hosted Bot API the same way.
 */

import { createWriteStream } from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import type { Api } from "grammy";

export type TelegramFileSource = {
  api: Api;
  apiRoot: string;
  token: string;
  /** True when apiRoot is a self-hosted Bot API server in --local mode. */
  localApi: boolean;
};

/** Returns the local path ffmpeg should read: the original path on a local Bot API server, otherwise `destination`. */
export async function downloadTelegramFile(
  source: TelegramFileSource,
  fileId: string,
  destination: string,
  signal: AbortSignal,
): Promise<string> {
  const file = await source.api.getFile(fileId);
  if (!file.file_path) throw new Error("Telegram did not return a file path");

  // A self-hosted Bot API server in --local mode returns an absolute path on its own disk.
  if (source.localApi && path.isAbsolute(file.file_path)) return file.file_path;

  const url = `${source.apiRoot}/file/bot${source.token}/${file.file_path}`;
  const response = await fetch(url, { signal });
  if (!response.ok || !response.body) throw new Error(`Download failed with HTTP ${response.status}`);
  await pipeline(
    Readable.fromWeb(response.body as unknown as WebReadableStream<Uint8Array>),
    createWriteStream(destination),
  );
  return destination;
}
