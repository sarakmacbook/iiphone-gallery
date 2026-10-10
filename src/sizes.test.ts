import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { buildArgs, CancelledError, resizeVideo, resolveFfmpeg } from "./ffmpeg.js";
import { crfFor, findPreset, formatDuration, formatMB, isConvertOnly, parseCustomSize, presetChoice, scaleFilter } from "./sizes.js";

test("parseCustomSize accepts common formats", () => {
  for (const input of ["720 x 1280", "720x1280", "720 X 1280", "720*1280", "720, 1280", "720 1280", "720×1280px"]) {
    const result = parseCustomSize(input, 3840);
    assert.ok(result.ok, input);
    if (result.ok && result.choice.kind === "custom") {
      assert.equal(result.choice.width, 720);
      assert.equal(result.choice.height, 1280);
    }
  }
});

test("parseCustomSize rejects bad and oversized input", () => {
  assert.deepEqual(parseCustomSize("big please", 3840), { ok: false, reason: "format" });
  assert.deepEqual(parseCustomSize("0 x 100", 3840), { ok: false, reason: "format" });
  assert.deepEqual(parseCustomSize("720.5 x 1280", 3840), { ok: false, reason: "format" });
  assert.deepEqual(parseCustomSize("5000 x 1280", 3840), { ok: false, reason: "tooLarge" });
});

test("formatting helpers", () => {
  assert.equal(formatMB(86 * 1024 * 1024), "86 MB");
  assert.equal(formatMB(2.25 * 1024 * 1024), "2.3 MB");
  assert.equal(formatDuration(47), "0:47");
  assert.equal(formatDuration(3725), "1:02:05");
  assert.equal(formatDuration(undefined), undefined);
});

test("high-quality preset keeps dimensions and prioritizes visual quality", () => {
  const preset = findPreset("keep");
  assert.ok(preset);
  const choice = presetChoice(preset);
  assert.equal(preset.shortSide, null);
  assert.equal(crfFor(choice), 18);
  assert.match(scaleFilter(choice), /trunc\(iw\/2\)\*2/);
  const args = buildArgs("input.mov", "output.mp4", choice);
  assert.equal(args[args.indexOf("-crf") + 1], "18");
});

const ffmpeg = process.env.FFMPEG_PATH || resolveFfmpeg();
const hasFfmpeg = spawnSync(ffmpeg, ["-version"]).status === 0;

function makeVideo(dir: string, width: number, height: number) {
  const file = path.join(dir, `in_${width}x${height}.mov`);
  const result = spawnSync(ffmpeg, [
    "-hide_banner", "-loglevel", "error", "-y",
    "-f", "lavfi", "-i", `testsrc2=size=${width}x${height}:rate=30:duration=2`,
    "-f", "lavfi", "-i", "sine=frequency=440:duration=2",
    "-c:v", "libx264", "-preset", "ultrafast", "-crf", "12", "-c:a", "aac", "-shortest", file,
  ]);
  assert.equal(result.status, 0, result.stderr.toString());
  return file;
}

test("resizes portrait and landscape videos without stretching", { skip: !hasFfmpeg && "ffmpeg not found" }, async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "sendable-test-"));
  try {
    const portrait = makeVideo(dir, 1080, 1920);
    const landscape = makeVideo(dir, 1920, 1080);

    const cases = [
      { input: portrait, choice: presetChoice(findPreset("balanced")!), expect: [720, 1280] },
      { input: landscape, choice: presetChoice(findPreset("balanced")!), expect: [1280, 720] },
      { input: portrait, choice: presetChoice(findPreset("smaller")!), expect: [480, 854] },
      { input: portrait, choice: presetChoice(findPreset("keep")!), expect: [1080, 1920] },
      // Fit inside a box, keeping the shape.
      { input: landscape, choice: (parseCustomSize("720 x 1280", 3840) as any).choice, expect: [720, 406] },
      // Never upscale.
      { input: landscape, choice: (parseCustomSize("3840 x 3840", 3840) as any).choice, expect: [1920, 1080] },
    ];

    for (const [i, c] of cases.entries()) {
      const output = path.join(dir, `out_${i}.mp4`);
      let progressCalls = 0;
      const result = await resizeVideo({
        binary: ffmpeg,
        input: c.input,
        output,
        choice: c.choice,
        onProgress: () => progressCalls++,
      });
      assert.deepEqual([result.width, result.height], c.expect, `case ${i}: ${c.choice.label}`);
      assert.ok(statSync(output).size > 0);
      assert.ok(result.duration && Math.abs(result.duration - 2) < 0.2, `duration ${result.duration}`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("cancelling stops ffmpeg", { skip: !hasFfmpeg && "ffmpeg not found" }, async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "sendable-test-"));
  try {
    const input = makeVideo(dir, 1920, 1080);
    const controller = new AbortController();
    const job = resizeVideo({
      binary: ffmpeg,
      input,
      output: path.join(dir, "out.mp4"),
      choice: presetChoice(findPreset("keep")!),
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 20);
    await assert.rejects(job, CancelledError);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("convert-to-MP4 keeps dimensions, is always sent, and is not a size-reducing preset", () => {
  const preset = findPreset("convert");
  assert.ok(preset);
  const choice = presetChoice(preset);
  assert.equal(preset.shortSide, null);
  assert.equal(preset.alwaysSend, true);
  assert.equal(isConvertOnly(choice), true);
  assert.equal(isConvertOnly(presetChoice(findPreset("keep")!)), false);
  assert.equal(isConvertOnly(presetChoice(findPreset("balanced")!)), false);
  assert.equal(isConvertOnly((parseCustomSize("720 x 1280", 3840) as any).choice), false);

  const args = buildArgs("input.mov", "output.mp4", choice);
  assert.equal(args[args.indexOf("-c:v") + 1], "libx264");
  assert.equal(args[args.indexOf("-c:a") + 1], "aac");
  assert.equal(args[args.indexOf("-pix_fmt") + 1], "yuv420p");
  assert.equal(args[args.indexOf("-movflags") + 1], "+faststart");
  assert.equal(args[args.indexOf("-map_metadata") + 1], "-1");
  assert.equal(args[args.indexOf("-crf") + 1], String(preset.crf));
});

const hasHevc =
  hasFfmpeg && spawnSync(ffmpeg, ["-hide_banner", "-encoders"]).stdout.toString().includes("libx265");

/**
 * Builds a clip like an iPhone recording: HEVC, stored landscape, with a 90° display
 * rotation so it plays as portrait.
 */
function makeIphoneClip(dir: string): string {
  const landscape = path.join(dir, "land.mov");
  const made = spawnSync(ffmpeg, [
    "-hide_banner", "-loglevel", "error", "-y",
    "-f", "lavfi", "-i", "testsrc2=size=1920x1080:rate=30:duration=2",
    "-f", "lavfi", "-i", "sine=frequency=440:duration=2",
    "-c:v", "libx265", "-preset", "ultrafast", "-crf", "28", "-tag:v", "hvc1",
    "-c:a", "aac", "-shortest", "-x265-params", "log-level=error", landscape,
  ]);
  assert.equal(made.status, 0, made.stderr.toString());
  const rotated = path.join(dir, "iphone.mov");
  const remux = spawnSync(ffmpeg, [
    "-hide_banner", "-loglevel", "error", "-y",
    "-display_rotation", "90", "-i", landscape, "-c", "copy", rotated,
  ]);
  assert.equal(remux.status, 0, remux.stderr.toString());
  return rotated;
}

test("convert-to-MP4 turns an iPhone HEVC clip into an upright H.264 MP4", { skip: !hasHevc && "ffmpeg with libx265 not found" }, async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "sendable-test-"));
  try {
    const input = makeIphoneClip(dir);

    const output = path.join(dir, "converted.mp4");
    const result = await resizeVideo({
      binary: ffmpeg,
      input,
      output,
      choice: presetChoice(findPreset("convert")!),
    });
    // The display matrix is applied: portrait 1080x1920, not stored 1920x1080.
    assert.deepEqual([result.width, result.height], [1080, 1920]);
    assert.ok(result.duration && Math.abs(result.duration - 2) < 0.2, `duration ${result.duration}`);

    const probe = spawnSync(ffmpeg, ["-hide_banner", "-i", output]);
    const info = probe.stderr.toString();
    assert.match(info, /Video: h264/);
    assert.match(info, /Audio: aac/);
    assert.match(info, /mp4|isom/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
