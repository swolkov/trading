import assert from "node:assert/strict";
import test from "node:test";
import { displayCache, isTransientKrakenError, withReadRetry } from "../src/lib/kraken-read";

// Kraken's one rate counter and one nonce per key are shared by the dashboard, the guardian
// and the executor. Reads retry once on a transient error; display routes share a snapshot.

test("transient errors are the rate limit, the nonce, and busy — nothing else", () => {
  assert.equal(isTransientKrakenError(new Error("Kraken OpenPositions: EAPI:Rate limit exceeded")), true);
  assert.equal(isTransientKrakenError(new Error("Kraken TradeBalance: EAPI:Invalid nonce")), true);
  assert.equal(isTransientKrakenError("EService:Busy"), true);
  assert.equal(isTransientKrakenError(new Error("EOrder:Insufficient funds")), false);
  assert.equal(isTransientKrakenError(new Error("EGeneral:Invalid arguments")), false);
});

test("withReadRetry retries once on a transient error and rethrows anything else", async () => {
  let calls = 0; const slept: number[] = [];
  const sleep = async (ms: number) => { slept.push(ms); };
  const flaky = async () => { calls++; if (calls === 1) throw new Error("EAPI:Rate limit exceeded"); return "ok"; };
  assert.equal(await withReadRetry(flaky, { sleep }), "ok");
  assert.deepEqual({ calls, slept }, { calls: 2, slept: [1500] });
  calls = 0;
  await assert.rejects(withReadRetry(async () => { calls++; throw new Error("EOrder:Insufficient funds"); }, { sleep }), /Insufficient funds/);
  assert.equal(calls, 1, "a real error is never retried");
  calls = 0;
  await assert.rejects(withReadRetry(async () => { calls++; throw new Error("EAPI:Rate limit exceeded"); }, { sleep }), /Rate limit/);
  assert.equal(calls, 2, "one retry, then give up");
});

test("displayCache shares one in-flight read, honours the TTL, and serves a stale value only on a transient failure", async () => {
  let t = 1_000_000; let reads = 0; let fail: string | null = null;
  const read = async () => { reads++; await new Promise((r) => setTimeout(r, 5)); if (fail) throw new Error(fail); return { n: reads }; };
  const get = displayCache(read, { ttlMs: 20_000, graceMs: 90_000, now: () => t });
  const [a, b, c] = await Promise.all([get(), get(), get()]);
  assert.deepEqual([a.value.n, b.value.n, c.value.n, reads], [1, 1, 1, 1], "three concurrent callers, one Kraken read");
  t += 10_000;
  assert.equal((await get()).value.n, 1, "inside the TTL the snapshot is reused");
  t += 15_000;
  assert.equal((await get()).value.n, 2, "past the TTL it re-reads");
  t += 25_000; fail = "EAPI:Rate limit exceeded";
  const s = await get();
  assert.deepEqual({ n: s.value.n, stale: s.stale }, { n: 2, stale: true }, "transient failure inside the grace window → last snapshot, marked stale");
  fail = "EGeneral:Invalid arguments";
  await assert.rejects(get(), /Invalid arguments/, "a real error is never papered over");
  fail = "EAPI:Rate limit exceeded"; t += 100_000;
  await assert.rejects(get(), /Rate limit/, "past the grace window a transient failure surfaces");
});
