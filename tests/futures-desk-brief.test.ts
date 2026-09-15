import assert from "node:assert/strict";
import { test } from "node:test";
import { BRIEF_HEADERS, actionFor, contractMonthOf, emptyBriefInput, expectedRR, renderFuturesBrief, type BriefInput, type BriefState } from "../src/lib/futures-desk-brief";
import { parseBriefLatest } from "../src/lib/futures-desk-brief-jobs";
import { etToUtcMs, lastBusinessDayBefore, nextRollByRoot, thirdFriday } from "../src/lib/futures-desk-calendar";

const now = new Date("2026-09-15T21:10:00Z");
const calm: BriefState = { halted: false, paused: false, anomaly: false, feedStale: false, openPositions: 0, ddTier: 0, watchCount: 0 };
const guard = (m: string) => (["MGC", "SIL", "MHG"].includes(m) ? 21 : 3);

// ---- actionFor -----------------------------------------------------------------------------------------------
test("actionFor truth table: any halt/pause/anomaly/stale feed → NO TRADE; open position at tier ≥ 2 → REDUCE; a watch → WAIT; else NO TRADE", () => {
  assert.equal(actionFor(calm), "NO TRADE");
  assert.equal(actionFor({ ...calm, watchCount: 1 }), "WAIT");
  assert.equal(actionFor({ ...calm, openPositions: 1, ddTier: 2 }), "REDUCE");
  assert.equal(actionFor({ ...calm, openPositions: 1, ddTier: 3, watchCount: 2 }), "REDUCE");   // REDUCE outranks WAIT
  assert.equal(actionFor({ ...calm, openPositions: 1, ddTier: 1, watchCount: 2 }), "WAIT");     // tier 1 is not a reduce
  assert.equal(actionFor({ ...calm, openPositions: 0, ddTier: 2, watchCount: 1 }), "WAIT");     // nothing open to reduce
  for (const flag of ["halted", "paused", "anomaly", "feedStale"] as const) {
    assert.equal(actionFor({ ...calm, [flag]: true, openPositions: 1, ddTier: 3, watchCount: 5 }), "NO TRADE", flag);
  }
});

// ---- the render ----------------------------------------------------------------------------------------------
const full: BriefInput = {
  generatedAt: now.toISOString(),
  regime: { at: now.toISOString(), byRoot: { ES: { label: "uptrend-midvol", close: 6500, sma50: 6400, sma200: 6000, atr: 60, atrPct: 0.5, at: now.toISOString() }, GC: { label: "range-highvol", close: 2400, sma50: 2410, sma200: 2300, atr: 40, atrPct: 0.8, at: now.toISOString() } } },
  event: { mode: "reduced", reason: "FOMC rate decision at 14:00 ET tomorrow", window: null },
  rolls: nextRollByRoot(now, guard),
  watches: [
    { edge: "donchian_60m_long", root: "GC", side: "long", price: 2400, stop: 2360, score: 61, card: "dry run: 1× MGC · stop 40 pts · risk $401.70 of $250 (normal · stage A)", receivedAt: "2026-09-15T19:00:00Z" },
    { edge: "index_daily_mr", root: "ES", side: "long", price: 6500, stop: 6460, score: 74, card: "dry run: 1× MES · stop 40 pts · risk $201.70 of $250 (normal · stage A)", receivedAt: "2026-09-15T20:00:00Z" },
    { edge: "donchian_60m_long", root: "NQ", side: "long", price: 24000, stop: 23700, score: null, card: null, receivedAt: "2026-09-15T18:00:00Z" },
  ],
  entry: null,
  state: { ...calm, watchCount: 3, reasons: [] },
  stage: "A", k: 2,
};

test("the brief renders the four headers in the fixed order; the top watch leads TOP OPPORTUNITIES and is the RECOMMENDED TRADE when nothing is open", () => {
  const { markdown, action } = renderFuturesBrief(full);
  const idx = BRIEF_HEADERS.map((h) => markdown.indexOf(h));
  assert.ok(idx.every((i) => i >= 0), "every header present");
  assert.deepEqual([...idx].sort((a, b) => a - b), idx, "headers in order");
  assert.equal(action, "WAIT"); assert.ok(markdown.endsWith("**WAIT** — 3 watch alert(s) live — wait for the rule to fire"));
  assert.ok(markdown.includes("- ES: **uptrend-midvol** · close 6500 · SMA50 6400 · SMA200 6000 · ATR pct 50%"));
  assert.ok(markdown.includes("- Event window: **reduced** — FOMC rate decision at 14:00 ET tomorrow"));
  assert.ok(markdown.includes("- Next roll: ES MESZ6 ~Dec 16 · NQ MNQZ6 ~Dec 16 · YM MYMZ6 ~Dec 16 · RTY M2KZ6 ~Dec 16 · GC MGCZ6 ~Nov 10 · SI SILZ6 ~Nov 10 · HG MHGZ6 ~Nov 10"));
  const top = markdown.slice(markdown.indexOf(BRIEF_HEADERS[1]), markdown.indexOf(BRIEF_HEADERS[2]));
  assert.ok(top.startsWith(`${BRIEF_HEADERS[1]}\n1. ES long · index_daily_mr · score 74`)); assert.ok(top.includes("2. GC long")); assert.ok(top.includes("3. NQ long · donchian_60m_long · score — · price 24000 · stop 23700 · unsized"));
  const rec = markdown.slice(markdown.indexOf(BRIEF_HEADERS[2]), markdown.indexOf(BRIEF_HEADERS[3]));
  assert.ok(rec.includes("Account: **DEMO** (Tradovate) · top watch, NOT placed")); assert.ok(rec.includes("- ES LONG · index_daily_mr · price 6500 · projected stop 6460 · dry run: 1× MES")); assert.ok(rec.includes("Regime uptrend-midvol · event mode reduced · score 74 · stage A"));
});

test("an open position renders the entry card (account, month, micro, qty, order type, stop, risk, R:R, session, regime, event mode, score); tier 2 makes it REDUCE", () => {
  const i: BriefInput = {
    ...full, watches: [],
    entry: { contract: "MESZ6", micro: "MES", side: "long", qty: 1, entryPrice: 6502.25, stopPrice: 6462.25, riskUsd: 201.7, stopPoints: 40, atr: 50, session: "morning", regime: "uptrend-midvol", eventMode: "normal", grade: "normal", score: 71, mfeR: 0.4, openedAt: "2026-09-15T15:00:00Z", status: "open" },
    state: { ...calm, openPositions: 1, ddTier: 2, watchCount: 0, reasons: [] },
  };
  const { markdown, action } = renderFuturesBrief(i);
  assert.equal(action, "REDUCE"); assert.ok(markdown.endsWith("**REDUCE** — open position at drawdown tier 2"));
  const rec = markdown.slice(markdown.indexOf(BRIEF_HEADERS[2]), markdown.indexOf(BRIEF_HEADERS[3]));
  assert.ok(rec.includes("- Account: **DEMO** (Tradovate) · OPEN position · opened Sep 15"));
  assert.ok(rec.includes("- Symbol: MESZ6 · month Z6 · micro MES · LONG 1× · order: market entry + bracket stop (OSO)"));
  assert.ok(rec.includes("- Entry 6502.25 · stop 6462.25 (40 pts) · risk $201.70"));
  assert.ok(rec.includes("- R:R: 2.50 expected (2×ATR ÷ stop) · MFE 0.40R so far"));
  assert.ok(rec.includes("- Session morning · regime uptrend-midvol · event mode normal · grade normal · score 71 · stage A"));
  assert.ok(markdown.includes(`${BRIEF_HEADERS[1]}\n- —`));
  // Halted with reasons: NO TRADE and the reasons on the line.
  const halted = renderFuturesBrief({ ...i, state: { ...i.state, halted: true, reasons: ["desk disabled", "feed stale (last heartbeat never)"] } });
  assert.equal(halted.action, "NO TRADE"); assert.ok(halted.markdown.endsWith("**NO TRADE** — desk disabled · feed stale (last heartbeat never)"));
});

test("empty input renders every section with — and never throws", () => {
  const { markdown, action } = renderFuturesBrief(emptyBriefInput(now));
  assert.equal(action, "NO TRADE");
  for (const h of BRIEF_HEADERS) assert.ok(markdown.includes(h), h);
  assert.ok(markdown.includes("- regime: — (no snapshot yet)")); assert.ok(markdown.includes("- Event window: —")); assert.ok(markdown.includes("- Next roll: —"));
  assert.ok(markdown.includes(`${BRIEF_HEADERS[1]}\n- —`)); assert.ok(markdown.includes(`${BRIEF_HEADERS[2]}\n- —`));
  assert.ok(markdown.endsWith("**NO TRADE** — feed never seen"));
  const bare = renderFuturesBrief({ ...emptyBriefInput(now), state: { ...calm, reasons: [] } });
  assert.ok(bare.markdown.endsWith("**NO TRADE** — no setup in play"));
  assert.equal(contractMonthOf("MESZ6", "MES"), "Z6"); assert.equal(contractMonthOf("MES", "MES"), "—"); assert.equal(contractMonthOf("", "MES"), "—");
  assert.equal(expectedRR(50, 40, 2), 2.5); assert.equal(expectedRR(null, 40, 2), null); assert.equal(expectedRR(50, 0, 2), null);
  assert.deepEqual(parseBriefLatest(JSON.stringify({ at: "x", action: "WAIT", markdown: "m" })), { at: "x", action: "WAIT", markdown: "m" });
  for (const raw of [null, "", "{", JSON.stringify({ at: "x", action: "GO", markdown: "m" }), JSON.stringify({ action: "WAIT" })]) assert.equal(parseBriefLatest(raw), null);
});

// ---- the calendar's roll dates ---------------------------------------------------------------------------
test("nextRollByRoot on Sep 15 2026: index roots already on Z6 (U6 expires Sep 18, inside the 3-day guard), rolling Dec 16; metals on Z6, rolling 20 days before first notice", () => {
  const rolls = nextRollByRoot(now, guard);
  const by = Object.fromEntries(rolls.map((r) => [r.root, r]));
  assert.deepEqual(rolls.map((r) => r.root), ["ES", "NQ", "YM", "RTY", "GC", "SI", "HG"]);
  assert.equal(by.ES.contract, "MESZ6"); assert.equal(by.ES.kind, "expiry"); assert.equal(by.ES.expiry, "2026-12-18T14:30:00.000Z"); assert.equal(by.ES.rollOn, "2026-12-16T14:30:00.000Z"); assert.equal(by.ES.source, "calendar");
  assert.equal(by.GC.contract, "MGCZ6"); assert.equal(by.GC.kind, "first notice"); assert.equal(by.GC.expiry.slice(0, 10), "2026-11-30"); assert.equal(by.GC.rollOn.slice(0, 10), "2026-11-10");
  assert.equal(by.SI.contract, "SILZ6"); assert.equal(by.HG.contract, "MHGZ6");
  // Sep 14: U6 expires in 4 days — still the front month for the index roots, rolling Sep 16.
  const sep14 = Object.fromEntries(nextRollByRoot(new Date("2026-09-14T13:00:00Z"), guard).map((r) => [r.root, r]));
  assert.equal(sep14.ES.contract, "MESU6"); assert.equal(sep14.ES.rollOn, "2026-09-16T13:30:00.000Z"); assert.ok(sep14.ES.daysUntilRoll > 2 && sep14.ES.daysUntilRoll < 2.1);
  // Dec 17: Z6 expires tomorrow → H7.
  assert.equal(Object.fromEntries(nextRollByRoot(new Date("2026-12-17T13:00:00Z"), guard).map((r) => [r.root, r])).NQ.contract, "MNQH7");
  assert.deepEqual(thirdFriday(2026, 12), { y: 2026, m: 12, d: 18 }); assert.deepEqual(thirdFriday(2026, 9), { y: 2026, m: 9, d: 18 }); assert.deepEqual(thirdFriday(2027, 3), { y: 2027, m: 3, d: 19 });
  assert.deepEqual(lastBusinessDayBefore(2026, 12), { y: 2026, m: 11, d: 30 }); assert.deepEqual(lastBusinessDayBefore(2026, 11), { y: 2026, m: 10, d: 30 }); assert.deepEqual(lastBusinessDayBefore(2026, 6), { y: 2026, m: 5, d: 29 });
  assert.equal(new Date(etToUtcMs(2026, 9, 18, 9, 30)).toISOString(), "2026-09-18T13:30:00.000Z");   // EDT
  assert.equal(new Date(etToUtcMs(2026, 12, 18, 9, 30)).toISOString(), "2026-12-18T14:30:00.000Z");  // EST
  assert.deepEqual(nextRollByRoot(now, guard, ["CL"]), []);
});
