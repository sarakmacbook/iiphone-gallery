import assert from "node:assert/strict";
import { test } from "node:test";
import {
  formatArchiveCaption,
  normalizeArchiveChatId,
  validateArchiveTarget,
} from "./archive.js";

test("normalizeArchiveChatId accepts a numeric ID or channel username", () => {
  assert.equal(normalizeArchiveChatId(undefined), undefined);
  assert.equal(normalizeArchiveChatId("  -1001234567890  "), "-1001234567890");
  assert.equal(normalizeArchiveChatId("@MyPrivateArchive"), "@MyPrivateArchive");
});

test("normalizeArchiveChatId rejects malformed targets", () => {
  assert.throws(() => normalizeArchiveChatId("not a channel"), /TELEGRAM_ARCHIVE_CHAT_ID/);
  assert.throws(() => normalizeArchiveChatId("@x"), /TELEGRAM_ARCHIVE_CHAT_ID/);
});

test("validateArchiveTarget requires a channel and posting permission", () => {
  const admin = { status: "administrator", can_post_messages: true };
  assert.doesNotThrow(() => validateArchiveTarget({ type: "channel" }, admin, false));
  assert.throws(
    () => validateArchiveTarget({ type: "supergroup" }, admin, false),
    /must point to a Telegram channel/,
  );
  assert.throws(
    () => validateArchiveTarget({ type: "channel" }, { status: "member" }, false),
    /administrator with permission/,
  );
  assert.throws(
    () => validateArchiveTarget({ type: "channel" }, { status: "administrator" }, false),
    /administrator with permission/,
  );
});

test("public archives require an explicit opt-in", () => {
  const publicChannel = { type: "channel", username: "OpenArchive" };
  const admin = { status: "administrator", can_post_messages: true };
  assert.throws(() => validateArchiveTarget(publicChannel, admin, false), /is public/);
  assert.doesNotThrow(() => validateArchiveTarget(publicChannel, admin, true));
});

test("archive captions are searchable and strip control characters", () => {
  const caption = formatArchiveCaption({
    sourceName: "family\nclip.mov",
    sourceBytes: 1200,
    outputBytes: 800,
    preset: "High quality (same dimensions)",
    width: 1080,
    height: 1920,
    savedAt: "2026-10-10T00:00:00.000Z",
  });
  assert.match(caption, /Source: family clip\.mov/);
  assert.match(caption, /Original bytes: 1200/);
  assert.match(caption, /Converted bytes: 800/);
  assert.match(caption, /Dimensions: 1080 × 1920/);
  assert.ok(!caption.includes("\nclip"));
});
