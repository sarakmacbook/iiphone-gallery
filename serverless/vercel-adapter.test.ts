import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { toVercelHandler } from "./vercel-adapter.js";

test("Vercel Node adapter converts streamed JSON requests and streamed Responses", async (t) => {
  const server = createServer(
    toVercelHandler(async (request) => {
      if (request.method !== "POST") return new Response("wrong method", { status: 405 });
      const payload = (await request.json()) as { value?: string };
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(`received:${payload.value}`));
          controller.close();
        },
      });
      return new Response(stream, { status: 201, headers: { "content-type": "text/plain" } });
    }),
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))));

  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const response = await fetch(`http://127.0.0.1:${address.port}/api/test`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ value: "ok" }),
  });
  assert.equal(response.status, 201);
  assert.equal(response.headers.get("content-type"), "text/plain");
  assert.equal(await response.text(), "received:ok");
});
