/**
 * Size choices and the ffmpeg scale filters behind them. Kept free of Telegram
 * and ffmpeg process code so it is easy to test.
 */

export type PresetKey = "convert" | "balanced" | "smaller" | "keep";

export type SizeChoice =
  | { kind: "preset"; key: PresetKey; label: string }
  | { kind: "custom"; width: number; height: number; label: string };

export type Preset = {
  key: PresetKey;
  label: string;
  detail: string;
  /** Target length of the video's shorter side, or null to keep dimensions. */
  shortSide: number | null;
  crf: number;
  /**
   * Conversion-only presets (format change, no size goal) are always sent, even if the
   * MP4 ends up bigger than the original. Size-reducing presets never send a larger copy.
   */
  alwaysSend?: boolean;
};

export const PRESETS: Preset[] = [
  {
    key: "convert",
    label: "Convert to MP4 (same dimensions)",
    detail: "Re-encodes to a standard MP4 (H.264 + AAC) at the original resolution. Always sent, even if the file gets bigger.",
    shortSide: null,
    crf: 20,
    alwaysSend: true,
  },
  {
    key: "keep",
    label: "High quality (same dimensions)",
    detail: "Keeps the original resolution and prioritizes detail; savings vary.",
    shortSide: null,
    crf: 18,
  },
  {
    key: "balanced",
    label: "Recommended (720p)",
    detail: "A good place to start for everyday sharing.",
    shortSide: 720,
    crf: 26,
  },
  {
    key: "smaller",
    label: "Smaller (480p)",
    detail: "More reduction; fine details may look softer.",
    shortSide: 480,
    crf: 28,
  },
];

export const CUSTOM_CRF = 18;

export function findPreset(key: string): Preset | undefined {
  return PRESETS.find((preset) => preset.key === key);
}

export function presetChoice(preset: Preset): SizeChoice {
  return { kind: "preset", key: preset.key, label: preset.label };
}

/** True for the format-conversion option, which is sent even when the file doesn't shrink. */
export function isConvertOnly(choice: SizeChoice): boolean {
  return choice.kind === "preset" && findPreset(choice.key)?.alwaysSend === true;
}

export type CustomParseResult =
  | { ok: true; choice: SizeChoice }
  | { ok: false; reason: "format" | "tooLarge" };

/**
 * Accepts "720 x 1280", "720x1280", "720*1280", "720 1280" or "720, 1280".
 */
export function parseCustomSize(input: string, maxDimension: number): CustomParseResult {
  const match = input
    .trim()
    .toLowerCase()
    .match(/^(\d{1,5})\s*(?:x|×|\*|,|\s)\s*(\d{1,5})(?:\s*px)?$/);
  if (!match) return { ok: false, reason: "format" };

  const width = Number(match[1]);
  const height = Number(match[2]);
  if (width < 16 || height < 16) return { ok: false, reason: "format" };
  if (width > maxDimension || height > maxDimension) return { ok: false, reason: "tooLarge" };

  return {
    ok: true,
    choice: { kind: "custom", width, height, label: `Custom: ${width} x ${height} px` },
  };
}

/**
 * Builds the -vf filter. Videos are never stretched and never made larger than
 * the original; every output side is kept even, which H.264 requires.
 * ffmpeg auto-rotates iPhone videos first, so iw/ih are the upright dimensions.
 */
export function scaleFilter(choice: SizeChoice): string {
  if (choice.kind === "custom") {
    const { width, height } = choice;
    return [
      `scale=w='min(${width},iw)':h='min(${height},ih)'`,
      "force_original_aspect_ratio=decrease",
      "force_divisible_by=2",
    ].join(":") + ",setsar=1";
  }

  const preset = findPreset(choice.key);
  if (!preset || preset.shortSide === null) {
    return "scale=w='trunc(iw/2)*2':h='trunc(ih/2)*2',setsar=1";
  }

  // Scale the shorter side to the target (720p works for portrait and landscape).
  const t = preset.shortSide;
  return (
    `scale=w='if(gte(iw,ih),-2,trunc(min(${t},iw)/2)*2)'` +
    `:h='if(gte(iw,ih),trunc(min(${t},ih)/2)*2,-2)',setsar=1`
  );
}

export function crfFor(choice: SizeChoice): number {
  if (choice.kind === "custom") return CUSTOM_CRF;
  return findPreset(choice.key)?.crf ?? CUSTOM_CRF;
}

export function formatMB(bytes: number): string {
  const mb = bytes / (1024 * 1024);
  if (mb >= 10) return `${Math.round(mb)} MB`;
  if (mb >= 0.1) return `${mb.toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

export function formatDuration(seconds: number | undefined): string | undefined {
  if (seconds === undefined || !Number.isFinite(seconds) || seconds <= 0) return undefined;
  const total = Math.round(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${s}` : `${m}:${s}`;
}
