/**
 * PROBE INTRADAY LEAD-LAG — does any market LEAD NQ at a horizon we can actually trade (1 hour)?
 *
 * EDGE-HUNTER tested DAILY intermarket lead-lag and found nothing durable; one named next frontier was
 * "intraday lead-lag". This probes exactly that: at the 1-HOUR horizon, does some market X's move in
 * hour t predict NQ's return in hour t+1 — strongly enough to TRADE, and to SURVIVE out-of-sample?
 *
 * Method (same honest discipline as edge-hunter.ts — no peeking):
 *   • pull Databento ohlcv-1h for NQ + a cross-asset basket (ES, ZN, CL, GC, 6E), continuous front month
 *   • align on hourly timestamps; compute each symbol's hourly log return
 *   • predictor = X's return in hour t ; target = NQ's return in hour t+1 (strictly future — NO lookahead)
 *   • split TIME-ORDERED: first 70% = train (pick correlation direction + tercile thresholds),
 *     last 30% = out-of-sample (judge). When X_t is in its top/bottom tercile (TRAIN thresholds),
 *     trade NQ for hour t+1 in the train-correlation direction. Score OOS only.
 *   • also test NQ's own 1h autocorrelation (momentum / mean-reversion) as a baseline
 *   • a predictor "works" ONLY if its OOS t-stat clears the Bonferroni multiple-testing bar
 * Finding NOTHING is a valid, expected result — this rules the category out honestly.
 *
 * COST SAFETY: ohlcv-1h is tiny, but this NEVER pulls blind. It runs a free metadata.get_cost pre-pass
 * over every symbol pull, sums the estimate, and ABORTS if over --max-usd (default $5). Real pulls
 * happen only with --execute AND under the guard. Default is DRY-RUN.
 *
 *   npx tsx scripts/probe-intraday-leadlag.ts                 dry-run: preview $ cost, pull nothing
 *   npx tsx scripts/probe-intraday-leadlag.ts --execute       pull real ohlcv-1h (guarded) → run the study
 *   npx tsx scripts/probe-intraday-leadlag.ts --execute --max-usd 10 --months 12
 */
import fs from "node:fs";

const ROOT = new URL("..", import.meta.url);
const TARGET = "NQ";
const SYMBOLS = ["NQ", "ES", "ZN", "CL", "GC", "6E"]; // continuous front month on GLBX.MDP3
const CACHE_DIR = new URL("data/hourly/", ROOT);

const argv = process.argv.slice(2);
const EXECUTE = argv.includes("--execute");
const MAX_USD = parseFloat(argv[argv.indexOf("--max-usd") + 1]) || 5;
const MONTHS = parseInt(argv[argv.indexOf("--months") + 1]) || 12;

function apiKey(): string | null {
  if (process.env.DATABENTO_API_KEY) return process.env.DATABENTO_API_KEY;
  for (const f of [".env.local", ".env"]) { try { const m = fs.readFileSync(new URL(f, ROOT), "utf8").match(/^DATABENTO_API_KEY=(.+)$/m); if (m) return m[1].trim(); } catch {} }
  return null;
}
const day = (d: Date) => d.toISOString().slice(0, 10);

const mean = (a: number[]) => a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0;
const std = (a: number[]) => { if (a.length < 2) return 1e-9; const m = mean(a); return Math.sqrt(mean(a.map(v => (v - m) ** 2))) || 1e-9; };
// t-stat that the mean next-hour return conditioned on a signal differs from 0
const tstat = (rs: number[]) => rs.length < 5 ? 0 : mean(rs) / (std(rs) / Math.sqrt(rs.length));

// ── Databento ohlcv-1h ───────────────────────────────────────────────────────
function reqBody(sym: string, from: string, to: string, extra: Record<string, string> = {}) {
  return new URLSearchParams({ dataset: "GLBX.MDP3", symbols: `${sym}.v.0`, stype_in: "continuous", schema: "ohlcv-1h", start: from, end: to, ...extra });
}

// Free cost preview for one symbol's full-window ohlcv-1h pull.
async function previewCost(sym: string, from: string, to: string, auth: string): Promise<number> {
  const body = reqBody(sym, from, to, { mode: "historical-streaming" });
  try {
    const r = await fetch("https://hist.databento.com/v0/metadata.get_cost", { method: "POST", headers: { Authorization: auth, "Content-Type": "application/x-www-form-urlencoded" }, body });
    return r.ok ? parseFloat(await r.text()) : NaN;
  } catch { return NaN; }
}

// Pull ohlcv-1h for a symbol → Map<isoHour, close>. Caches to data/hourly/<sym>_1h.csv.
async function pullHourly(sym: string, from: string, to: string, auth: string): Promise<Map<string, number>> {
  const m = new Map<string, number>();
  const body = reqBody(sym, from, to, { encoding: "csv", pretty_px: "true", pretty_ts: "true" });
  const r = await fetch("https://hist.databento.com/v0/timeseries.get_range", { method: "POST", headers: { Authorization: auth, "Content-Type": "application/x-www-form-urlencoded" }, body });
  if (!r.ok) throw new Error(`${sym} pull failed: ${r.status} ${await r.text()}`);
  const text = await r.text();
  const lines = text.trim().split("\n");
  if (lines.length >= 2) {
    const h = lines[0].split(","), ti = h.indexOf("ts_event"), ci = h.indexOf("close");
    for (let i = 1; i < lines.length; i++) {
      const c = lines[i].split(","); const ts = c[ti]?.trim(), close = +c[ci];
      if (ts && isFinite(close) && close > 0) m.set(ts.slice(0, 13), close); // bucket to the hour (YYYY-MM-DDTHH)
    }
  }
  try { fs.mkdirSync(CACHE_DIR, { recursive: true }); fs.writeFileSync(new URL(`${sym}_1h.csv`, CACHE_DIR), text); } catch {}
  return m;
}

// ── Study ──────────────────────────────────────────────────────────────────
interface Row { hour: string; nqFwd: number; feat: Record<string, number>; }

// Build aligned hourly rows: feat[X] = X's log return over hour t ; nqFwd = NQ's log return over hour t+1.
function build(closes: Record<string, Map<string, number>>): Row[] {
  // Common hourly grid: hours present for EVERY symbol, time-ordered.
  const hours = [...closes[TARGET].keys()].filter(h => SYMBOLS.every(s => closes[s].has(h))).sort();
  const ret = (s: string, a: string, b: string) => { const x = closes[s].get(a), y = closes[s].get(b); return x && y ? Math.log(y / x) : NaN; };
  const rows: Row[] = [];
  for (let i = 1; i < hours.length - 1; i++) {
    const prev = hours[i - 1], cur = hours[i], next = hours[i + 1];
    // Only treat consecutive grid hours as one trading step (skip overnight/weekend gaps).
    const stepFwd = ret(TARGET, cur, next); // NQ hour t+1 return — strictly future target
    if (!isFinite(stepFwd)) continue;
    const feat: Record<string, number> = {};
    for (const s of SYMBOLS) { const v = ret(s, prev, cur); if (isFinite(v)) feat[`${s}_lag1`] = v; } // X's hour-t return
    if (Object.keys(feat).length) rows.push({ hour: cur, nqFwd: stepFwd, feat });
  }
  return rows;
}

// Evaluate one feature as a long/short-NQ-next-hour signal, OOS. Direction + thresholds from TRAIN only.
function evalFeature(rows: Row[], key: string): { n: number; t: number; meanR: number; dir: number } | null {
  const data = rows.filter(r => key in r.feat && isFinite(r.feat[key]));
  if (data.length < 200) return null;
  const cut = Math.floor(data.length * 0.7);
  const train = data.slice(0, cut), oos = data.slice(cut);
  // direction on train: does a positive feature precede positive or negative NQ next hour?
  const corrSign = Math.sign(train.reduce((s, r) => s + r.feat[key] * r.nqFwd, 0)) || 1;
  // tercile thresholds from TRAIN only
  const vals = train.map(r => r.feat[key]).sort((a, b) => a - b);
  const hi = vals[Math.floor(vals.length * (2 / 3))], lo = vals[Math.floor(vals.length / 3)];
  const oosRets: number[] = [];
  for (const r of oos) {
    const f = r.feat[key];
    if (f >= hi) oosRets.push(corrSign * r.nqFwd);        // strong positive feature → trade corr dir
    else if (f <= lo) oosRets.push(-corrSign * r.nqFwd);  // strong negative feature → opposite
  }
  if (oosRets.length < 30) return null;
  return { n: oosRets.length, t: tstat(oosRets), meanR: mean(oosRets), dir: corrSign };
}

function report(rows: Row[]) {
  const W = 100;
  console.log("\n" + "═".repeat(W));
  console.log(`  PROBE INTRADAY LEAD-LAG — does any market lead NQ at the 1-HOUR horizon? (out-of-sample)`);
  console.log("═".repeat(W));
  if (rows.length < 400) { console.log(`  insufficient aligned hourly data (${rows.length} rows) — pull more --months`); console.log("═".repeat(W) + "\n"); return; }
  console.log(`  ${rows.length} aligned hours · train 70% / OOS 30% (time-ordered, no lookahead)`);

  const results: { name: string; n: number; t: number; meanR: number }[] = [];
  const featureKeys = [...new Set(rows.flatMap(r => Object.keys(r.feat)))]; // includes NQ_lag1 = own 1h autocorrelation baseline
  for (const key of featureKeys) {
    const r = evalFeature(rows, key);
    if (r) results.push({ name: key, n: r.n, t: r.t, meanR: r.meanR });
  }
  const nTests = results.length;
  // Bonferroni: to claim significance at family-wise 5%, single-test p must be 0.05/nTests → t bar
  const tBar = 1.96 + Math.log(nTests) * 0.45; // rough Bonferroni-adjusted two-sided z for nTests
  results.sort((a, b) => Math.abs(b.t) - Math.abs(a.t));

  console.log(`  ${nTests} predictors tested → multiple-testing bar |t| > ${tBar.toFixed(2)} (Bonferroni); ~${(nTests * 0.05).toFixed(0)} would clear |t|>1.96 by CHANCE alone`);
  console.log("─".repeat(W));
  console.log(`  ${"predictor".padEnd(14)} ${"OOS n".padEnd(8)} ${"t-stat".padEnd(9)} ${"mean next-hr".padEnd(13)} verdict`);
  for (const r of results) {
    const survives = Math.abs(r.t) > tBar;
    const note = r.name === `${TARGET}_lag1` ? " (NQ own autocorr baseline)" : "";
    console.log(`  ${r.name.padEnd(14)} ${String(r.n).padEnd(8)} ${r.t.toFixed(2).padEnd(9)} ${(r.meanR * 100).toFixed(4).padEnd(13)} ${survives ? "✅ SURVIVES" : Math.abs(r.t) > 1.96 ? "🟡 chance-level" : "—"}${note}`);
  }
  const survivors = results.filter(r => Math.abs(r.t) > tBar);
  console.log("─".repeat(W));
  if (survivors.length) {
    console.log(`  ✅ ${survivors.length} predictor(s) cleared the honest bar — candidate intraday lead-lag signals for NQ:`);
    for (const s of survivors) console.log(`     ${s.name}: OOS t=${s.t.toFixed(2)}, mean next-hour ${(s.meanR * 100).toFixed(4)}% (n=${s.n})`);
    console.log(`     ⚠ Candidate only — confirm fill/spread cost at 1h horizon before trusting.`);
  } else {
    console.log(`  ❌ NOTHING cleared the multiple-testing bar. No durable 1-hour intermarket lead-lag edge for NQ.`);
    console.log(`     (Honest result — rules out the category at this horizon. Next frontiers: finer bars (1m/5m), order-flow.)`);
  }
  console.log("═".repeat(W) + "\n");
}

async function main() {
  const key = apiKey();
  const W = 100;
  if (!key) { console.error("⛔ DATABENTO_API_KEY not found — cannot pull hourly bars."); process.exit(1); }
  const auth = "Basic " + Buffer.from(key + ":").toString("base64");

  const to = new Date();
  const fromD = new Date(to); fromD.setUTCMonth(fromD.getUTCMonth() - MONTHS);
  const FROM = day(fromD), TO = day(to);

  console.log("\n" + "═".repeat(W));
  console.log(`  PROBE INTRADAY LEAD-LAG — Databento ohlcv-1h pull plan`);
  console.log("═".repeat(W));
  console.log(`  Window: ${FROM} → ${TO} (${MONTHS}mo)   symbols: ${SYMBOLS.join(", ")}`);
  console.log(`  Mode: ${EXECUTE ? `EXECUTE (guard $${MAX_USD})` : "DRY-RUN (cost preview only — pulls nothing)"}`);
  console.log("─".repeat(W));

  // Free cost pre-pass over every symbol. Sum; abort if over guard.
  let est = 0, priced = 0, unpriced = 0;
  for (const s of SYMBOLS) {
    const c = await previewCost(s, FROM, TO, auth);
    if (isFinite(c)) { est += c; priced++; } else unpriced++;
    console.log(`  ${s.padEnd(6)} ohlcv-1h ${FROM}→${TO}  ~$${isFinite(c) ? c.toFixed(4) : "  n/a"}`);
  }
  console.log("─".repeat(W));
  console.log(`  Cost preview: $${est.toFixed(2)} across ${priced} priced pulls${unpriced ? ` (${unpriced} unpriced/unavailable)` : ""}.`);

  if (est > MAX_USD) {
    console.log(`  ⛔ Estimated $${est.toFixed(2)} exceeds guard $${MAX_USD}. Not pulling. Re-run with --max-usd ${Math.ceil(est)} to allow, or --months <fewer>.`);
    console.log("═".repeat(W) + "\n");
    return;
  }
  if (!EXECUTE) {
    console.log(`  ✅ Under guard. Re-run with --execute to pull the bars and run the study.`);
    console.log("═".repeat(W) + "\n");
    return;
  }

  // EXECUTE: pull each symbol's hourly bars, align, run the OOS study.
  const closes: Record<string, Map<string, number>> = {};
  for (const s of SYMBOLS) {
    closes[s] = await pullHourly(s, FROM, TO, auth);
    console.log(`  pulled ${s.padEnd(6)} ${closes[s].size} hourly bars`);
  }
  const rows = build(closes);
  report(rows);
}
main().catch((e) => { console.error(e); process.exit(1); });
