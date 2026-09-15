import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { BRIEF_SECTIONS, REFUSED_OUTCOMES, cushionUsed, deriveAction, renderDeskBrief, type BriefInput } from "../src/lib/margin-brief";
import { briefDue } from "../src/lib/margin-brief-build";
import { realizedVol, renderCryptoRegime, breadthOf } from "../src/lib/margin-crypto-regime";
import { REGIME_LABELS, regimeLabel, regimeLabelFor } from "../src/lib/margin-regime-label";
import { gatherIntel, stampSql } from "../src/lib/margin-intel";
import { INTEL_STAMP_COLUMNS } from "../src/lib/margin-shadow";
import type { TfFeatures } from "../src/lib/margin-scanner";

const EMPTY: BriefInput = { at: "2026-09-15T13:05:00Z", regime: null, opportunities: [], paperOpen: [], livePositions: [], livePositionsAt: null, strategies: [], live: null, review: null, risk: null };
const ARMED: BriefInput["live"] = { armed: true, validateOnly: false, sources: ["swing-pyr"], stage3: { status: "held", target: 20 }, fills: { count: 3, closed: 2, realNet: 41, verdict: "consistent" } };
const CALM_RISK: NonNullable<BriefInput["risk"]> = { equity: 4600, marginLevel: null, dd: 1.2, tier: 0, mult: 1, losersToday: 0, exposure: null, cushionWarn: false, breakerTripped: false };
const QUIET_REVIEW: NonNullable<BriefInput["review"]> = { underReview: [], demoted: null, decay: { multiplier: "1", state: "stable", source: "swing-pyr" }, anomaly: null };
const FRESH_HIGH = { coin: "ETH", tf: "4h", kind: "breakout", score: 84, tier: "high", outcome: "TRADED LIVE", detail: "sent" };
const base = (over: Partial<BriefInput>): BriefInput => ({ ...EMPTY, live: ARMED, risk: CALM_RISK, review: QUIET_REVIEW, regime: { btc: null, eth: null, ethBtc: null, breadth: null, realizedVol20: null, funding: null, fearGreed: null, event: { mode: "normal", reason: "clear" }, btcShock: "calm" }, ...over });

test("deriveAction truth table: paused/breaker/anomaly → NO TRADE; cushion/demotion/decay → REDUCE/EXIT; armed + fresh HIGH not refused → ENTER; armed → WAIT; nothing armed → PAPER TEST", () => {
  assert.equal(deriveAction(EMPTY).action, "PAPER TEST");
  assert.equal(deriveAction(base({ live: { ...ARMED, armed: false } })).action, "PAPER TEST");
  assert.equal(deriveAction(base({ live: { ...ARMED, validateOnly: true } })).action, "PAPER TEST");
  assert.equal(deriveAction(base({})).action, "WAIT");
  assert.equal(deriveAction(base({ opportunities: [FRESH_HIGH] })).action, "ENTER");
  assert.match(deriveAction(base({ opportunities: [FRESH_HIGH] })).reason, /ETH 4h breakout — high conviction, score 84, TRADED LIVE/);
  // A HIGH that was refused is not an ENTER; a MED is not either.
  for (const outcome of REFUSED_OUTCOMES) assert.equal(deriveAction(base({ opportunities: [{ ...FRESH_HIGH, outcome }] })).action, "WAIT", outcome);
  assert.equal(deriveAction(base({ opportunities: [{ ...FRESH_HIGH, tier: "med" }] })).action, "WAIT");
  // REDUCE/EXIT beats ENTER.
  assert.equal(deriveAction(base({ opportunities: [FRESH_HIGH], risk: { ...CALM_RISK, cushionWarn: true } })).action, "REDUCE/EXIT");
  assert.equal(deriveAction(base({ opportunities: [FRESH_HIGH], review: { ...QUIET_REVIEW, demoted: { source: "swing-pyr", reason: "forward record negative" } } })).action, "REDUCE/EXIT");
  assert.equal(deriveAction(base({ opportunities: [FRESH_HIGH], review: { ...QUIET_REVIEW, decay: { multiplier: "0.5", state: "DECAYING", source: "swing-pyr" } } })).action, "REDUCE/EXIT");
  assert.equal(deriveAction(base({ review: { ...QUIET_REVIEW, decay: { multiplier: "0.5", state: null, source: null } } })).action, "REDUCE/EXIT", "a reduced multiplier alone reduces");
  // NO TRADE beats everything.
  assert.equal(deriveAction(base({ opportunities: [FRESH_HIGH], risk: { ...CALM_RISK, cushionWarn: true }, regime: { ...base({}).regime!, event: { mode: "paused", reason: "FOMC in 10 min" } } })).action, "NO TRADE");
  assert.equal(deriveAction(base({ opportunities: [FRESH_HIGH], risk: { ...CALM_RISK, breakerTripped: true } })).action, "NO TRADE");
  assert.equal(deriveAction(base({ opportunities: [FRESH_HIGH], review: { ...QUIET_REVIEW, anomaly: "book mismatch on XBTUSD" } })).action, "NO TRADE");
  assert.match(deriveAction(base({ regime: { ...base({}).regime!, event: { mode: "paused", reason: "FOMC in 10 min" } } })).reason, /event window paused — FOMC/);
});

test("the eight headers render in the prompt's order, once each; empty inputs render — in every section, and an unread account is unknown, not flat", () => {
  const text = renderDeskBrief(EMPTY);
  const positions = BRIEF_SECTIONS.map((h) => text.indexOf(`## ${h}`));
  for (let i = 0; i < positions.length; i++) {
    assert.ok(positions[i] > 0, `${BRIEF_SECTIONS[i]} present`);
    if (i > 0) assert.ok(positions[i] > positions[i - 1], `${BRIEF_SECTIONS[i]} after ${BRIEF_SECTIONS[i - 1]}`);
    assert.equal(text.split(`## ${BRIEF_SECTIONS[i]}`).length, 2, `${BRIEF_SECTIONS[i]} once`);
  }
  assert.deepEqual([...BRIEF_SECTIONS], ["MARKET REGIME", "BEST OPPORTUNITIES", "TRADE TABLE", "PAPER STRATEGIES", "LIVE STRATEGIES", "UNDER REVIEW", "PORTFOLIO RISK", "ACTION"]);
  const sections = text.split(/\n## /).slice(1);
  assert.equal(sections.length, 8);
  for (const s of sections.slice(0, 7)) assert.ok(s.includes("—"), `section renders —: ${s.slice(0, 40)}`);
  assert.ok(/positions unknown, not zero/.test(text));
  assert.ok(text.trimEnd().endsWith("**PAPER TEST** — nothing armed — the record keeps measuring on paper"));
  assert.ok(text.startsWith("# Crypto desk brief — 2026-09-15 13:05Z"));
});

test("a populated brief: top-5 opportunities by score, live table with cushion, strategies with weekly action, risk line", () => {
  const opps = [60, 91, 75, 88, 40, 99, 12].map((score, n) => ({ coin: `C${n}`, tf: "4h", kind: "breakout", score, tier: "high", outcome: "paper only" }));
  const text = renderDeskBrief(base({
    opportunities: [...opps, { coin: "X", tf: "5m", kind: "volume-spike", outcome: "watched" }],
    livePositions: [{ pair: "XBTUSD", side: "long", leverage: 9, entryPrice: 76000, net: -12.5, cushionUsed: 0.31 }],
    livePositionsAt: "2026-09-15T13:04:40Z",
    paperOpen: [{ symbol: "ETH/USD", side: "buy", source: "swing-pyr", entry: 2430, unrealized: 18, ageH: 7, maxHoldH: 168 }],
    strategies: [{ key: "swing-pyr", label: "swing-pyr", resolved: 41, hitRate: 0.44, liveNet: 812, tStat: 2.1, verdict: "REAL EDGE", action: "PROMOTE-READY" }],
    review: { ...QUIET_REVIEW, underReview: ["selective: KILL CANDIDATE"] },
    risk: { ...CALM_RISK, marginLevel: 412, exposure: { grossNotional: 20000, netNotional: 20000, riskIfAllStopsHitUsd: 368, riskIfAllStopsHitPct: 8, breakerHeadroomPct: 13.8, clusterOk: true } },
  }));
  const best = text.split("## BEST OPPORTUNITIES")[1].split("## TRADE TABLE")[0];
  const rows = best.split("\n").filter((l) => /^\| \d /.test(l));
  assert.equal(rows.length, 5);
  assert.deepEqual(rows.map((r) => r.split("|")[2].trim()), ["C5", "C1", "C3", "C2", "C0"]);
  assert.ok(!best.includes("| X |"), "non-directional signals are not opportunities");
  assert.ok(/\| XBTUSD \| long \| 9× \| \$76,000 \| −\$13 \| 31% \|/.test(text));
  assert.ok(/cached read at 13:04Z/.test(text));
  assert.ok(/\| ETH\/USD \| buy \| swing-pyr \| \$2,430 \| \$18 \| 7h \/ 168h \|/.test(text));
  assert.ok(/\| swing-pyr \| 41 \| 44% \| \$812 \| 2\.10 \| REAL EDGE \| PROMOTE-READY \|/.test(text));
  assert.ok(/- selective: KILL CANDIDATE/.test(text));
  assert.ok(/Equity \$4,600 · margin level 412% · drawdown 1\.2% \(tier 0, ×1\) · losers today 0/.test(text));
  assert.ok(/all-stops risk \$368 \(8\.0% of equity\) · breaker headroom 13\.8% · cluster ok/.test(text));
  assert.ok(/\*\*ENTER\*\* — C5 4h breakout/.test(text));
});

test("cushionUsed: a 9× long at entry has used 0; at −4% it has used 60% (the stop sits at 0.6 of the cushion); shorts mirror", () => {
  assert.ok(Math.abs(cushionUsed("long", 100, 9, 100)! - 0) < 1e-9);
  const used = cushionUsed("long", 100, 9, 96)!;
  assert.ok(used > 0.55 && used < 0.65, `used ${used}`);
  assert.ok(cushionUsed("short", 100, 9, 104)! > 0.55);
  assert.equal(cushionUsed("long", 100, 9, null), null);
  assert.equal(cushionUsed("long", 0, 9, 100), null);
});

test("briefDue: first tick at/after 13:00 UTC, once per UTC day", () => {
  assert.deepEqual(briefDue(null, Date.parse("2026-09-15T12:59:00Z")), { due: false, day: "2026-09-15" });
  assert.deepEqual(briefDue(null, Date.parse("2026-09-15T13:00:00Z")), { due: true, day: "2026-09-15" });
  assert.deepEqual(briefDue("2026-09-15", Date.parse("2026-09-15T13:05:00Z")), { due: false, day: "2026-09-15" });
  assert.deepEqual(briefDue("2026-09-15", Date.parse("2026-09-15T23:59:00Z")), { due: false, day: "2026-09-15" });
  assert.deepEqual(briefDue("2026-09-15", Date.parse("2026-09-16T13:00:00Z")), { due: true, day: "2026-09-16" });
  assert.deepEqual(briefDue("2026-09-14", Date.parse("2026-09-15T18:00:00Z")), { due: true, day: "2026-09-15" });
});

// ---- regime labels (B6 / prompt 1's nine words) ----
const feat = (over: Partial<TfFeatures> = {}): TfFeatures => ({
  close: 100, ret1: 0.01, sma20: 97, prevClose20: 95, hh20: 99, ll20: 90, hh90: 112, ll90: 80, atr14: 2, atrRatio30: 1, volRatio20: 1, rsi14: 55,
  lastRange: 0.02, dollarVol20: 1e6, gapBars: 0, dupBars: 0, staleMs: 0, dataOk: true, dataReason: null, ...over,
});
const UP = feat(), DOWN = feat({ close: 90, sma20: 95, prevClose20: 97 }), FLAT = feat({ close: 96, sma20: 97, prevClose20: 95 });

test("regimeLabel: the nine labels with the stated precedence; missing features → unknown; never a throw", () => {
  assert.equal(REGIME_LABELS.length, 10);
  assert.equal(regimeLabel(UP, UP), "strong bull");
  assert.equal(regimeLabel(UP, FLAT), "weak bull");
  assert.equal(regimeLabel(UP, DOWN), "weak bull");
  assert.equal(regimeLabel(DOWN, DOWN), "strong bear");
  assert.equal(regimeLabel(DOWN, UP), "weak bear");
  assert.equal(regimeLabel(FLAT, UP), "range");
  assert.equal(regimeLabel(FLAT, feat({ ...FLAT, atrRatio30: 1.6 })), "high-vol chop");
  assert.equal(regimeLabel(UP, feat({ ...UP, atrRatio30: 1.6 })), "strong bull", "chop needs a flat daily");
  assert.equal(regimeLabel(UP, feat({ ...UP, atrRatio30: 0.5 })), "low-vol compression");
  assert.equal(regimeLabel(UP, feat({ ...UP, atrRatio30: 2, close: 100, hh20: 99 })), "breakout");
  assert.equal(regimeLabel(DOWN, feat({ ...DOWN, atrRatio30: 2, close: 89, ll20: 90 })), "breakout");
  assert.equal(regimeLabel(UP, feat({ ...UP, atrRatio30: 2, close: 98, hh20: 99 })), "strong bull", "expansion inside the range is not a breakout");
  assert.equal(regimeLabel(feat({ atrRatio30: 3, ret1: -0.09 }), UP), "panic");
  assert.equal(regimeLabel(feat({ atrRatio30: 3, ret1: 0.08 }), feat({ atrRatio30: 0.4 })), "panic", "panic wins over compression");
  assert.equal(regimeLabel(feat({ atrRatio30: 2.9, ret1: -0.2 }), UP), "strong bull", "vol ratio under 3 is not panic");
  assert.equal(regimeLabel(feat({ atrRatio30: 5, ret1: -0.07 }), UP), "strong bull", "a 7% move is not panic");
  assert.equal(regimeLabel(null, null), "unknown");
  assert.equal(regimeLabel(undefined, UP), "unknown");
  assert.equal(regimeLabel(feat({ close: NaN, sma20: NaN, prevClose20: NaN, atrRatio30: NaN, ret1: NaN }), null), "range");
  assert.equal(regimeLabelFor({ "BTC:1d": UP, "BTC:4h": UP }, "BTC"), "strong bull");
  assert.equal(regimeLabelFor({}, "BTC"), "unknown");
});

test("regime_label is stamped per coin through gatherIntel/stampSql and is an ensureShadowColumns column", () => {
  const intel = gatherIntel({ features: { "ETH:1d": UP, "ETH:4h": UP } });
  const s = stampSql(intel, "ETH");
  const i = s.columns.indexOf("regime_label");
  assert.ok(i > 0);
  assert.equal(s.values[i], "strong bull");
  assert.equal(stampSql(intel, "DOGE").values[stampSql(intel, "DOGE").columns.indexOf("regime_label")], "unknown");
  assert.ok(INTEL_STAMP_COLUMNS.some((c) => c.startsWith("regime_label ")));
});

test("crypto regime helpers: realised vol on a flat series is 0, on a noisy one positive, under-sampled null; breadth counts above-SMA coins", () => {
  assert.equal(realizedVol(new Array(21).fill(100)), 0);
  const noisy = Array.from({ length: 30 }, (_, i) => 100 * (1 + 0.02 * Math.sin(i)));
  assert.ok(realizedVol(noisy)! > 0);
  assert.equal(realizedVol([1, 2, 3]), null);
  assert.deepEqual(breadthOf({ "BTC:1d": UP, "ETH:1d": DOWN, "SOL:1d": UP, "NOPE:1d": UP }), { above: 2, of: 3 });
  assert.equal(breadthOf(null), null);
  assert.equal(breadthOf({}), null);
  const page = renderCryptoRegime({ btc: { close: 76340, sma20: 78100, label: "weak bear" }, eth: null, ethBtc: 0.0318, breadth: { above: 9, of: 26 }, realizedVol20: 0.48, funding: { btc: 0.00018, eth: null }, fearGreed: { value: 69, label: "Greed" }, event: { mode: "normal", reason: "clear" }, btcShock: "calm" }, "2026-09-15T13:05:00Z");
  assert.ok(page.startsWith('---\nlast_updated: "2026-09-15"'));
  assert.ok(/\*\*BTC\*\*: `weak bear` · \*\*ETH\*\*: `unknown`/.test(page));
  assert.ok(/BTC \$76,340 vs 20d SMA \$78,100 \(−2\.3%\) — weak bear/.test(page));
  assert.ok(/- ETH: —/.test(page));
  assert.ok(/ETH\/BTC: 0\.03180/.test(page) && /9\/26 coins above/.test(page) && /48% annualised/.test(page) && /BTC \+0\.018%/.test(page) && /69 \(Greed\)/.test(page));
});

test("source: the brief is scheduled inside margin-scan (no new cron), positions come from the cached display snapshot, the synthesis refreshes the regime file, and the executor/guardian never import the brief", () => {
  const scan = readFileSync(new URL("../src/app/api/cron/margin-scan/route.ts", import.meta.url), "utf8");
  assert.ok(/briefDue\(state\.briefDay, Date\.now\(\)\)/.test(scan));
  assert.ok(/routeDeadlineMs - Date\.now\(\) > 60_000/.test(scan), "guarded by the route deadline");
  assert.ok(/state\.briefDay = due\.day;\s*\n\s*await saveState\(state\);\s*\n\s*const b = await publishDeskBrief/.test(scan), "the day key is saved BEFORE the brief runs");
  const vercel = readFileSync(new URL("../vercel.json", import.meta.url), "utf8");
  assert.ok(!/margin[-/]brief/.test(vercel), "no new cron for the margin brief");
  const build = readFileSync(new URL("../src/lib/margin-brief-build.ts", import.meta.url), "utf8");
  assert.ok(/marginDisplaySnapshot\(\)/.test(build) && !/getKrakenMarginPositions|getKrakenMarginHealth|krakenPrivate/.test(build), "live positions via the cached snapshot only");
  const synth = readFileSync(new URL("../src/lib/margin-synthesis.ts", import.meta.url), "utf8");
  assert.ok(/await refreshCryptoRegime\(\)\.catch/.test(synth));
  const regime = readFileSync(new URL("../src/lib/margin-crypto-regime.ts", import.meta.url), "utf8");
  assert.ok(!/margin-synthesis|krakenPrivate/.test(regime), "the regime module never imports the synthesis (no cycle) and never reads privately");
  for (const f of ["../src/lib/margin-executor.ts", "../src/app/api/cron/margin-watch/route.ts"]) {
    assert.ok(!/margin-brief|margin-regime-label|margin-crypto-regime/.test(readFileSync(new URL(f, import.meta.url), "utf8")), `${f} does not import the brief`);
  }
});
