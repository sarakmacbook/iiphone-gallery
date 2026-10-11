import { resolveFfmpeg } from "../src/ffmpeg.js";

/** Resolve the bundled ffmpeg-static binary, with an explicit override for local/pro deployments. */
export function serverlessFfmpeg(configured?: string): string {
  const binary = resolveFfmpeg(configured);
  if (process.env.VERCEL === "1" && binary === "ffmpeg") {
    throw new Error("The ffmpeg-static binary is missing from this Vercel function bundle.");
  }
  return binary;
}
