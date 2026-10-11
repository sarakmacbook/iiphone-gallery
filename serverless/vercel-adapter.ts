import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from "node:http";
import { jsonError } from "./http.js";

type VercelIncomingMessage = IncomingMessage & { body?: unknown };
export type VercelNodeHandler = (request: VercelIncomingMessage, response: ServerResponse) => void | Promise<void>;
export type FetchHandler = (request: Request) => Response | Promise<Response>;
type MethodMap = Partial<Record<"GET" | "HEAD" | "POST" | "OPTIONS" | "DELETE" | "PUT", FetchHandler>>;

export function routeMethods(methods: MethodMap): FetchHandler {
  return (request) => {
    const handler = methods[request.method.toUpperCase() as keyof MethodMap];
    if (handler) return handler(request);
    const allow = Object.keys(methods).join(", ");
    return new Response(JSON.stringify({ ok: false, error: { code: "badMethod", message: "Method not allowed." } }), {
      status: 405,
      headers: { "content-type": "application/json; charset=utf-8", Allow: allow },
    });
  };
}

const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "content-length",
  "expect",
  "host",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

function requestHeaders(source: IncomingHttpHeaders): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(source)) {
    if (HOP_BY_HOP_HEADERS.has(name.toLowerCase()) || value === undefined) continue;
    headers.set(name, Array.isArray(value) ? value.join(", ") : value);
  }
  return headers;
}

function requestUrl(request: IncomingMessage): string {
  const host = request.headers["x-forwarded-host"] ?? request.headers.host ?? "localhost";
  const firstHost = Array.isArray(host) ? host[0] : host;
  const protoHeader = request.headers["x-forwarded-proto"];
  const proto = (Array.isArray(protoHeader) ? protoHeader[0] : protoHeader)?.split(",")[0]?.trim() || "https";
  return new URL(request.url ?? "/", `${proto}://${firstHost}`).toString();
}

function parsedBody(body: unknown): BodyInit | undefined {
  if (body === undefined || body === null) return undefined;
  if (typeof body === "string" || body instanceof Buffer || body instanceof ArrayBuffer) return body as BodyInit;
  if (ArrayBuffer.isView(body)) return Buffer.from(body.buffer, body.byteOffset, body.byteLength) as unknown as BodyInit;
  return JSON.stringify(body);
}

/**
 * Adapts a Fetch Request/Response handler to Vercel's Node.js API-function ABI.
 * API routes set bodyParser:false so JSON bodies remain streamable and large
 * accidental bodies are not buffered by Vercel before our handlers see them.
 */
export function toVercelHandler(handler: FetchHandler): VercelNodeHandler {
  return async (incoming, outgoing) => {
    const abort = new AbortController();
    const abortOnClose = () => {
      if (!outgoing.writableEnded) abort.abort(new Error("Client disconnected."));
    };
    outgoing.once("close", abortOnClose);

    try {
      const method = (incoming.method ?? "GET").toUpperCase();
      const headers = requestHeaders(incoming.headers);
      const body = method === "GET" || method === "HEAD" ? undefined : parsedBody(incoming.body);
      const streamBody =
        method !== "GET" && method !== "HEAD" && body === undefined
          ? (Readable.toWeb(incoming) as ReadableStream<Uint8Array>)
          : body;
      const request = new Request(requestUrl(incoming), {
        method,
        headers,
        ...(streamBody !== undefined ? { body: streamBody, duplex: "half" } : {}),
        signal: abort.signal,
      } as RequestInit & { duplex?: "half" });
      const response = await handler(request);
      outgoing.statusCode = response.status;
      response.headers.forEach((value, name) => outgoing.setHeader(name, value));

      if (!response.body || method === "HEAD") {
        outgoing.end();
        return;
      }
      await pipeline(Readable.fromWeb(response.body as import("node:stream/web").ReadableStream), outgoing).catch((error) => {
        if (!outgoing.destroyed && !outgoing.writableEnded) outgoing.destroy(error as Error);
      });
    } catch (error) {
      if (outgoing.headersSent || outgoing.destroyed) {
        if (!outgoing.destroyed) outgoing.destroy(error as Error);
        return;
      }
      const response = jsonError(500, "serverError", "Something went wrong. Please try again.");
      outgoing.statusCode = response.status;
      response.headers.forEach((value, name) => outgoing.setHeader(name, value));
      outgoing.end(await response.text());
    } finally {
      outgoing.off("close", abortOnClose);
    }
  };
}
