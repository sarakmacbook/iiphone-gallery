import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import { createServer } from "node:http";
import { test } from "node:test";
import { handleTelegramLoginRequest, sanitizeAuthData, verifyTelegramAuth } from "./auth.js";

const TOKEN = "123456789:AAHtest-token-for-auth-tests-only-not-real";

/** Builds a widget payload and signs it exactly the way Telegram does. */
function signPayload(
  fields: Record<string, string | number>,
  token = TOKEN,
): Record<string, string> {
  const data: Record<string, string> = {};
  for (const [key, value] of Object.entries(fields)) data[key] = String(value);
  const checkString = Object.keys(data)
    .sort()
    .map((key) => `${key}=${data[key]}`)
    .join("\n");
  const secret = createHash("sha256").update(token, "utf8").digest();
  data.hash = createHmac("sha256", secret).update(checkString, "utf8").digest("hex");
  return data;
}

const validFields = () => ({
  id: 42,
  first_name: "Sara",
  last_name: "K",
  username: "sara_k",
  photo_url: "https://t.me/i/userpic/320/sara.jpg",
  auth_date: Math.floor(Date.now() / 1000),
});

test("verifyTelegramAuth accepts a correctly signed payload", () => {
  const result = verifyTelegramAuth(TOKEN, signPayload(validFields()));
  assert.ok(result.ok, JSON.stringify(result));
  assert.equal(result.user.id, 42);
  assert.equal(result.user.firstName, "Sara");
  assert.equal(result.user.lastName, "K");
  assert.equal(result.user.username, "sara_k");
  assert.equal(result.user.photoUrl, "https://t.me/i/userpic/320/sara.jpg");
});

test("verifyTelegramAuth accepts a minimal payload (no username or photo)", () => {
  const fields = validFields();
  delete (fields as Record<string, unknown>).username;
  delete (fields as Record<string, unknown>).photo_url;
  delete (fields as Record<string, unknown>).last_name;
  const result = verifyTelegramAuth(TOKEN, signPayload(fields));
  assert.ok(result.ok);
  assert.equal(result.user.username, undefined);
  assert.equal(result.user.photoUrl, undefined);
  assert.equal(result.user.lastName, undefined);
});

test("verifyTelegramAuth rejects tampered fields", () => {
  const payload = signPayload(validFields());
  payload.first_name = "Someone Else";
  const result = verifyTelegramAuth(TOKEN, payload);
  assert.equal(result.ok, false);
});

test("verifyTelegramAuth rejects a payload signed with another token", () => {
  const payload = signPayload(validFields(), "987654321:AAHsome-other-bot-token-value-here-x");
  const result = verifyTelegramAuth(TOKEN, payload);
  assert.equal(result.ok, false);
});

test("verifyTelegramAuth rejects bad, missing, or stale hashes and dates", () => {
  const fresh = signPayload(validFields());
  assert.equal(verifyTelegramAuth(TOKEN, { ...fresh, hash: "nope" }).ok, false);
  assert.equal(verifyTelegramAuth(TOKEN, { ...fresh, hash: "ab".repeat(64) }).ok, false);

  const { hash: _hash, ...withoutHash } = fresh;
  assert.equal(verifyTelegramAuth(TOKEN, withoutHash).ok, false);

  const old = signPayload({ ...validFields(), auth_date: Math.floor(Date.now() / 1000) - 90_000 });
  assert.equal(verifyTelegramAuth(TOKEN, old).ok, false);
  // …but a 23-hour-old payload is still fine with the 24h default.
  const day = signPayload({ ...validFields(), auth_date: Math.floor(Date.now() / 1000) - 82_800 });
  assert.ok(verifyTelegramAuth(TOKEN, day).ok);

  const future = signPayload({ ...validFields(), auth_date: Math.floor(Date.now() / 1000) + 3_600 });
  assert.equal(verifyTelegramAuth(TOKEN, future).ok, false);

  const incomplete = signPayload({ id: 42, auth_date: Math.floor(Date.now() / 1000) });
  assert.equal(verifyTelegramAuth(TOKEN, incomplete).ok, false);
});

test("sanitizeAuthData flattens widget payloads and rejects anything else", () => {
  assert.deepEqual(sanitizeAuthData({ id: 42, auth_date: 1700000000, first_name: "Sara" }), {
    id: "42",
    auth_date: "1700000000",
    first_name: "Sara",
  });
  assert.equal(sanitizeAuthData(null), null);
  assert.equal(sanitizeAuthData("hash=abc"), null);
  assert.equal(sanitizeAuthData([1, 2]), null);
  assert.equal(sanitizeAuthData({ id: { nested: true } }), null);
});

/* ---------- the HTTP endpoint, end to end ---------- */

async function withLoginServer(
  corsOrigin: string,
  run: (base: string) => Promise<void>,
): Promise<void> {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname === "/telegram/login") {
      void handleTelegramLoginRequest(req, res, {
        token: TOKEN,
        corsOrigin,
        maxAgeSeconds: 86400,
      });
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  try {
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}

test("POST /telegram/login verifies payloads and answers JSON", async () => {
  await withLoginServer("*", async (base) => {
    const ok = await fetch(`${base}/telegram/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(signPayload(validFields())),
    });
    assert.equal(ok.status, 200);
    assert.equal(ok.headers.get("access-control-allow-origin"), "*");
    const body = await ok.json();
    assert.equal(body.ok, true);
    assert.equal(body.user.first_name, "Sara");
    assert.equal(body.user.username, "sara_k");

    const tampered = signPayload(validFields());
    tampered.id = "43";
    const bad = await fetch(`${base}/telegram/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(tampered),
    });
    assert.equal(bad.status, 403);
    assert.equal((await bad.json()).ok, false);

    const junk = await fetch(`${base}/telegram/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "not json",
    });
    assert.equal(junk.status, 400);

    const wrongMethod = await fetch(`${base}/telegram/login`);
    assert.equal(wrongMethod.status, 405);
  });
});

test("OPTIONS preflight and CORS origin lists behave", async () => {
  await withLoginServer("https://sendable.vercel.app,https://staging.example", async (base) => {
    const preflight = await fetch(`${base}/telegram/login`, {
      method: "OPTIONS",
      headers: { origin: "https://sendable.vercel.app" },
    });
    assert.equal(preflight.status, 204);
    assert.equal(
      preflight.headers.get("access-control-allow-origin"),
      "https://sendable.vercel.app",
    );
    assert.match(preflight.headers.get("access-control-allow-headers") ?? "", /Content-Type/i);

    const stranger = await fetch(`${base}/telegram/login`, {
      method: "OPTIONS",
      headers: { origin: "https://evil.example" },
    });
    assert.equal(stranger.headers.get("access-control-allow-origin"), null);
  });
});
