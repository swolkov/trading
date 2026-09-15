import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_LIMITS, parseAlert, sizeEntry, type AlertPayload, type SizeResult } from "../src/lib/futures-desk-rules";
import {
  DEMO_HOST, EQUITY_JUMP_PCT, EXECUTION_ERRORS_DISABLE_AT, EXECUTION_ERRORS_REASON, FEED_STALE_AFTER_OPEN_MINUTES, anomalyRefusal, cmeOpenMinutesBetween, detectAnomaly, equityJump,
  executionErrorsToday, feedStale, hostForMode, parseAnomaly, preTradeChecklist, type ChecklistContext,
} from "../src/lib/futures-desk-safety";
import { futuresHealth } from "../src/lib/futures-health";
import { DESK_MODE } from "../src/lib/tradovate-desk";
import { POST as webhook, isHeartbeat } from "../src/app/api/webhook/tradingview-futures/route";

const body = { secret: "x", desk: "futures", edge: "index_daily_mr", symbol: "ES", action: "entry", side: "long", price: 6500, stop: 6460, bar: "2026-09-14T21:00:00Z", tf: "1D" };
function alertOf(over: Record<string, unknown> = {}): AlertPayload { const p = parseAlert({ ...body, ...over }); if (!p.ok) throw new Error(p.reason); return p.alert; }
const now = new Date("2026-09-15T16:00:00Z");   // Tue 12:00 ET
const es = alertOf();
const size: SizeResult = sizeEntry(es, DEFAULT_LIMITS, { grade: "normal", stage: "A", budgetMult: 1 });
const okCtx: ChecklistContext = { brokerHost: DEMO_HOST, expiryIso: "2026-12-18T14:30:00Z", guardDays: 3, openRoots: [], eventPolicyRaw: null, feedSeenAt: "2026-09-15T15:00:00Z", now };
const mesz6 = { name: "MESZ6" };

// (a)
test("execution errors are counted on the ET day; null classes and bad dates never count; three disable", () => {
  const rows = [
    { at: "2026-09-15T14:00:00Z", errorClass: "entry_error" },     // 10:00 ET Sep 15
    { at: "2026-09-16T02:30:00Z", errorClass: "close_refused" },   // 22:30 ET Sep 15
    { at: "2026-09-15T03:00:00Z", errorClass: "roll_failed" },     // 23:00 ET Sep 14 — yesterday
    { at: "2026-09-15T15:00:00Z", errorClass: null },
    { at: "garbage", errorClass: "unprotected" },
  ];
  assert.equal(executionErrorsToday(rows, "2026-09-15"), 2);
  assert.equal(executionErrorsToday(rows, "2026-09-14"), 1);
  assert.equal(executionErrorsToday([...rows, { at: "2026-09-15T18:00:00Z", errorClass: "unprotected" }], "2026-09-15") >= EXECUTION_ERRORS_DISABLE_AT, true);
  assert.equal(EXECUTION_ERRORS_REASON, "3 execution errors today");
});

// (b)
test("anomalies: a foreign position, then a broker≠ledger mismatch, then an equity jump; clean books are null", () => {
  const open = [{ contract_id: 10, contract: "MESZ6", side: "long" as const, qty: 1 }];
  assert.equal(detectAnomaly({ positions: [{ contractId: 10, netPos: 1 }], open, prevEquity: 50_000, equity: 50_100, fillsSince: 0, now }), null);
  const foreign = detectAnomaly({ positions: [{ contractId: 10, netPos: 1 }, { contractId: 123, netPos: -2 }], open, equity: 50_000, fillsSince: 0, now });
  assert.deepEqual(foreign, { kind: "foreign_position", detail: "foreign position #123", at: now.toISOString() });
  const qty = detectAnomaly({ positions: [{ contractId: 10, netPos: 2 }], open, equity: 50_000, fillsSince: 0, now });
  assert.equal(qty?.detail, "ledger mismatch on MESZ6: broker long 2, ledger long 1");
  const side = detectAnomaly({ positions: [{ contractId: 10, netPos: -1 }], open, equity: 50_000, fillsSince: 0, now });
  assert.equal(side?.kind, "ledger_mismatch"); assert.match(side!.detail, /broker short 1, ledger long 1/);
  assert.equal(detectAnomaly({ positions: [], open, equity: 50_000, fillsSince: 0, now }), null);   // flat at the broker = settle, not an anomaly
  const refusal = anomalyRefusal(JSON.stringify(foreign));
  assert.equal(refusal, "anomaly open: foreign position #123 — entries paused until cleared");
  assert.deepEqual(parseAnomaly(JSON.stringify(foreign)), foreign);
  for (const raw of ["", null, undefined, "{", "[]", JSON.stringify({ kind: "x" })]) { assert.equal(parseAnomaly(raw), null); assert.equal(anomalyRefusal(raw), null); }
});

// (c)
test("an equity jump beyond 30% with zero fills is an anomaly; with fills, or with no previous run, it is not", () => {
  assert.equal(EQUITY_JUMP_PCT, 30);
  assert.equal(equityJump(50_000, 67_500, 0), true);
  assert.equal(equityJump(50_000, 30_000, 0), true);
  assert.equal(equityJump(50_000, 60_000, 0), false);
  assert.equal(equityJump(50_000, 67_500, 1), false);
  assert.equal(equityJump(undefined, 67_500, 0), false);
  assert.equal(equityJump(0, 67_500, 0), false);
  const a = detectAnomaly({ positions: [], open: [], prevEquity: 50_000, equity: 67_500, fillsSince: 0, now });
  assert.equal(a?.kind, "equity_jump"); assert.equal(a?.detail, "equity jumped 35% ($50,000 → $67,500) with no fills");
});

// (d)
test("feed heartbeat: stale after 180 CME-open minutes — the daily break and the weekend count for nothing; never seen = stale", () => {
  assert.equal(FEED_STALE_AFTER_OPEN_MINUTES, 180);
  const seen = "2026-09-15T14:00:00Z";                                                   // Tue 10:00 ET
  assert.equal(cmeOpenMinutesBetween(Date.parse(seen), Date.parse("2026-09-15T17:00:00Z")), 180);
  assert.equal(feedStale(seen, Date.parse("2026-09-15T17:00:00Z")), false);            // exactly 180
  assert.equal(feedStale(seen, Date.parse("2026-09-15T17:05:00Z")), true);             // 185
  const beforeBreak = "2026-09-15T20:30:00Z";                                            // 16:30 ET
  assert.equal(cmeOpenMinutesBetween(Date.parse(beforeBreak), Date.parse("2026-09-16T00:00:00Z")), 150);   // 30 + 120, the 17–18 break skipped
  assert.equal(feedStale(beforeBreak, Date.parse("2026-09-16T00:00:00Z")), false);
  assert.equal(feedStale(beforeBreak, Date.parse("2026-09-16T00:35:00Z")), true);      // 185
  const friday = "2026-09-18T20:00:00Z";                                                 // Fri 16:00 ET
  assert.equal(cmeOpenMinutesBetween(Date.parse(friday), Date.parse("2026-09-20T22:30:00Z")), 90);        // 60 Fri + 30 Sun
  assert.equal(feedStale(friday, Date.parse("2026-09-20T22:30:00Z")), false);
  assert.equal(feedStale(friday, Date.parse("2026-09-21T13:00:00Z")), true);           // Monday morning
  assert.equal(feedStale(null, Date.now()), true); assert.equal(feedStale("garbage", Date.now()), true);
  assert.equal(cmeOpenMinutesBetween(5, 5), 0); assert.equal(cmeOpenMinutesBetween(10, 5), 0);
  assert.equal(feedStale("2020-01-01T00:00:00Z", Date.parse("2026-09-15T16:00:00Z")), true);   // capped lookback still stale
});

test("health exposes the feed and the anomaly; entries are never gated by the health module", () => {
  const at = Date.parse("2026-09-15T16:00:00Z");
  const h = futuresHealth({ futures_desk_feed_seen_at: "2026-09-15T15:30:00Z", futures_desk_anomaly: JSON.stringify({ kind: "foreign_position", detail: "foreign position #123", at: "2026-09-15T15:00:00Z" }) }, at).desk;
  assert.equal(h.feedSeenAt, "2026-09-15T15:30:00.000Z"); assert.equal(h.feedStale, false); assert.equal(h.anomaly, "foreign position #123 (2026-09-15T15:00:00Z)");
  const stale = futuresHealth({ futures_desk_feed_seen_at: "2026-09-15T12:00:00Z" }, at).desk;
  assert.equal(stale.feedStale, true); assert.equal(stale.anomaly, null);
  assert.equal(futuresHealth({}, at).desk.feedSeenAt, null); assert.equal(futuresHealth({}, at).desk.feedStale, true);
});

// (e)
test("the checklist passes a clean ES entry and warns (not fails) while the event policy key does not exist", () => {
  const c = preTradeChecklist(es, okCtx, mesz6, size, DEFAULT_LIMITS);
  assert.equal(c.ok, true); assert.deepEqual(c.failures, []);
  assert.deepEqual(c.warnings, ["event calendar not checked in the last 20 minutes (no policy key yet — E3)"]);
  assert.equal(hostForMode(DESK_MODE), DEMO_HOST);   // the desk's pinned mode resolves to the demo host
  assert.equal(hostForMode("live"), "live.tradovateapi.com");
});

test("the checklist's exact failure strings, one fixture each", () => {
  const f = (a: AlertPayload, ctx: Partial<ChecklistContext>, contract = mesz6, sz = size) => preTradeChecklist(a, { ...okCtx, ...ctx }, contract, sz, DEFAULT_LIMITS).failures;
  assert.deepEqual(f(es, { brokerHost: "live.tradovateapi.com" }), ["account is not the demo (host must be demo.tradovateapi.com)"]);
  assert.ok(f({ ...es, edge: "donchian_60m_long", root: "RTY" }, {}).includes("RTY is not a root of donchian_60m_long"));
  // Month membership: index roots list quarterlies only; metals use ACTIVE_MONTH_CODES (GC has no U).
  assert.deepEqual(f(es, {}, { name: "MESV6" }), ["contract month code V not in ACTIVE_MONTH_CODES for ES"]);
  assert.deepEqual(f(es, {}, { name: "MNQZ6" }), ["contract month code (none) not in ACTIVE_MONTH_CODES for ES", "micro symbol MES does not match MICRO_FOR_ROOT"]);   // wrong symbol: both fail
  const gc = alertOf({ edge: "donchian_60m_long", symbol: "GC", tf: "60" });
  const gcSize = sizeEntry(gc, DEFAULT_LIMITS, { grade: "normal", stage: "A", budgetMult: 1 });
  assert.deepEqual(f(gc, {}, { name: "MGCU6" }, gcSize), ["contract month code U not in ACTIVE_MONTH_CODES for GC"]);
  assert.deepEqual(f(gc, {}, { name: "MGCZ6" }, gcSize), []);
  assert.deepEqual(f(es, { expiryIso: "2026-09-16T16:00:00Z" }, { name: "MESU6" }), ["MESU6 is inside its roll window (expires in 1 day)"]);
  assert.deepEqual(f(es, { expiryIso: "2026-09-17T17:00:00Z" }, { name: "MESU6" }), []);   // 2.04 days out: a 3-day guard rolls only under 2
  assert.deepEqual(f(alertOf({ symbol: "NQ" }), {}), ["micro symbol MES does not match MICRO_FOR_ROOT"]);
  assert.deepEqual(f(es, {}, mesz6, { ...size, contracts: 2 }), ["qty 2 exceeds the stage A cap of 1"]);
  assert.deepEqual(f({ ...es, stop: null }, {}), ["stop missing or on the wrong side of price"]);
  assert.deepEqual(f({ ...es, stop: 6600 }, {}), ["stop missing or on the wrong side of price"]);
  assert.deepEqual(f(es, {}, mesz6, { ...size, riskUsd: 301.7 }), ["risk $301.70 exceeds the $250 budget"]);
  assert.deepEqual(f(es, { openRoots: ["ES"] }), ["already holding ES"]);
  assert.deepEqual(f(es, { eventPolicyRaw: JSON.stringify({ mode: "normal", at: "2026-09-15T15:35:00Z" }) }), ["event calendar not checked in the last 20 minutes"]);   // 25 min old
  assert.deepEqual(f(es, { eventPolicyRaw: "{" }), ["event calendar not checked in the last 20 minutes"]);
  assert.deepEqual(f(es, { eventPolicyRaw: JSON.stringify({ mode: "normal", at: "2026-09-15T15:50:00Z" }) }), []);
  // The first failure is the refusal; the rest still ride in checklist_json.
  const many = preTradeChecklist({ ...es, stop: null }, { ...okCtx, brokerHost: "live.tradovateapi.com", openRoots: ["ES"] }, mesz6, size, DEFAULT_LIMITS);
  assert.equal(many.ok, false); assert.equal(many.failures[0], "account is not the demo (host must be demo.tradovateapi.com)"); assert.equal(many.failures.length, 3);
});

test("a stale feed is a checklist WARNING, never a failure", () => {
  const c = preTradeChecklist(es, { ...okCtx, feedSeenAt: null }, mesz6, size, DEFAULT_LIMITS);
  assert.equal(c.ok, true);
  assert.ok(c.warnings.some((w) => w.startsWith("feed heartbeat stale (last seen never)")));
});

// the webhook's heartbeat branch
test("isHeartbeat: action heartbeat with the futures desk (or no desk); anything else is an alert", () => {
  assert.equal(isHeartbeat({ secret: "x", desk: "futures", action: "heartbeat", bar: 1 }), true);
  assert.equal(isHeartbeat({ secret: "x", action: "heartbeat" }), true);
  assert.equal(isHeartbeat({ secret: "x", desk: "crypto", action: "heartbeat" }), false);
  assert.equal(isHeartbeat(body), false); assert.equal(isHeartbeat(null), false); assert.equal(isHeartbeat("heartbeat"), false);
});

test("webhook: a heartbeat needs the secret, and sits BEHIND the DB-backed rate limit (no DB here → 503, never 'heartbeat')", async () => {
  const prev = process.env.TRADINGVIEW_WEBHOOK_SECRET;
  process.env.TRADINGVIEW_WEBHOOK_SECRET = "s3cret";
  try {
    const post = (b: unknown) => webhook(new Request("http://localhost/api/webhook/tradingview-futures", { method: "POST", body: JSON.stringify(b) }));
    assert.equal((await post({ desk: "futures", action: "heartbeat", secret: "wrong" })).status, 401);
    assert.equal((await post({ desk: "futures", action: "heartbeat" })).status, 401);
    // Right secret: the next containment step is the inbox rate limit, which needs the DB. With the placeholder
    // DATABASE_URL it fails closed (503) — proving the heartbeat cannot skip it. The happy path (200 {status:
    // "heartbeat"}, no signal row) needs Postgres and is covered by the deploy check in FUTURES-DESK.md.
    const r = await post({ desk: "futures", action: "heartbeat", secret: "s3cret", bar: 1 });
    assert.equal(r.status, 503);
    assert.match((await r.json()).error, /inbox unavailable/);
  } finally { if (prev == null) delete process.env.TRADINGVIEW_WEBHOOK_SECRET; else process.env.TRADINGVIEW_WEBHOOK_SECRET = prev; }
});
