/**
 * A small streaming multipart/form-data reader.
 *
 * Node has no built-in multipart parser, and video uploads are far too large to
 * buffer in memory, so file parts are written straight to disk as the bytes
 * arrive. Only text fields (preset names, dimensions) are kept in memory, and
 * even those have a size cap.
 */

import type { Readable } from "node:stream";

export type MultipartFile = {
  field: string;
  filename: string;
  contentType: string;
  path: string;
  bytes: number;
};

export type MultipartResult = {
  fields: Record<string, string>;
  files: MultipartFile[];
};

/** Where one file part should be written. */
export type FileSink = {
  path: string;
  write: (chunk: Buffer) => Promise<void>;
  close: () => Promise<void>;
};

export type MultipartOptions = {
  /** Hard cap on the whole request body, in bytes. */
  maxBytes: number;
  /** Largest accepted text field, in bytes. */
  maxFieldBytes?: number;
  /** Opens the destination for a file part; called once per file part. */
  openFile: (info: { field: string; filename: string; contentType: string }) => Promise<FileSink>;
};

export class PayloadTooLargeError extends Error {
  constructor(limit: number) {
    super(`Upload is larger than the ${limit} byte limit.`);
    this.name = "PayloadTooLargeError";
  }
}

export class MalformedMultipartError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MalformedMultipartError";
  }
}

/** Pulls the boundary out of a multipart Content-Type header. */
export function parseBoundary(contentType: string | undefined): string | undefined {
  if (!contentType) return undefined;
  const match = /;\s*boundary=("([^"]+)"|([^;]+))/i.exec(contentType);
  const boundary = (match?.[2] ?? match?.[3] ?? "").trim();
  return boundary ? boundary : undefined;
}

function parseHeaders(block: string): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const line of block.split("\r\n")) {
    const index = line.indexOf(":");
    if (index > 0) headers[line.slice(0, index).trim().toLowerCase()] = line.slice(index + 1).trim();
  }
  return headers;
}

function parseDisposition(header: string | undefined): { name: string; filename?: string } {
  const name = /;\s*name="([^"]*)"/i.exec(header ?? "")?.[1] ?? "";
  const filename = /;\s*filename="([^"]*)"/i.exec(header ?? "")?.[1];
  return { name, ...(filename !== undefined ? { filename } : {}) };
}

/**
 * Reads a multipart body. Resolves once the closing boundary has been seen.
 * Rejects (and the caller should destroy the request) when the body is larger
 * than `maxBytes` or the framing is broken.
 */
export async function readMultipart(
  body: Readable,
  boundary: string,
  options: MultipartOptions,
): Promise<MultipartResult> {
  const { maxBytes, openFile } = options;
  const maxFieldBytes = options.maxFieldBytes ?? 16 * 1024;

  const start = Buffer.from(`--${boundary}`);
  const delimiter = Buffer.from(`\r\n--${boundary}`);
  // A part body must never be flushed while it could still contain the tail of
  // a boundary, so this many trailing bytes are always held back.
  const holdBack = delimiter.length + 2;

  const fields: Record<string, string> = {};
  const files: MultipartFile[] = [];

  type State = "preamble" | "separator" | "headers" | "body" | "done";
  let buffer: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  let received = 0;
  let state: State = "preamble";
  let headers: Record<string, string> = {};
  let fieldChunks: Buffer[] = [];
  let fieldBytes = 0;
  let sink: FileSink | undefined;
  let sinkField = "";
  let sinkName = "";
  let sinkType = "";
  let sinkBytes = 0;

  const append = (chunk: Buffer<ArrayBufferLike>) => {
    received += chunk.length;
    if (received > maxBytes) throw new PayloadTooLargeError(maxBytes);
    buffer = buffer.length === 0 ? chunk : Buffer.concat([buffer, chunk]);
  };

  const writePartChunk = async (chunk: Buffer) => {
    if (chunk.length === 0) return;
    if (sink) {
      await sink.write(chunk);
      sinkBytes += chunk.length;
      return;
    }
    fieldBytes += chunk.length;
    if (fieldBytes > maxFieldBytes) throw new MalformedMultipartError("Text field is too large.");
    fieldChunks.push(chunk);
  };

  const closePart = async () => {
    if (sink) {
      await sink.close();
      files.push({
        field: sinkField,
        filename: sinkName,
        contentType: sinkType,
        path: sink.path,
        bytes: sinkBytes,
      });
      sink = undefined;
      sinkBytes = 0;
      return;
    }
    const name = headers["content-disposition"] ? parseDisposition(headers["content-disposition"]).name : "";
    if (name) fields[name] = Buffer.concat(fieldChunks).toString("utf8");
    fieldChunks = [];
    fieldBytes = 0;
  };

  const openPart = async () => {
    const disposition = parseDisposition(headers["content-disposition"]);
    if (!disposition.name) throw new MalformedMultipartError("A part has no name.");
    sinkField = disposition.name;
    sinkName = disposition.filename ?? "";
    sinkType = headers["content-type"] ?? "application/octet-stream";
    if (sinkName) sink = await openFile({ field: sinkField, filename: sinkName, contentType: sinkType });
  };

  /** Consumes as much of the buffer as the current state allows. */
  const drain = async (): Promise<State> => {
    for (;;) {
      if (state === "preamble") {
        const index = buffer.indexOf(start);
        if (index < 0) {
          // Keep the tail: the boundary may be split across chunks.
          if (buffer.length > start.length) buffer = buffer.subarray(buffer.length - start.length);
          return state;
        }
        buffer = buffer.subarray(index + start.length);
        state = "separator";
        continue;
      }

      if (state === "separator") {
        // A boundary is followed by "--" (end of body) or CRLF (another part),
        // and that pair can arrive in a later chunk than the boundary itself.
        if (buffer.length < 2) return state;
        if (buffer.subarray(0, 2).equals(Buffer.from("--"))) {
          state = "done";
          return state;
        }
        if (!buffer.subarray(0, 2).equals(Buffer.from("\r\n"))) {
          throw new MalformedMultipartError("Expected a new part after a boundary.");
        }
        buffer = buffer.subarray(2);
        state = "headers";
        continue;
      }

      if (state === "headers") {
        const end = buffer.indexOf("\r\n\r\n");
        if (end < 0) {
          if (buffer.length > 16 * 1024) throw new MalformedMultipartError("Part headers are too large.");
          return state;
        }
        headers = parseHeaders(buffer.subarray(0, end).toString("utf8"));
        buffer = buffer.subarray(end + 4);
        await openPart();
        state = "body";
        continue;
      }

      if (state === "body") {
        const index = buffer.indexOf(delimiter);
        if (index >= 0) {
          await writePartChunk(buffer.subarray(0, index));
          await closePart();
          buffer = buffer.subarray(index + delimiter.length);
          state = "separator";
          continue;
        }
        if (buffer.length > holdBack) {
          const flushTo = buffer.length - holdBack;
          await writePartChunk(buffer.subarray(0, flushTo));
          buffer = buffer.subarray(flushTo);
        }
        return state;
      }

      return state; // done
    }
  };

  try {
    for await (const chunk of body) {
      append(chunk as Buffer<ArrayBufferLike>);
      state = await drain();
      if (state === "done") break;
    }
    if (state !== "done") {
      throw new MalformedMultipartError("The upload ended before the closing boundary.");
    }
    return { fields, files };
  } catch (error) {
    if (sink) await sink.close().catch(() => undefined);
    throw error;
  }
}
