/**
 * File-naming helpers shared by the Telegram bot and the web conversion API.
 */

import type { SizeChoice } from "./sizes.js";
import { findPreset } from "./sizes.js";

/** Strips folders and unsafe characters from an uploaded file name. */
export function baseName(name: string): string {
  const leaf = name.replace(/\\/g, "/").split("/").pop() ?? "";
  return (
    leaf
      .replace(/\.[^.]+$/, "")
      .replace(/[\u0000-\u001f\u007f<>:"|?*]/g, "_")
      .slice(0, 120) || "video"
  );
}

/** A download name that says what was done, like "IMG_0001_480p.mp4". */
export function outputFileName(sourceName: string, choice: SizeChoice): string {
  const base = baseName(sourceName);
  if (choice.kind === "custom") return `${base}_${choice.width}x${choice.height}.mp4`;
  const preset = findPreset(choice.key);
  const suffix = preset?.shortSide ? `${preset.shortSide}p` : preset?.alwaysSend ? "mp4" : "hq";
  return `${base}_${suffix}.mp4`;
}
