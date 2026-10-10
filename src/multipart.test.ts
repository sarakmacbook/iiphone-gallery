import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { test } from "node:test";
import {
  MalformedMultipartError,
  PayloadTooLargeError,
  parseBoundary,
  readMultipart,
  type FileSink,
} from "./multipart.js";
import { open } from "node:fs/promises";

const BOUNDARY = "----WebKitFormBoundaryABC123";

function body(parts: Array<{ headers: string; data: Buffer | string }>): Buffer {
  const chunks: Buffer[] = [];
  for (const part of parts) {
    chunks.push(Buffer.from(`--${BOUNDARY}\r\n${part.headers}\r\n\r\n`));
    chunks.push(typeof part.data === "string" ? Buffer.from(part.data) : part.data);
    chunks.push(Buffer.from("\r\n"));
  }
  chunks.push(Buffer.from(`--${BOUNDARY}--\r\n`));
  return Buffer.concat(chunks);
}

/** Feeds the body in deliberately awkward chunk sizes. */
function stream(body_: Buffer, chunkSize: number): Readable {
  const chunks: Buffer[] = [];
  for (let i = 0; i < body_.length; i += chunkSize) chunks.push(body_.subarray(i, i + chunkSize));
  return Readable.from(chunks);
}

/** Writes every file part into `dir`, returning the sink list for assertions. */
function makeOpener(dir: string) {
  const sinks: Array<{ path: string; field: string; filename: string; contentType: string }> = [];
  const openFile = async (info: { field: string; filename: string; contentType: string }): Promise<FileSink> => {
    const target = path.join(dir, `part-${sinks.length}`);
    sinks.push({ path: target, ...info });
    const handle = await open(target, "w");
    let position = 0;
    return {
      path: target,
      write: async (chunk) => {
        await handle.write(chunk, 0, chunk.length, position);
        position += chunk.length;
      },
      close: () => handle.close().then(() => undefined),
    };
  };
  return { sinks, openFile };
}

test("parseBoundary reads quoted and plain boundaries", () => {
  assert.equal(
    parseBoundary(`multipart/form-data; boundary=${BOUNDARY}`),
    BOUNDARY,
  );
  assert.equal(parseBoundary(`multipart/form-data; boundary="${BOUNDARY}"`), BOUNDARY);
  assert.equal(parseBoundary("multipart/form-data; charset=utf-8; boundary=xyz"), "xyz");
  assert.equal(parseBoundary("application/json"), undefined);
  assert.equal(parseBoundary(undefined), undefined);
});

test("reads text fields and a file, whatever the chunk size", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "sendable-multipart-"));
  try {
    const payload = Buffer.alloc(80_000);
    for (let i = 0; i < payload.length; i++) payload[i] = i % 251;
    const raw = body([
      { headers: 'content-disposition: form-data; name="preset"', data: "smaller" },
      {
        headers: `content-disposition: form-data; name="video"; filename="IMG 0001.MOV"\r\ncontent-type: video/quicktime`,
        data: payload,
      },
      { headers: 'content-disposition: form-data; name="note"', data: "hello" },
    ]);

    for (const chunkSize of [1, 7, 511, 64 * 1024]) {
      const { sinks, openFile } = makeOpener(dir);
      const result = await readMultipart(stream(raw, chunkSize), BOUNDARY, { maxBytes: 10_000_000, openFile });

      assert.equal(result.fields.preset, "smaller", `chunkSize ${chunkSize}`);
      assert.equal(result.fields.note, "hello", `chunkSize ${chunkSize}`);
      assert.equal(result.files.length, 1, `chunkSize ${chunkSize}`);
      assert.equal(result.files[0]!.filename, "IMG 0001.MOV");
      assert.equal(result.files[0]!.contentType, "video/quicktime");
      assert.equal(result.files[0]!.bytes, payload.length, `chunkSize ${chunkSize}`);
      assert.deepEqual(readFileSync(sinks[0]!.path), payload, `chunkSize ${chunkSize}`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("enforces the body size limit", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "sendable-multipart-"));
  try {
    const raw = body([
      {
        headers: 'content-disposition: form-data; name="video"; filename="a.mp4"',
        data: Buffer.alloc(50_000),
      },
    ]);
    const { openFile } = makeOpener(dir);
    await assert.rejects(
      readMultipart(stream(raw, 4096), BOUNDARY, { maxBytes: 10_000, openFile }),
      PayloadTooLargeError,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("rejects a body that ends without the closing boundary", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "sendable-multipart-"));
  try {
    const raw = body([
      { headers: 'content-disposition: form-data; name="preset"', data: "smaller" },
    ]).subarray(0, 60);
    const { openFile } = makeOpener(dir);
    await assert.rejects(
      readMultipart(stream(raw, 8), BOUNDARY, { maxBytes: 10_000, openFile }),
      MalformedMultipartError,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
