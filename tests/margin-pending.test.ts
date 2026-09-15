import assert from "node:assert/strict";
import test from "node:test";
import { COVERAGE_GAP_SEC, OHLC_TIMEOUT_MS, PENDING_TTL_H, RESOLVE_BUDGET_MS, RESOLVE_MAX_SYMBOLS, RETEST_BAND, coverageGap, resolvePendingEntries, retestTriggered } from "../src/lib/margin-pending";
import { prisma } from "../src/lib/db";
import { autoShadowPlans } from "../src/lib/margin-auto-plans";
import { evaluate, type TfSpec } from "../src/lib/margin-scanner";
import type { KrakenBar } from "../src/lib/kraken-margin";

// C5b — swing-retest: the conditional entry. The rule is pure (retestTriggered); the resolver
// around it is I/O and is exercised by the deploy check in the operating-model doc.

const bar = (t: number, o: number, h: number, l: number, c: number): KrakenBar => ({ t, o, h, l, c, v: 1 });

test("registered constants: 0.5% band, 24h expiry, ≤10 rows per tick, 20 s resolver clock, 8 s per OHLC call, 2-min coverage", () => {
  assert.equal(RETEST_BAND, 0.005);
  assert.equal(PENDING_TTL_H, 24);
  assert.equal(RESOLVE_MAX_SYMBOLS, 10);
  assert.equal(RESOLVE_BUDGET_MS, 20_000);
  assert.equal(OHLC_TIMEOUT_MS, 8_000);
  assert.equal(COVERAGE_GAP_SEC, 120);
});

test("a long must first LEAVE the band (a close > level × 1.005 arms it); only then does a touch that closes above the level fill", () => {
  const level = 100;
  // Touch-and-hold BEFORE any close above the band: not a retest, still unarmed.
  const early = retestTriggered([bar(60, 100.2, 100.4, 100.1, 100.3), bar(120, 100.3, 100.6, 100.2, 100.4)], level, "buy");
  assert.equal(early.outcome, "none"); assert.equal(early.armed, false, "price never left the level — a chase, not a retest");
  // Arm, then come back: the arming bar itself never fills, the return bar does.
  const bars = [
    bar(60, 100.3, 101.2, 100.2, 101),        // close 101 > 100.5 → armed
    bar(120, 101, 101.5, 100.6, 101.2),       // low 100.6 > 100.5: no touch
    bar(180, 101.2, 101.3, 100.4, 100.8),     // touch (≤ 100.5) and close > 100 → fill
    bar(240, 100.8, 102, 100.7, 101.9),
  ];
  const r = retestTriggered(bars, level, "buy");
  assert.equal(r.outcome, "fill"); assert.equal(r.armed, true);
  assert.equal((r as { bar: KrakenBar }).bar.t, 180);
  // An arming bar whose own low touched the band does not fill on itself.
  const armTouch = retestTriggered([bar(60, 100.2, 101.2, 100.1, 101)], level, "buy");
  assert.equal(armTouch.outcome, "none"); assert.equal(armTouch.armed, true);
  // The armed state carries across ticks: a row already armed fills on the first qualifying bar.
  const carried = retestTriggered([bar(300, 101.2, 101.3, 100.4, 100.8)], level, "buy", true);
  assert.equal(carried.outcome, "fill");
  assert.equal(retestTriggered([bar(300, 101.2, 101.3, 100.4, 100.8)], level, "buy", false).outcome, "none", "the same bar unarmed only arms nothing (close 100.8 < 100.5? no — it is inside the band)");
});

test("a fail is a close more than 0.5% below the level, armed or not; a wick below that reclaims is not a fail", () => {
  const level = 100;
  assert.equal(retestTriggered([bar(60, 101, 101, 99.2, 100.2)], level, "buy", true).outcome, "fill", "armed: wick to 99.2, closed back above 100");
  assert.equal(retestTriggered([bar(60, 101, 101, 99.2, 99.9)], level, "buy", true).outcome, "none", "closed inside the band but below the level: neither");
  assert.equal(retestTriggered([bar(60, 101, 101, 99, 99.4)], level, "buy", false).outcome, "fail", "unarmed rows fail too");
  const fail = retestTriggered([bar(60, 101, 101, 99, 99.4)], level, "buy", true);
  assert.equal(fail.outcome, "fail");
  assert.equal((fail as { bar: KrakenBar }).bar.t, 60);
  // A fail before a would-be fill is a fail — the first decisive bar wins.
  assert.equal(retestTriggered([bar(60, 101, 101, 99, 99.4), bar(120, 99.4, 101, 99.4, 100.9)], level, "buy", true).outcome, "fail");
  // Events in the other order: arm, dip through the band → fail (never a fill).
  assert.equal(retestTriggered([bar(60, 100.3, 101.2, 100.2, 101), bar(120, 101, 101, 99, 99.3)], level, "buy").outcome, "fail");
});

test("no bars, no level, or no decisive bar → none; the armed flag is still reported", () => {
  assert.deepEqual(retestTriggered([], 100, "buy"), { outcome: "none", armed: false });
  assert.deepEqual(retestTriggered([bar(60, 101, 102, 101, 101.5)], 0, "buy"), { outcome: "none", armed: false });
  assert.deepEqual(retestTriggered([bar(60, 101, 102, 101, 101.5)], 100, "buy"), { outcome: "none", armed: true });
});

test("shorts mirror: arm on a close below level × 0.995; then a touch from below that closes below fills; a close 0.5% above fails", () => {
  const level = 100;
  assert.equal(retestTriggered([bar(60, 98, 99.6, 97.5, 99.2)], level, "sell", true).outcome, "fill");
  assert.equal(retestTriggered([bar(60, 98, 99.6, 97.5, 99.2)], level, "sell", false).outcome, "none", "unarmed: the touch does not count");
  assert.equal(retestTriggered([bar(60, 99.8, 99.9, 98.8, 99.2), bar(120, 99.2, 99.6, 98.9, 99.3)], level, "sell").outcome, "fill", "armed by the first close < 99.5, filled by the second");
  assert.equal(retestTriggered([bar(60, 98, 99.4, 97.5, 99.2)], level, "sell", true).outcome, "none");
  assert.equal(retestTriggered([bar(60, 99, 101, 99, 100.6)], level, "sell", true).outcome, "fail");
});

test("coverage gap: the first new bar must open within 2 minutes of the last one walked", () => {
  assert.equal(coverageGap(1000 + 60, 1000), false);
  assert.equal(coverageGap(1000 + 120, 1000), false);
  assert.equal(coverageGap(1000 + 121, 1000), true);
  assert.equal(coverageGap(undefined, 1000), false);
  assert.equal(coverageGap(5000, null), false, "a row with no walk yet cannot have a gap");
});

// ---- the resolver's I/O contract, with prisma stubbed --------------------------------------
const restores: (() => void)[] = [];
function stub(object: object, key: string, value: unknown) { const prev = Reflect.get(object, key); Reflect.set(object, key, value); restores.push(() => Reflect.set(object, key, prev)); }
function restore() { while (restores.length) restores.pop()!(); }

const NOW = 1_800_000_000;   // epoch secs
function pendingRow(extra: Record<string, unknown> = {}) {
  return { id: 7, created_at: new Date((NOW - 3600) * 1000), symbol: "SOL/USD", side: "buy", source: "swing-retest", level: 100, leverage: 5, conviction: "high", conviction_score: 5, note: "auto: swing-retest breakout 4h [high]", stamps: { mtf_state: "U/U/U" }, btc_regime: "up", expires_at: new Date((NOW + 80_000) * 1000), last_checked_t: NOW - 240, armed: true, ...extra };
}
/** Kraken 1-min bars: the fill bar at NOW−180 (armed row: touch + close above the level) plus a forming one. */
const KRAKEN_BARS = [[NOW - 180, "101.2", "101.3", "100.4", "100.8", "0", "10"], [NOW - 120, "100.8", "101", "100.7", "100.9", "0", "10"], [NOW - 60, "100.9", "101", "100.8", "100.95", "0", "10"], [NOW, "100.95", "101", "100.9", "100.95", "0", "3"]];

function stubKraken(bars: unknown[][] = KRAKEN_BARS) {
  stub(globalThis, "fetch", async () => ({ json: async () => ({ error: [], result: { SOLUSD: bars, last: NOW } }) }));
}

test("a fill is CLAIMED first: when the claim returns no row (another tick got there) nothing is inserted", async () => {
  const sql: string[] = [];
  stub(prisma, "$executeRawUnsafe", async (q: string) => { sql.push(q); return 1; });
  stub(prisma, "$queryRawUnsafe", async (q: string) => {
    sql.push(q);
    if (/SET status='expired'/.test(q)) return [];
    if (/FROM margin_pending_entries WHERE status='pending'/.test(q)) return [pendingRow()];
    if (/SET status='filling'/.test(q)) return [];   // the claim lost
    if (/INSERT INTO tradingview_alerts/.test(q)) throw new Error("must not insert without a claim");
    return [];
  });
  stubKraken();
  try {
    const r = await resolvePendingEntries({ now: NOW * 1000 });
    assert.deepEqual(r.filled, []); assert.deepEqual(r.errors, []);
    assert.ok(sql.some((q) => /SET status='filling' WHERE id=\$1 AND status='pending' RETURNING id/.test(q)), "the claim was attempted");
    assert.ok(!sql.some((q) => /INSERT INTO tradingview_alerts/.test(q)), "no alert row without the claim");
    assert.ok(!sql.some((q) => /SET status='filled'/.test(q)));
  } finally { restore(); }
});

test("a fill that wins the claim inserts the alert row, sizes it strictly, then finalises to 'filled'", async () => {
  const sql: string[] = [];
  stub(prisma, "$executeRawUnsafe", async (q: string) => { sql.push(q); return 1; });
  stub(prisma, "$queryRawUnsafe", async (q: string) => {
    sql.push(q);
    if (/SET status='expired'/.test(q)) return [];
    if (/FROM margin_pending_entries WHERE status='pending'/.test(q)) return [pendingRow()];
    if (/SET status='filling'/.test(q)) return [{ id: 7 }];
    if (/INSERT INTO tradingview_alerts/.test(q)) return [{ id: 4242 }];
    if (/SELECT source, leverage, mark_price/.test(q)) return [{ source: "swing-retest", leverage: 5, mark_price: 100.9008, conviction: "high", time: new Date((NOW - 120) * 1000), shadow_stop_frac: null }];
    if (/RETURNING shadow_notional/.test(q)) return [{ shadow_notional: 8000 }];
    return [];
  });
  stub(prisma.agentConfig, "findUnique", async ({ where }: { where: { key: string } }) => ({ key: where.key, value: where.key === "kraken_shadow_ref_equity" ? "5000" : where.key === "kraken_margin_max_risk_pct" ? "4" : null }));
  stubKraken();
  try {
    const r = await resolvePendingEntries({ now: NOW * 1000 });
    assert.deepEqual(r.filled, ["SOL/USD swing-retest"]); assert.deepEqual(r.errors, []);
    const claim = sql.findIndex((q) => /SET status='filling'/.test(q)), ins = sql.findIndex((q) => /INSERT INTO tradingview_alerts/.test(q)), fin = sql.findIndex((q) => /SET status='filled'/.test(q));
    assert.ok(claim >= 0 && ins > claim && fin > ins, `claim → insert → filled, got ${claim}/${ins}/${fin}`);
    assert.ok(/mark_price/.test(sql[ins]) && /sim_version/.test(sql[ins]) && /mtf_state/.test(sql[ins]), "the stamps ride on the filled row");
  } finally { restore(); }
});

test("a fill whose strict sizing fails withdraws the claim (row back to pending, alert row deleted) and reports the error", async () => {
  const sql: string[] = [];
  stub(prisma, "$executeRawUnsafe", async (q: string) => { sql.push(q); return 1; });
  stub(prisma, "$queryRawUnsafe", async (q: string) => {
    sql.push(q);
    if (/SET status='expired'/.test(q)) return [];
    if (/FROM margin_pending_entries WHERE status='pending'/.test(q)) return [pendingRow()];
    if (/SET status='filling'/.test(q)) return [{ id: 7 }];
    if (/INSERT INTO tradingview_alerts/.test(q)) return [{ id: 4242 }];
    return [];
  });
  stub(prisma.agentConfig, "findUnique", async () => null);   // no sizing config → strict sizing throws
  stubKraken();
  try {
    const r = await resolvePendingEntries({ now: NOW * 1000 });
    assert.deepEqual(r.filled, []);
    assert.equal(r.errors.length, 1); assert.match(r.errors[0], /sizing configuration/);
    assert.ok(sql.some((q) => /DELETE FROM tradingview_alerts WHERE id=\$1 AND shadow_notional IS NULL/.test(q)), "the half-made alert row is withdrawn");
    assert.ok(sql.some((q) => /SET status='pending', armed=\$2 WHERE id=\$1 AND status='filling'/.test(q)), "the claim is released — the next tick retries");
    assert.ok(!sql.some((q) => /SET status='filled'/.test(q)));
  } finally { restore(); }
});

test("a hole in the walk expires the row with reason 'coverage gap' instead of judging bars it did not watch", async () => {
  const sql: string[] = [];
  stub(prisma, "$executeRawUnsafe", async (q: string) => { sql.push(q); return 1; });
  stub(prisma, "$queryRawUnsafe", async (q: string) => {
    sql.push(q);
    if (/SET status='expired', resolved_at=now\(\), reason='no retest/.test(q)) return [];
    if (/FROM margin_pending_entries WHERE status='pending'/.test(q)) return [pendingRow({ last_checked_t: NOW - 900 })];   // last walked 15 min ago; Kraken's first bar is NOW−180
    return [];
  });
  stubKraken();
  try {
    const r = await resolvePendingEntries({ now: NOW * 1000 });
    assert.deepEqual(r.expired, ["SOL/USD swing-retest (coverage gap)"]); assert.deepEqual(r.filled, []);
    assert.ok(sql.some((q) => /reason='coverage gap'/.test(q)));
    assert.ok(!sql.some((q) => /SET status='filling'/.test(q)), "no claim, no fill");
  } finally { restore(); }
});

test("a fail stores the bar's time in fail_t, and a plain walk advances last_checked_t with the armed flag", async () => {
  const sql: string[] = [];
  stub(prisma, "$executeRawUnsafe", async (q: string) => { sql.push(q); return 1; });
  stub(prisma, "$queryRawUnsafe", async (q: string) => { sql.push(q); if (/FROM margin_pending_entries WHERE status='pending'/.test(q)) return [pendingRow({ armed: false })]; return []; });
  stubKraken([[NOW - 180, "101", "101", "99", "99.3", "0", "1"], [NOW, "99.3", "99.5", "99.2", "99.4", "0", "1"]]);
  try {
    const r = await resolvePendingEntries({ now: NOW * 1000 });
    assert.deepEqual(r.failed, ["SOL/USD swing-retest"]);
    const q = sql.find((x) => /SET status='failed'/.test(x))!;
    assert.match(q, /fail_t=\$2/); assert.doesNotMatch(q, /fill_t/);
  } finally { restore(); }
  sql.length = 0;
  stub(prisma, "$executeRawUnsafe", async (q: string) => { sql.push(q); return 1; });
  stub(prisma, "$queryRawUnsafe", async (q: string) => { sql.push(q); if (/FROM margin_pending_entries WHERE status='pending'/.test(q)) return [pendingRow({ armed: false })]; return []; });
  stubKraken([[NOW - 180, "100.3", "101.2", "100.2", "101", "0", "1"], [NOW, "101", "101", "100.9", "101", "0", "1"]]);   // arms, nothing else
  try {
    const r = await resolvePendingEntries({ now: NOW * 1000 });
    assert.deepEqual(r.failed, []); assert.deepEqual(r.filled, []);
    const q = sql.find((x) => /SET last_checked_t=\$2, armed=\$3/.test(x));
    assert.ok(q, "the walk advanced and the armed flag was persisted");
  } finally { restore(); }
});

test("the resolver stops at its own 20 s wall clock and says so", async () => {
  const sql: string[] = [];
  stub(prisma, "$executeRawUnsafe", async (q: string) => { sql.push(q); return 1; });
  stub(prisma, "$queryRawUnsafe", async (q: string) => { sql.push(q); if (/FROM margin_pending_entries WHERE status='pending'/.test(q)) return [pendingRow(), pendingRow({ id: 8, symbol: "ETH/USD" })]; return []; });
  stubKraken();
  try {
    const r = await resolvePendingEntries({ now: NOW * 1000, budgetMs: 0 });
    assert.equal(r.stoppedForBudget, true);
    assert.equal(r.checked, 0);
    assert.match(r.errors[0], /stopped after 0 rows \(0s budget\)/);
  } finally { restore(); }
});

test("the scanner stamps the pierced level on the breakout, and the plan carries it as a deferred entry", () => {
  const T0 = 1_757_000_000 - (1_757_000_000 % 14400);
  const bars: KrakenBar[] = [];
  let px = 100;
  for (let i = 0; i < 60; i++) { const o = px, c = px * 1.003, h = Math.max(o, c) * 1.002, l = Math.min(o, c) * 0.998; bars.push({ t: T0 + i * 14400, o, h, l, c, v: 1000 }); px = c; }
  bars[59].h *= 1.03; bars[59].c *= 1.02;
  const tf: TfSpec = { interval: 240, label: "4h", movePct: 0.05, realertMs: 1 };
  const sig = evaluate({ name: "TST", symbol: "TST/USD" }, tf, bars);
  const brk = sig.find((s) => s.kind === "breakout")!;
  const hh = Math.max(...bars.slice(39, 59).map((b) => b.h));
  assert.equal(brk.level, hh, "level = the 20 completed bars' high the forming bar pierced");
  assert.ok(brk.atrFrac != null && brk.atrFrac > 0 && brk.atrFrac < 0.05, `atrFrac ${brk.atrFrac}`);
  assert.equal(sig.find((s) => s.kind !== "breakout" && s.kind !== "breakdown" && s.level != null), undefined, "no other signal carries a level");
  const plans = autoShadowPlans("breakout", "4h", { tier: "high", factors: [] }, 5, { btcUp: true }, "TST/USD", { level: brk.level });
  assert.deepEqual(plans.find((p) => p.source === "swing-retest"), { source: "swing-retest", lev: 5, deferred: true, level: hh });
});
