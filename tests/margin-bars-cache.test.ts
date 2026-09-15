import assert from "node:assert/strict";
import test from "node:test";
import { prisma } from "../src/lib/db";
import { SNAPSHOT_BUDGET_MS, completeBars, sinceFor, snapshotBars4h } from "../src/lib/margin-bars-cache";
import { SCAN_UNIVERSE } from "../src/lib/kraken-pairs";

// C6 — the daily 4h snapshot must be INCREMENTAL (since = the newest stored bar), one multi-row
// insert per coin, and bounded by its own 30 s wall clock. It runs after the synthesis is stamped.

const restores: (() => void)[] = [];
function stub(object: object, key: string, value: unknown) { const prev = Reflect.get(object, key); Reflect.set(object, key, value); restores.push(() => Reflect.set(object, key, prev)); }
function restore() { while (restores.length) restores.pop()!(); }

test("since derivation: the newest stored t, or a full backfill when nothing is stored", () => {
  assert.equal(sinceFor(1_800_000_000), 1_800_000_000);
  assert.equal(sinceFor(null), undefined);
  assert.equal(sinceFor(undefined), undefined);
  assert.equal(sinceFor(0), undefined);
  assert.equal(sinceFor(NaN), undefined);
  assert.equal(SNAPSHOT_BUDGET_MS, 30_000);
});

test("only complete bars are kept: the in-progress 4h bar and bad prices are dropped", () => {
  const now = 1_800_000_000;
  const bars = [{ t: now - 14400 * 2, o: 1, h: 2, l: 0.5, c: 1.5, v: 1 }, { t: now - 14400, o: 1, h: 2, l: 0.5, c: 1.5, v: 1 }, { t: now - 100, o: 1, h: 2, l: 0.5, c: 1.5, v: 1 }, { t: now - 14400 * 3, o: NaN, h: 2, l: 0.5, c: 1.5, v: 1 }];
  assert.deepEqual(completeBars(bars, now).map((b) => b.t), [now - 28800, now - 14400]);
});

test("the snapshot asks Kraken only for bars after MAX(t), inserts them in ONE statement per coin, and never re-inserts the newest stored bar", async () => {
  const now = 1_800_000_000;
  const stored = now - 14400 * 3;   // newest stored bar: three 4h bars ago
  const urls: string[] = []; const sql: string[] = [];
  stub(prisma, "$executeRawUnsafe", async (q: string) => { sql.push(q); return /INSERT INTO margin_bars_4h/.test(q) ? (q.match(/\(\$1,/g) ?? []).length : 0; });
  stub(prisma, "$queryRawUnsafe", async (q: string) => { sql.push(q); return /MAX\(t\)/.test(q) ? [{ t: BigInt(stored) }] : []; });
  stub(prisma.agentConfig, "upsert", async () => null);
  stub(globalThis, "fetch", async (url: string) => {
    urls.push(String(url));
    // Kraken echoes `since` (exclusive) — it returns the bar AT since as well; the snapshot must drop it.
    const rows = [stored, stored + 14400, stored + 28800, now - 100].map((t) => [t, "1", "2", "0.5", "1.5", "0", "9"]);
    return { json: async () => ({ error: [], result: { X: rows, last: now } }) };
  });
  try {
    const r = await snapshotBars4h({ now: () => now * 1000 });
    assert.equal(r.coins, SCAN_UNIVERSE.length);
    assert.equal(r.stoppedForBudget, false);
    assert.equal(r.inserted, SCAN_UNIVERSE.length * 2, "two new complete bars per coin; the echoed newest and the forming bar are dropped");
    assert.ok(urls.every((u) => u.includes(`since=${stored}`)), "every OHLC call carries since = MAX(t)");
    const inserts = sql.filter((q) => /INSERT INTO margin_bars_4h/.test(q));
    assert.equal(inserts.length, SCAN_UNIVERSE.length, "one multi-row insert per coin");
    assert.ok(inserts.every((q) => /ON CONFLICT \(symbol, t\) DO NOTHING/.test(q) && (q.match(/\(\$1,/g) ?? []).length === 2));
  } finally { restore(); }
});

test("the snapshot stops at its wall-clock budget and says so; a coin that errors never stops the others", async () => {
  let clock = 0;
  const sql: string[] = [];
  stub(prisma, "$executeRawUnsafe", async (q: string) => { sql.push(q); return 1; });
  stub(prisma, "$queryRawUnsafe", async () => [{ t: null }]);
  stub(prisma.agentConfig, "upsert", async () => null);
  stub(globalThis, "fetch", async () => { throw new Error("feed down"); });
  try {
    const r = await snapshotBars4h({ budgetMs: 1000, now: () => { clock += 600; return clock; } });
    assert.equal(r.stoppedForBudget, true);
    assert.ok(r.coins < SCAN_UNIVERSE.length);
    assert.match(r.errors[r.errors.length - 1], /stopped after \d+ coins: 1s budget/);
    assert.ok(r.errors.some((e) => /feed down/.test(e)), "the failing coin is reported, not fatal");
  } finally { restore(); }
});
