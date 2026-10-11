import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

type VercelConfig = {
  functions: Record<string, { maxDuration?: number; includeFiles?: string }>;
  crons: Array<{ path: string; schedule: string }>;
  rewrites: Array<{ source: string; destination: string }>;
};

type PackageConfig = {
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
};

const config = JSON.parse(readFileSync(new URL("../vercel.json", import.meta.url), "utf8")) as VercelConfig;
const packageConfig = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as PackageConfig;

test("Vercel function entries reference existing API routes and bundle FFmpeg where needed", () => {
  for (const [route, options] of Object.entries(config.functions)) {
    assert.ok(existsSync(new URL(`../${route}`, import.meta.url)), `${route} should exist`);
    assert.equal(options.maxDuration, 60, `${route} should use the documented function deadline`);
  }
  assert.equal(
    config.functions["api/convert.ts"]?.includeFiles,
    "node_modules/ffmpeg-static-electron-v5-linux-x64/**",
  );
  assert.equal(
    config.functions["api/telegram/webhook.ts"]?.includeFiles,
    "node_modules/ffmpeg-static-electron-v5-linux-x64/**",
  );
});

test("the Vercel FFmpeg package is optional so Docker can use system FFmpeg", () => {
  assert.equal(packageConfig.optionalDependencies?.["ffmpeg-static-electron-v5-linux-x64"], "^5.2.5");
  assert.equal(packageConfig.dependencies?.["ffmpeg-static-electron-v5-linux-x64"], undefined);
});

test("Vercel maps the root download and health paths to API functions", () => {
  assert.ok(config.rewrites.some(({ source, destination }) => source === "/download" && destination === "/api/download"));
  assert.ok(config.rewrites.some(({ source, destination }) => source === "/health" && destination === "/api/health"));
  assert.ok(config.rewrites.some(({ source, destination }) => source === "/" && destination === "/api/health"));
  assert.ok(config.crons.some(({ path }) => path === "/api/cleanup"));
});
