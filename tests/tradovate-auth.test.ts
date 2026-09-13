import assert from "node:assert/strict";
import test from "node:test";
import { parseTradovateAuthResponse } from "../src/lib/tradovate";

const now = Date.parse("2026-09-13T22:00:00Z");
test("a real token is a session, with the broker's expiry when it is sane", () => {
  const r = parseTradovateAuthResponse({ accessToken: "abc", expirationTime: "2026-09-14T21:00:00Z" }, now);
  assert.equal(r.ok, true); if (r.ok) { assert.equal(r.token, "abc"); assert.equal(new Date(r.expires).toISOString(), "2026-09-14T21:00:00.000Z"); }
  const fallback = parseTradovateAuthResponse({ accessToken: "abc", expirationTime: "garbage" }, now);
  if (fallback.ok) assert.equal(fallback.expires, now + 23 * 3600_000);
});
test("a p-ticket / captcha challenge is NOT a session: rate limits back off past the hour, others 20 minutes", () => {
  const rl = parseTradovateAuthResponse({ "p-ticket": "x", "p-time": 15, "p-captcha": true, "p-message": "Rate limit exceeded: more than 5 requests per hour" }, now);
  assert.equal(rl.ok, false); if (!rl.ok) { assert.match(rl.message, /Rate limit/); assert.equal(rl.backoffUntil, now + 65 * 60_000); }
  const cap = parseTradovateAuthResponse({ "p-ticket": "x", "p-captcha": true }, now);
  if (!cap.ok) assert.equal(cap.backoffUntil, now + 20 * 60_000);
  const empty = parseTradovateAuthResponse({}, now);
  assert.equal(empty.ok, false);
  const err = parseTradovateAuthResponse({ errorText: "Incorrect username or password" }, now);
  if (!err.ok) assert.match(err.message, /Incorrect/);
});
