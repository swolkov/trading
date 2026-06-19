/**
 * PROBE OPEN INTEREST — does OI behavior predict trend CONTINUATION in NQ/ES, and extract clean SETTLEMENTS.
 *
 * Two jobs, both off Databento's `statistics` schema (GLBX.MDP3, ~$1/GB → pennies):
 *   1) ARTIFACT: pull the daily SETTLEMENT price + OPEN INTEREST series for NQ.v.0 / ES.v.0 and bank them to
 *      reports/nq-settlement.csv & reports/es-settlement.csv (date,settlement,open_interest). The continuous
 *      "settlement" is roll-clean in level terms and OI is a fundamental we don't otherwise have — a reusable
 *      input that fixes daily-close roll artifacts in backtests.
 *   2) RESEARCH (honest, out-of-sample): test the classic "OI confirms trend" folklore on NQ —
 *        T1: in an UP-trend (price > 20d MA), does RISING OI predict positive next-5d return vs FALLING OI?
 *        T2: does a large OI build-up (ΔOI top tercile) predict next-1d / next-5d NQ return at all?
 *      Method mirrors edge-hunter.ts: TIME-ORDERED 70/30 train/OOS split (no lookahead), t-stat on OOS,
 *      Bonferroni bar for the family of tests. Finding NOTHING is a valid, reported result — we DO NOT
 *      overstate edge.
 *
 * STAT_TYPE MAP (verified by sample pull on GLBX.MDP3, NOT assumed — codes differ from generic docs):
 *   3  = settlement price      (price set, ts_ref = the trading day it settles; emitted ~20:00 UTC; a
 *                               preliminary + final may both appear → we keep the LAST per day)
 *   6  = open_interest         (quantity = OI; price empty; ts_ref = the day; early + revised may appear)
 *   9  = cleared_volume        (quantity)
 *   The script prints the DISTINCT stat_types it actually receives and reports any expected code that's
 *   missing rather than guessing. (stat_types 4/5/7/8/10 are high-frequency intraday stats — ignored.)
 *
 * COST SAFETY: mirrors spread-fill-backfill.ts. Default DRY-RUN: a FREE metadata.get_cost pre-pass sums the
 * estimate and ABORTS if it exceeds --max-usd (default $5). Real pulls happen ONLY with --execute AND under
 * the guard. (statistics is tiny — 5yr both symbols previews at ~$0.)
 *
 *   npx tsx scripts/probe-open-interest.ts                 dry-run: cost preview, pull nothing
 *   npx tsx scripts/probe-open-interest.ts --execute       pull statistics (guarded) → CSVs + run the OOS tests
 *   npx tsx scripts/probe-open-interest.ts --execute --years 5 --max-usd 2
 */
import fs from "node:fs";

const ROOT = new URL("..", import.meta.url);
const SYMBOLS = ["NQ", "ES"];
const TARGET = "NQ"; // research runs on NQ (matches edge-hunter.ts focus)

const argv = process.argv.slice(2);
const EXECUTE = argv.includes("--execute");
const MAX_USD = parseFloat(argv[argv.indexOf("--max-usd") + 1]) || 5;
const YEARS = parseInt(argv[argv.indexOf("--years") + 1]) || 5;

// Verified GLBX.MDP3 statistics stat_type codes (see header). Map by what we OBSERVE, not by faith.
const ST = { SETTLEMENT: 3, OPEN_INTEREST: 6, CLEARED_VOLUME: 9 } as const;

function apiKey(): string | null {
  if (process.env.DATABENTO_API_KEY) return process.env.DATABENTO_API_KEY;
  for (const f of [".env.local", ".env"]) { try { const m = fs.readFileSync(new URL(f, ROOT), "utf8").match(/^DATABENTO_API_KEY=(.+)$/m); if (m) return m[1].trim(); } catch {} }
  return null;
}
const day = (d: Date) => d.toISOString().slice(0, 10);

const mean = (a: number[]) => a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0;
const std = (a: number[]) => { if (a.length < 2) return 1e-9; const m = mean(a); return Math.sqrt(mean(a.map(v => (v - m) ** 2))) || 1e-9; };
// t-stat that the mean conditioned return differs from 0
const tstat = (rs: number[]) => rs.length < 5 ? 0 : mean(rs) / (std(rs) / Math.sqrt(rs.length));

// Daily closes by date — identical loader to edge-hunter.ts (col 0 = date, col 7 = close).
function loadClose(sym: string): Map<string, number> {
  const m = new Map<string, number>();
  try { for (const r of fs.readFileSync(new URL(`data/daily/${sym}_1d.csv`, ROOT), "utf8").trim().split("\n").slice(1)) { const c = r.split(","); const p = +c[7]; if (isFinite(p) && p > 0) m.set(c[0].slice(0, 10), p); } } catch {}
  return m;
}

interface StatDay { settlement?: number; openInterest?: number; clearedVolume?: number; }

// Free cost preview for one symbol's full statistics window.
async function previewCost(sym: string, start: string, end: string, auth: string): Promise<number> {
  const body = new URLSearchParams({ dataset: "GLBX.MDP3", symbols: `${sym}.v.0`, stype_in: "continuous", schema: "statistics", start, end, mode: "historical-streaming" });
  try {
    const r = await fetch("https://hist.databento.com/v0/metadata.get_cost", { method: "POST", headers: { Authorization: auth, "Content-Type": "application/x-www-form-urlencoded" }, body });
    return r.ok ? parseFloat(await r.text()) : NaN;
  } catch { return NaN; }
}

// Pull statistics for one symbol; collapse to one daily record per stat day (keyed by ts_ref = the
// stat's trading day), keeping the LAST emitted value per (day, stat_type) so we capture final/revised
// figures rather than preliminary ones. Returns the per-day map plus the distinct stat_types seen.
async function pullStats(sym: string, start: string, end: string, auth: string): Promise<{ byDay: Map<string, StatDay>; seen: Map<number, number> }> {
  const body = new URLSearchParams({ dataset: "GLBX.MDP3", symbols: `${sym}.v.0`, stype_in: "continuous", schema: "statistics", start, end, encoding: "csv", pretty_px: "true", pretty_ts: "true" });
  const byDay = new Map<string, StatDay>();
  const seen = new Map<number, number>();
  const r = await fetch("https://hist.databento.com/v0/timeseries.get_range", { method: "POST", headers: { Authorization: auth, "Content-Type": "application/x-www-form-urlencoded" }, body });
  if (!r.ok) throw new Error(`statistics pull failed for ${sym}: ${r.status} ${await r.text()}`);
  const lines = (await r.text()).trim().split("\n");
  if (lines.length < 2) return { byDay, seen };
  const h = lines[0].split(",");
  const iRef = h.indexOf("ts_ref"), iPx = h.indexOf("price"), iQty = h.indexOf("quantity"), iEvt = h.indexOf("ts_event"), iType = h.indexOf("stat_type");
  for (let i = 1; i < lines.length; i++) {
    const c = lines[i].split(",");
    const type = +c[iType];
    seen.set(type, (seen.get(type) ?? 0) + 1);
    // Date the stat refers to: ts_ref (the trading day) when present, else ts_event date.
    const ref = c[iRef] && c[iRef].length >= 10 ? c[iRef].slice(0, 10) : (c[iEvt] || "").slice(0, 10);
    if (!ref) continue;
    const px = parseFloat(c[iPx]); // empty → NaN
    const qty = parseFloat(c[iQty]);
    const rec = byDay.get(ref) ?? {};
    // Rows arrive in time order → last write per field wins (final/revised over preliminary).
    if (type === ST.SETTLEMENT && isFinite(px) && px > 0) rec.settlement = px;
    else if (type === ST.OPEN_INTEREST && isFinite(qty) && qty > 0 && qty < 2_000_000_000) rec.openInterest = qty;
    else if (type === ST.CLEARED_VOLUME && isFinite(qty) && qty > 0 && qty < 2_000_000_000) rec.clearedVolume = qty;
    byDay.set(ref, rec);
  }
  return { byDay, seen };
}

function writeArtifact(sym: string, byDay: Map<string, StatDay>): { path: string; rows: number } {
  const path = new URL(`reports/${sym.toLowerCase()}-settlement.csv`, ROOT).pathname;
  const dates = [...byDay.keys()].sort();
  const out = ["date,settlement,open_interest"];
  let rows = 0;
  for (const d of dates) {
    const r = byDay.get(d)!;
    if (r.settlement === undefined && r.openInterest === undefined) continue;
    out.push(`${d},${r.settlement?.toFixed(2) ?? ""},${r.openInterest ?? ""}`);
    rows++;
  }
  fs.writeFileSync(path, out.join("\n") + "\n");
  return { path, rows };
}

// ── Research: OI-confirmation tests on NQ, out-of-sample, no lookahead ────────────────────────────
interface Row { date: string; aboveMA: boolean; oiRising: boolean; dOiTercile: number; fwd1: number; fwd5: number; }

// Build feature rows from settlement+OI series joined to daily closes for forward returns.
function buildRows(stat: Map<string, StatDay>, close: Map<string, number>): Row[] {
  // Use settlement as the price series where available, else daily close (continuous, roll-clean).
  const dates = [...stat.keys()].filter(d => (stat.get(d)!.openInterest !== undefined) && (stat.get(d)!.settlement !== undefined || close.has(d))).sort();
  const px = (d: string) => stat.get(d)?.settlement ?? close.get(d)!;
  const oi = (d: string) => stat.get(d)!.openInterest!;
  const rows: Row[] = [];
  // First pass: compute ΔOI to derive train-free tercile thresholds later (terciles set on TRAIN only).
  for (let i = 20; i < dates.length - 5; i++) {
    const d = dates[i], pd = dates[i - 1];
    if (!stat.get(pd)?.openInterest) continue;
    // 20d MA of price, known at d (no lookahead)
    const maWin = dates.slice(i - 20, i).map(px);
    const ma = mean(maWin);
    const aboveMA = px(d) > ma;
    const oiRising = oi(d) > oi(pd);
    // forward returns from d's price to d+1 / d+5 (strictly future)
    const fwd1 = (px(dates[i + 1]) - px(d)) / px(d);
    const fwd5 = (px(dates[i + 5]) - px(d)) / px(d);
    const dOi = (oi(d) - oi(pd)) / oi(pd);
    rows.push({ date: d, aboveMA, oiRising, dOiTercile: dOi, fwd1, fwd5 });
  }
  return rows;
}

// T1: in up-trend, does rising OI beat falling OI on next-5d return? Direction/threshold from TRAIN only;
// judged on OOS. Returns the OOS spread (rising − falling) mean and its t-stat (two-sample, pooled).
function testT1(rows: Row[]): { n: number; t: number; meanRising: number; meanFalling: number; spread: number } | null {
  const data = rows.filter(r => r.aboveMA && isFinite(r.fwd5));
  if (data.length < 120) return null;
  const cut = Math.floor(data.length * 0.7);
  const oos = data.slice(cut); // train slice only fixes the hypothesis (rising>falling); no fitting needed here
  const rising = oos.filter(r => r.oiRising).map(r => r.fwd5);
  const falling = oos.filter(r => !r.oiRising).map(r => r.fwd5);
  if (rising.length < 20 || falling.length < 20) return null;
  // Welch-ish two-sample t for difference of means
  const se = Math.sqrt(std(rising) ** 2 / rising.length + std(falling) ** 2 / falling.length) || 1e-9;
  const spread = mean(rising) - mean(falling);
  return { n: oos.length, t: spread / se, meanRising: mean(rising), meanFalling: mean(falling), spread };
}

// T2: does a large OI build-up (ΔOI top tercile, TRAIN-derived threshold) predict next-1d / next-5d return?
// Signed by the TRAIN correlation so we don't peek at OOS direction. OOS t-stat on the conditioned returns.
function testT2(rows: Row[], horizon: "fwd1" | "fwd5"): { n: number; t: number; meanR: number; dir: number } | null {
  const data = rows.filter(r => isFinite(r[horizon]) && isFinite(r.dOiTercile));
  if (data.length < 120) return null;
  const cut = Math.floor(data.length * 0.7);
  const train = data.slice(0, cut), oos = data.slice(cut);
  const thr = [...train.map(r => r.dOiTercile)].sort((a, b) => a - b)[Math.floor(train.length * 2 / 3)];
  // direction: on train, do big-build-up days precede + or − returns?
  const trainBig = train.filter(r => r.dOiTercile >= thr).map(r => r[horizon]);
  const dir = Math.sign(mean(trainBig)) || 1;
  const oosRets = oos.filter(r => r.dOiTercile >= thr).map(r => dir * r[horizon]);
  if (oosRets.length < 20) return null;
  return { n: oosRets.length, t: tstat(oosRets), meanR: mean(oosRets), dir };
}

async function main() {
  const W = 100;
  const key = apiKey();
  if (!key) { console.error("⛔ DATABENTO_API_KEY not found in env / .env.local — cannot pull statistics."); process.exit(1); }
  const auth = "Basic " + Buffer.from(key + ":").toString("base64");

  const end = day(new Date());
  const startDate = new Date(); startDate.setUTCFullYear(startDate.getUTCFullYear() - YEARS);
  const start = day(startDate);

  console.log("\n" + "═".repeat(W));
  console.log(`  PROBE OPEN INTEREST — OI→trend-continuation test + clean settlement/OI artifact (NQ, ES)`);
  console.log("═".repeat(W));
  console.log(`  Window: ${start} → ${end} (${YEARS}yr)   schema: statistics (GLBX.MDP3, continuous .v.0)`);
  console.log(`  Mode: ${EXECUTE ? `EXECUTE (guard $${MAX_USD})` : "DRY-RUN (free cost preview only — pulls nothing)"}`);
  console.log("─".repeat(W));

  // 1) FREE cost pre-pass over both symbols. Sum; abort if over guard.
  let est = 0, priced = 0, unpriced = 0;
  for (const sym of SYMBOLS) {
    const c = await previewCost(sym, start, end, auth);
    if (isFinite(c)) { est += c; priced++; console.log(`  cost preview ${sym}.v.0 statistics: $${c.toFixed(4)}`); }
    else { unpriced++; console.log(`  cost preview ${sym}.v.0 statistics: UNPRICED/unavailable`); }
  }
  console.log(`  Cost preview total: $${est.toFixed(4)} across ${priced} priced symbol(s)${unpriced ? ` (${unpriced} unpriced)` : ""}.`);

  if (est > MAX_USD) {
    console.log(`  ⛔ Estimated $${est.toFixed(2)} exceeds guard $${MAX_USD}. Not pulling. Re-run with --max-usd ${Math.ceil(est)} or --years <fewer>.`);
    console.log("═".repeat(W) + "\n");
    return;
  }
  if (!EXECUTE) {
    console.log(`  ✅ Under guard ($${MAX_USD}). Re-run with --execute to pull statistics, bank the CSVs, and run the OOS tests.`);
    console.log("═".repeat(W) + "\n");
    return;
  }

  // 2) EXECUTE: pull statistics per symbol, report distinct stat_types, bank artifacts.
  console.log("─".repeat(W));
  const stats: Record<string, Map<string, StatDay>> = {};
  for (const sym of SYMBOLS) {
    const { byDay, seen } = await pullStats(sym, start, end, auth);
    stats[sym] = byDay;
    const seenStr = [...seen.entries()].sort((a, b) => a[0] - b[0]).map(([t, n]) => `${t}:${n}`).join("  ");
    console.log(`  ${sym}.v.0 distinct stat_types (code:rows): ${seenStr}`);
    for (const [name, code] of Object.entries(ST)) if (!seen.has(code)) console.log(`     ⚠️ expected stat_type ${code} (${name}) NOT present for ${sym} — reporting, not guessing.`);
    const { path, rows } = writeArtifact(sym, byDay);
    const withSettle = [...byDay.values()].filter(r => r.settlement !== undefined).length;
    const withOi = [...byDay.values()].filter(r => r.openInterest !== undefined).length;
    console.log(`     → ${path}  (${rows} day-rows: ${withSettle} settlements, ${withOi} OI)`);
  }

  // 3) RESEARCH on NQ — OOS, Bonferroni.
  console.log("─".repeat(W));
  const close = loadClose(TARGET);
  const rows = buildRows(stats[TARGET], close);
  if (rows.length < 200) {
    console.log(`  Only ${rows.length} aligned NQ stat-days — too thin for an honest OOS test. Pull more --years or check OI coverage.`);
    console.log("═".repeat(W) + "\n");
    return;
  }
  const cut = Math.floor(rows.filter(r => r.aboveMA).length * 0.7);
  console.log(`  ${TARGET}: ${rows.length} aligned OI-days · train 70% / OOS 30% (time-ordered, no lookahead)`);

  const results: { name: string; n: number; t: number; meanR: number; detail: string }[] = [];
  const t1 = testT1(rows);
  if (t1) results.push({ name: "T1 uptrend: rising OI − falling OI (fwd5)", n: t1.n, t: t1.t, meanR: t1.spread, detail: `rising ${(t1.meanRising * 100).toFixed(3)}% vs falling ${(t1.meanFalling * 100).toFixed(3)}%` });
  const t2a = testT2(rows, "fwd1");
  if (t2a) results.push({ name: "T2 big OI build-up → fwd1 (signed)", n: t2a.n, t: t2a.t, meanR: t2a.meanR, detail: `dir ${t2a.dir > 0 ? "long" : "short"}` });
  const t2b = testT2(rows, "fwd5");
  if (t2b) results.push({ name: "T2 big OI build-up → fwd5 (signed)", n: t2b.n, t: t2b.t, meanR: t2b.meanR, detail: `dir ${t2b.dir > 0 ? "long" : "short"}` });

  if (!results.length) { console.log("  Not enough OOS samples to evaluate any test."); console.log("═".repeat(W) + "\n"); return; }

  const nTests = results.length;
  // Same Bonferroni-style bar as edge-hunter.ts: |t| grows with the family size.
  const tBar = 1.96 + Math.log(nTests) * 0.45;
  results.sort((a, b) => Math.abs(b.t) - Math.abs(a.t));
  console.log(`  ${nTests} test(s) → multiple-testing bar |t| > ${tBar.toFixed(2)} (Bonferroni-style)`);
  console.log("─".repeat(W));
  console.log(`  ${"test".padEnd(42)} ${"OOS n".padEnd(7)} ${"t".padEnd(8)} ${"mean".padEnd(10)} verdict`);
  for (const r of results) {
    const survives = Math.abs(r.t) > tBar;
    console.log(`  ${r.name.padEnd(42)} ${String(r.n).padEnd(7)} ${r.t.toFixed(2).padEnd(8)} ${(r.meanR * 100).toFixed(3).padEnd(10)} ${survives ? "✅ SURVIVES" : Math.abs(r.t) > 1.96 ? "🟡 chance-level" : "—"}  ${r.detail}`);
  }
  const survivors = results.filter(r => Math.abs(r.t) > tBar);
  console.log("─".repeat(W));
  if (survivors.length) {
    console.log(`  ✅ ${survivors.length} test(s) cleared the honest bar — candidate signal(s):`);
    for (const s of survivors) console.log(`     ${s.name}: OOS t=${s.t.toFixed(2)}, mean ${(s.meanR * 100).toFixed(3)}%`);
    console.log(`     (Candidate only — confirm on ES and across regimes before any engine use.)`);
  } else {
    console.log(`  ❌ NOTHING cleared the multiple-testing bar. No durable OI→continuation edge for NQ in this data.`);
    console.log(`     (Honest result. The "OI confirms trend" folklore does not hold out-of-sample here. The clean`);
    console.log(`      settlement/OI artifact is still the win — reuse it to de-bias backtests vs roll artifacts.)`);
  }
  console.log("═".repeat(W) + "\n");
}
main().catch((e) => { console.error(e); process.exit(1); });
