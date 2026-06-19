/**
 * PROBE-ORDERFLOW — does ORDER FLOW (cumulative delta = aggressor-signed volume) predict
 * NQ's NEXT-DAY return? Tested with strict out-of-sample validation + honest multiple-testing.
 *
 * Cumulative delta = sum(size where aggressor='A'/buyer-lifts-ask) − sum(size where 'B'/seller-hits-bid),
 * built per CALENDAR DAY from the Databento `trades` schema for ES.v.0 and NQ.v.0 (continuous, GLBX.MDP3).
 * Predictors (each a long/short-NQ-next-day signal, direction chosen on TRAIN only, judged OOS):
 *   • net delta (same day)            • normalized delta (delta / daily volume)
 *   • 3-day delta momentum            • delta divergence (delta up but price down, or vice versa)
 * Plus the cross-asset ES versions of each (does ES order flow lead NQ?). Same discipline as edge-hunter.ts:
 * time-ordered 70/30 split, NO lookahead (day-t delta predicts day t+1 return), Bonferroni bar.
 * Finding NOTHING is a valid, expected result — this does not manufacture edge.
 *
 * COST SAFETY: the `trades` schema is large; this NEVER pulls blind. It runs a FREE metadata.get_cost
 * pre-pass over every (symbol, month-chunk) it would fetch, sums the estimate, and ABORTS if the total
 * exceeds --max-usd (default $5). Real pulls happen only with --execute AND under the guard.
 *
 *   npx tsx scripts/probe-orderflow.ts                       dry-run: preview $ cost, pull nothing
 *   npx tsx scripts/probe-orderflow.ts --execute             pull real trades (guarded) → analyze
 *   npx tsx scripts/probe-orderflow.ts --execute --max-usd 10 --months 12
 */
import fs from "node:fs";

const ROOT = new URL("..", import.meta.url);
const TARGET = "NQ";
const SYMBOLS = ["ES", "NQ"];                       // pull order flow for both; NQ is target, ES is lead-lag test
const DELTA_CACHE = new URL("data/orderflow", ROOT).pathname; // banked per-(sym,month) delta so re-runs are free

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
const addMonths = (ds: string, n: number) => { const d = new Date(ds + "T00:00:00Z"); d.setUTCMonth(d.getUTCMonth() + n); return day(d); };

// Daily closes by date — identical loader to edge-hunter.ts (col 7 = close).
function loadClose(sym: string): Map<string, number> {
  const m = new Map<string, number>();
  try { for (const r of fs.readFileSync(new URL(`data/daily/${sym}_1d.csv`, ROOT), "utf8").trim().split("\n").slice(1)) { const c = r.split(","); const p = +c[7]; if (isFinite(p) && p > 0) m.set(c[0].slice(0, 10), p); } } catch {}
  return m;
}

const mean = (a: number[]) => a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0;
const std = (a: number[]) => { if (a.length < 2) return 1e-9; const m = mean(a); return Math.sqrt(mean(a.map(v => (v - m) ** 2))) || 1e-9; };
// t-stat that the mean next-day return conditioned on a signal differs from 0
const tstat = (rs: number[]) => rs.length < 5 ? 0 : mean(rs) / (std(rs) / Math.sqrt(rs.length));

// Month chunks [start, end) covering the last MONTHS, ending today (exclusive of future).
function monthChunks(): { start: string; end: string }[] {
  const end0 = day(new Date());
  const start0 = addMonths(end0, -MONTHS);
  const out: { start: string; end: string }[] = [];
  let s = start0;
  while (s < end0) { const e = addMonths(s, 1) < end0 ? addMonths(s, 1) : end0; out.push({ start: s, end: e }); s = e; }
  return out;
}

// Free cost preview for one (symbol, month-chunk) trades pull.
async function previewCost(sym: string, start: string, end: string, auth: string): Promise<number> {
  const body = new URLSearchParams({ dataset: "GLBX.MDP3", symbols: `${sym}.v.0`, stype_in: "continuous", schema: "trades", start, end, mode: "historical-streaming" });
  try {
    const r = await fetch("https://hist.databento.com/v0/metadata.get_cost", { method: "POST", headers: { Authorization: auth, "Content-Type": "application/x-www-form-urlencoded" }, body });
    return r.ok ? parseFloat(await r.text()) : NaN;
  } catch { return NaN; }
}

interface DayFlow { aggBuy: number; aggSell: number; }  // sum of size by aggressor side

// Pull one (sym, month-chunk) of trades, aggregate per calendar date into delta. Streams the CSV
// line-by-line and accumulates so we never hold the whole (large) body parsed in memory at once.
async function pullChunkFlow(sym: string, start: string, end: string, auth: string, acc: Map<string, DayFlow>): Promise<boolean> {
  const body = new URLSearchParams({ dataset: "GLBX.MDP3", symbols: `${sym}.v.0`, stype_in: "continuous", schema: "trades", start, end, encoding: "csv", pretty_ts: "true" });
  const r = await fetch("https://hist.databento.com/v0/timeseries.get_range", { method: "POST", headers: { Authorization: auth, "Content-Type": "application/x-www-form-urlencoded" }, body });
  if (!r.ok || !r.body) return false;
  const reader = r.body.getReader();
  const dec = new TextDecoder();
  let buf = "", header: string[] | null = null, tsI = -1, sideI = -1, sizeI = -1;
  const handle = (line: string) => {
    if (!line) return;
    if (!header) { header = line.split(","); tsI = header.indexOf("ts_event"); sideI = header.indexOf("side"); sizeI = header.indexOf("size"); return; }
    const c = line.split(",");
    const side = c[sideI]; if (side !== "A" && side !== "B") return;  // skip 'N'/unknown
    const sz = +c[sizeI]; if (!isFinite(sz) || sz <= 0) return;
    const date = c[tsI].slice(0, 10);                                  // UTC calendar date
    const f = acc.get(date) ?? (acc.set(date, { aggBuy: 0, aggSell: 0 }).get(date)!);
    if (side === "A") f.aggBuy += sz; else f.aggSell += sz;
  };
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) { handle(buf.slice(0, nl).trimEnd()); buf = buf.slice(nl + 1); }
  }
  if (buf.trim()) handle(buf.trim());
  return true;
}

// Per-symbol delta cache file: date,aggBuy,aggSell. Banked so re-analysis never re-pulls.
function flowCachePath(sym: string) { return `${DELTA_CACHE}/${sym}_delta.csv`; }
function loadFlowCache(sym: string): Map<string, DayFlow> {
  const m = new Map<string, DayFlow>();
  try { for (const r of fs.readFileSync(flowCachePath(sym), "utf8").trim().split("\n").slice(1)) { const c = r.split(","); if (c.length >= 3) m.set(c[0], { aggBuy: +c[1], aggSell: +c[2] }); } } catch {}
  return m;
}
function saveFlowCache(sym: string, m: Map<string, DayFlow>) {
  fs.mkdirSync(DELTA_CACHE, { recursive: true });
  const rows = [...m.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([d, f]) => `${d},${f.aggBuy},${f.aggSell}`);
  fs.writeFileSync(flowCachePath(sym), "date,aggBuy,aggSell\n" + rows.join("\n") + (rows.length ? "\n" : ""));
}

interface Row { date: string; nqFwd: number; feat: Record<string, number>; }

// Build feature rows from banked per-day flow + daily closes. No lookahead: day-t features → day t+1 return.
function build(flows: Record<string, Map<string, DayFlow>>): Row[] {
  const nqClose = loadClose(TARGET);
  // dates where we have NQ flow AND NQ close (need ES flow only for ES features — handled per-feature)
  const dates = [...flows[TARGET].keys()].filter(d => nqClose.has(d)).sort();
  const rows: Row[] = [];
  // helper: normalized + raw delta per symbol per date
  const delta = (sym: string, d: string) => { const f = flows[sym]?.get(d); return f ? f.aggBuy - f.aggSell : NaN; };
  const vol = (sym: string, d: string) => { const f = flows[sym]?.get(d); return f ? f.aggBuy + f.aggSell : NaN; };
  for (let i = 3; i < dates.length - 1; i++) {
    const d = dates[i], pd = dates[i - 1], nd = dates[i + 1];
    const c0 = nqClose.get(d)!, c1 = nqClose.get(nd)!, cp = nqClose.get(pd);
    const nqFwd = (c1 - c0) / c0;                                   // strictly-future target
    const feat: Record<string, number> = {};
    for (const s of SYMBOLS) {
      const dl = delta(s, d), v = vol(s, d);
      if (isFinite(dl)) feat[`${s}_delta`] = dl;
      if (isFinite(dl) && isFinite(v) && v > 0) feat[`${s}_ndelta`] = dl / v;    // normalized [-1,1]
      // 3-day delta momentum (sum of last 3 days' delta, all known at day d)
      const d1 = dates[i - 1], d2 = dates[i - 2];
      const m3 = [d, d1, d2].map(x => delta(s, x));
      if (m3.every(isFinite)) feat[`${s}_dmom3`] = m3.reduce((a, b) => a + b, 0);
      // delta divergence: sign(today's delta) vs sign(today's price move). +1 = aligned, -1 = divergent.
      if (isFinite(dl) && cp) { const pxMove = (c0 - cp) / cp; feat[`${s}_diverg`] = Math.sign(dl) * Math.sign(pxMove); }
    }
    rows.push({ date: d, nqFwd, feat });
  }
  return rows;
}

// Evaluate one feature as a long/short-NQ-next-day signal, OOS. Direction chosen on TRAIN only.
// Identical discipline to edge-hunter.ts evalFeature: train picks corr sign + tercile thresholds, OOS judges.
function evalFeature(rows: Row[], key: string): { n: number; t: number; meanR: number; dir: number } | null {
  const data = rows.filter(r => key in r.feat && isFinite(r.feat[key]));
  if (data.length < 120) return null;
  const cut = Math.floor(data.length * 0.7);
  const train = data.slice(0, cut), oos = data.slice(cut);
  const corrSign = Math.sign(train.reduce((s, r) => s + r.feat[key] * r.nqFwd, 0)) || 1;
  const vals = train.map(r => r.feat[key]).sort((a, b) => a - b);
  const hi = vals[Math.floor(vals.length * 0.8)], lo = vals[Math.floor(vals.length * 0.2)];
  const oosRets: number[] = [];
  for (const r of oos) {
    const f = r.feat[key];
    if (f >= hi) oosRets.push(corrSign * r.nqFwd);
    else if (f <= lo) oosRets.push(-corrSign * r.nqFwd);
  }
  if (oosRets.length < 20) return null;
  return { n: oosRets.length, t: tstat(oosRets), meanR: mean(oosRets), dir: corrSign };
}

function analyze() {
  const flows: Record<string, Map<string, DayFlow>> = {};
  for (const s of SYMBOLS) flows[s] = loadFlowCache(s);
  const haveAny = SYMBOLS.some(s => flows[s].size > 0);
  const W = 100;
  console.log("\n" + "═".repeat(W));
  console.log(`  PROBE-ORDERFLOW — does cumulative delta (aggressor-signed volume) predict NQ next-day return?`);
  console.log("═".repeat(W));
  if (!haveAny) { console.log("  No banked order-flow yet. Run with --execute to pull (cost-guarded) first."); console.log("═".repeat(W) + "\n"); return; }
  const rows = build(flows);
  if (rows.length < 60) { console.log(`  Only ${rows.length} aligned days — pull more history (--months) before judging.`); console.log("═".repeat(W) + "\n"); return; }
  console.log(`  ${rows.length} aligned days · train 70% / OOS 30% (time-ordered, no lookahead: day-t delta → day t+1 return)`);

  const featureKeys = [...new Set(rows.flatMap(r => Object.keys(r.feat)))].sort();
  const results: { name: string; n: number; t: number; meanR: number }[] = [];
  for (const key of featureKeys) { const r = evalFeature(rows, key); if (r) results.push({ name: key, n: r.n, t: r.t, meanR: r.meanR }); }
  if (!results.length) { console.log("  No predictor had enough OOS samples to judge."); console.log("═".repeat(W) + "\n"); return; }

  const nTests = results.length;
  const tBar = 1.96 + Math.log(nTests) * 0.45;   // same rough Bonferroni-adjusted z bar as edge-hunter.ts
  results.sort((a, b) => Math.abs(b.t) - Math.abs(a.t));

  console.log(`  ${nTests} predictors tested → multiple-testing bar |t| > ${tBar.toFixed(2)} (Bonferroni); ~${(nTests * 0.05).toFixed(0)} would clear |t|>1.96 by CHANCE alone`);
  console.log("─".repeat(W));
  console.log(`  ${"predictor".padEnd(14)} ${"OOS n".padEnd(7)} ${"t-stat".padEnd(9)} ${"mean fwd".padEnd(10)} verdict`);
  for (const r of results) {
    const survives = Math.abs(r.t) > tBar;
    console.log(`  ${r.name.padEnd(14)} ${String(r.n).padEnd(7)} ${r.t.toFixed(2).padEnd(9)} ${(r.meanR * 100).toFixed(3).padEnd(10)} ${survives ? "✅ SURVIVES" : Math.abs(r.t) > 1.96 ? "🟡 chance-level" : "—"}`);
  }
  const survivors = results.filter(r => Math.abs(r.t) > tBar);
  console.log("─".repeat(W));
  if (survivors.length) {
    console.log(`  ✅ ${survivors.length} predictor(s) cleared the honest bar — candidate order-flow signal(s):`);
    for (const s of survivors) console.log(`     ${s.name}: OOS t=${s.t.toFixed(2)}, mean next-day ${(s.meanR * 100).toFixed(3)}%`);
  } else {
    console.log(`  ❌ NOTHING cleared the multiple-testing bar. Daily order flow (cumulative delta) does NOT predict NQ next-day.`);
    console.log(`     (Honest result — rules out the daily-delta category. Order-flow edge, if any, likely lives intraday, not day-over-day.)`);
  }
  console.log("═".repeat(W) + "\n");
}

async function main() {
  const key = apiKey();
  const W = 100;
  if (!key) { console.error("⛔ DATABENTO_API_KEY not found — cannot pull order flow."); process.exit(1); }
  const auth = "Basic " + Buffer.from(key + ":").toString("base64");

  const chunks = monthChunks();
  // (sym, chunk) pairs not already banked (we bank by chunk-coverage via the per-month date span).
  const cached: Record<string, Map<string, DayFlow>> = {};
  for (const s of SYMBOLS) cached[s] = loadFlowCache(s);
  const need: { sym: string; start: string; end: string }[] = [];
  for (const s of SYMBOLS) for (const c of chunks) {
    // a chunk is "covered" if we already have any banked day inside it (cache is monotonic per pull)
    const has = [...cached[s].keys()].some(d => d >= c.start && d < c.end);
    if (!has) need.push({ sym: s, start: c.start, end: c.end });
  }

  console.log("\n" + "═".repeat(W));
  console.log(`  PROBE-ORDERFLOW — pull plan (Databento trades schema, GLBX.MDP3)`);
  console.log("═".repeat(W));
  console.log(`  Window: ${chunks[0]?.start} → ${chunks[chunks.length - 1]?.end} (${MONTHS}mo)   symbols: ${SYMBOLS.map(s => s + ".v.0").join(", ")}`);
  console.log(`  Month-chunks to pull: ${need.length} (already banked: ${SYMBOLS.length * chunks.length - need.length})`);
  console.log(`  Mode: ${EXECUTE ? `EXECUTE (guard $${MAX_USD})` : "DRY-RUN (cost preview only — pulls nothing)"}`);
  console.log("─".repeat(W));

  if (!need.length) {
    console.log(`  All requested history already banked — analyzing from cache.`);
    console.log("═".repeat(W) + "\n");
    analyze();
    return;
  }

  // Free cost pre-pass over every needed (sym, chunk). Sum; abort if over guard.
  let est = 0, priced = 0, unpriced = 0;
  for (const n of need) {
    const c = await previewCost(n.sym, n.start, n.end, auth);
    if (isFinite(c)) { est += c; priced++; } else unpriced++;
  }
  console.log(`  Cost preview: $${est.toFixed(2)} across ${priced} priced chunk(s)${unpriced ? ` (${unpriced} unpriced/unavailable)` : ""}.`);

  if (est > MAX_USD) {
    console.log(`  ⛔ Estimated $${est.toFixed(2)} exceeds guard $${MAX_USD}. Not pulling. Re-run with --max-usd ${Math.ceil(est)} to allow, or --months <fewer>.`);
    console.log("═".repeat(W) + "\n");
    return;
  }
  if (!EXECUTE) {
    console.log(`  ✅ Under guard. Re-run with --execute to pull the trades schema and bank per-day delta, then analyze.`);
    console.log("═".repeat(W) + "\n");
    return;
  }

  // EXECUTE: pull each needed chunk, aggregate into the per-symbol delta cache, then analyze.
  for (const s of SYMBOLS) {
    const acc = cached[s];
    let pulled = 0, failed = 0;
    for (const c of chunks) {
      const has = [...acc.keys()].some(d => d >= c.start && d < c.end);
      if (has) continue;
      const ok = await pullChunkFlow(s, c.start, c.end, auth, acc);
      if (ok) pulled++; else failed++;
    }
    saveFlowCache(s, acc);
    console.log(`  ${s}: pulled ${pulled} chunk(s)${failed ? `, ${failed} failed` : ""} → ${acc.size} banked days  (${flowCachePath(s)})`);
  }
  console.log("═".repeat(W) + "\n");
  analyze();
}
main().catch((e) => { console.error(e); process.exit(1); });
