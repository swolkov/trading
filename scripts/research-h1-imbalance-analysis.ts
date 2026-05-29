/**
 * H1 — Opening Auction Imbalance Persistence (FULL ANALYSIS)
 *
 * Hypothesis (pre-registered in EDGE-HIERARCHY.md):
 *   "Large opening-auction imbalance predicts first 5-30 min drift in the same direction."
 *
 * Methodology:
 *   1. Pull Databento `statistics` schema for ES over last 90 days (3 pulls × 30d to cover sample)
 *   2. Extract stat_type 2 records (Indicative Opening Price = IOP, the auction signal)
 *   3. Extract stat_type 1 records (Opening Price = where the open actually trades)
 *   4. For each day's RTH open (9:30am ET):
 *        - find IOP just before open
 *        - find OP just after open
 *        - imbalance_signal = sign(IOP - prev_close)  [positive = buy imbalance]
 *        - drift_5m  = sign(close_after_5min - OP)
 *        - drift_15m = sign(close_after_15min - OP)
 *        - drift_30m = sign(close_after_30min - OP)
 *   5. Tally: % match between imbalance_signal and drift at each timeframe.
 *   6. Statistical significance: binomial test vs 50% baseline.
 *
 * Decision rule:
 *   - >55% match with n>60 → potential edge, add to EDGE-HIERARCHY Tier 3
 *   - >60% match with n>60 → potential edge, add to Tier 2
 *   - <55% match → reject hypothesis
 *
 * Run: npx tsx scripts/research-h1-imbalance-analysis.ts
 */
import fs from "node:fs";

function apiKey(): string {
  if (process.env.DATABENTO_API_KEY) return process.env.DATABENTO_API_KEY;
  const env = fs.readFileSync(new URL("../.env.local", import.meta.url), "utf8");
  const m = env.match(/^DATABENTO_API_KEY=(.+)$/m);
  if (!m) throw new Error("DATABENTO_API_KEY not found in env or .env.local");
  return m[1].trim();
}

interface StatRec { tsEvent: number; statType: number; price: number; }

async function fetchStatsWindow(symbol: string, startISO: string, endISO: string): Promise<StatRec[]> {
  const KEY = apiKey();
  const auth = "Basic " + Buffer.from(KEY + ":").toString("base64");
  const body = new URLSearchParams({
    dataset: "GLBX.MDP3", symbols: symbol, stype_in: "continuous", schema: "statistics",
    start: startISO, end: endISO, encoding: "csv", pretty_px: "true", pretty_ts: "true",
  });
  const res = await fetch("https://hist.databento.com/v0/timeseries.get_range", {
    method: "POST",
    headers: { Authorization: auth, "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!res.ok) throw new Error(`Databento ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const csv = await res.text();
  const rows = csv.trim().split("\n");
  if (rows.length < 2) return [];
  const header = rows[0].split(",");
  const tsIdx = header.indexOf("ts_event");
  const typeIdx = header.indexOf("stat_type");
  const priceIdx = header.indexOf("price");
  const out: StatRec[] = [];
  for (const r of rows.slice(1)) {
    const c = r.split(",");
    const tsEvent = new Date(c[tsIdx]).getTime();
    const statType = parseInt(c[typeIdx], 10);
    const price = parseFloat(c[priceIdx]);
    if (!isNaN(tsEvent) && !isNaN(statType) && !isNaN(price)) out.push({ tsEvent, statType, price });
  }
  return out;
}

interface MinBar { ts: number; o: number; h: number; l: number; c: number; }

function loadES1m(): MinBar[] {
  const path = new URL("../data/ES_1m.csv", import.meta.url);
  if (!fs.existsSync(path)) throw new Error("data/ES_1m.csv not found — run scripts/dbn-fetch.ts first");
  const rows = fs.readFileSync(path, "utf8").trim().split("\n").slice(1);
  const out: MinBar[] = [];
  for (const r of rows) {
    const c = r.split(",");
    out.push({ ts: new Date(c[0]).getTime(), o: +c[4], h: +c[5], l: +c[6], c: +c[7] });
  }
  return out.sort((a, b) => a.ts - b.ts);
}

function etHour(d: Date): { h: number; dow: string; dateStr: string } {
  const s = d.toLocaleString("en-US", { timeZone: "America/New_York", hour12: false, weekday: "short", hour: "2-digit", minute: "2-digit", year: "numeric", month: "2-digit", day: "2-digit" });
  const dow = s.slice(0, 3);
  const hm = s.match(/(\d{2}):(\d{2})/);
  const h = hm ? +hm[1] + +hm[2] / 60 : 0;
  const dateStr = d.toLocaleDateString("en-CA", { timeZone: "America/New_York" });
  return { h, dow, dateStr };
}

interface OpenEvent { date: string; settlementPrev: number; iop: number; openPrice: number; openTs: number; imbalance: number; }

function buildOpenEvents(stats: StatRec[]): OpenEvent[] {
  // Group by ET calendar date
  const byDate = new Map<string, StatRec[]>();
  for (const r of stats) {
    const d = etHour(new Date(r.tsEvent));
    if (!byDate.has(d.dateStr)) byDate.set(d.dateStr, []);
    byDate.get(d.dateStr)!.push(r);
  }
  const sortedDates = [...byDate.keys()].sort();
  const events: OpenEvent[] = [];
  for (let i = 1; i < sortedDates.length; i++) {
    const dateStr = sortedDates[i];
    const prevDateStr = sortedDates[i - 1];
    const todayRecs = byDate.get(dateStr)!;
    const prevRecs = byDate.get(prevDateStr)!;
    // Prior settlement = stat_type 3 from previous trading day, take latest
    const prevSettles = prevRecs.filter((r) => r.statType === 3).sort((a, b) => b.tsEvent - a.tsEvent);
    if (!prevSettles.length) continue;
    const settlementPrev = prevSettles[0].price;
    // Today's RTH open is ~9:30am ET. Find latest IOP just before open (within 30 min before).
    // Find first Opening Price (stat_type 1) of the day after 9:30 ET.
    const todayOps = todayRecs
      .filter((r) => r.statType === 1)
      .filter((r) => etHour(new Date(r.tsEvent)).h >= 9.5)
      .sort((a, b) => a.tsEvent - b.tsEvent);
    if (!todayOps.length) continue;
    const op = todayOps[0];
    // IOP within 30 min BEFORE the open price record
    const iopCandidates = todayRecs
      .filter((r) => r.statType === 2)
      .filter((r) => r.tsEvent < op.tsEvent && r.tsEvent > op.tsEvent - 30 * 60_000)
      .sort((a, b) => b.tsEvent - a.tsEvent);
    if (!iopCandidates.length) continue;
    const iop = iopCandidates[0].price;
    events.push({
      date: dateStr,
      settlementPrev,
      iop,
      openPrice: op.price,
      openTs: op.tsEvent,
      imbalance: iop - settlementPrev,
    });
  }
  return events;
}

function priceAt(bars: MinBar[], targetTs: number): number | null {
  // Binary-search for the bar whose start ts is just <= targetTs
  let lo = 0, hi = bars.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (bars[mid].ts <= targetTs) lo = mid; else hi = mid - 1;
  }
  return bars[lo]?.c ?? null;
}

interface DriftMatch { match5: boolean | null; match15: boolean | null; match30: boolean | null; imbalance: number; drift30: number; }

function computeDrifts(events: OpenEvent[], bars: MinBar[]): DriftMatch[] {
  const out: DriftMatch[] = [];
  for (const e of events) {
    const sigImb = Math.sign(e.imbalance);
    if (sigImb === 0) continue;
    const p0 = priceAt(bars, e.openTs);
    const p5 = priceAt(bars, e.openTs + 5 * 60_000);
    const p15 = priceAt(bars, e.openTs + 15 * 60_000);
    const p30 = priceAt(bars, e.openTs + 30 * 60_000);
    if (p0 === null) continue;
    const m5 = p5 !== null ? Math.sign(p5 - p0) === sigImb : null;
    const m15 = p15 !== null ? Math.sign(p15 - p0) === sigImb : null;
    const m30 = p30 !== null ? Math.sign(p30 - p0) === sigImb : null;
    const drift30 = p30 !== null ? (p30 - p0) / p0 : 0;
    out.push({ match5: m5, match15: m15, match30: m30, imbalance: e.imbalance, drift30 });
  }
  return out;
}

function rate(arr: (boolean | null)[]): { n: number; rate: number } {
  const cleaned = arr.filter((v): v is boolean => v !== null);
  if (cleaned.length === 0) return { n: 0, rate: 0 };
  return { n: cleaned.length, rate: cleaned.filter((v) => v).length / cleaned.length };
}

// Simple two-sided binomial Z approximation vs 50% baseline
function zScoreVsHalf(matches: number, n: number): number {
  if (n < 10) return 0;
  const p = matches / n;
  const se = Math.sqrt(0.25 / n);
  return (p - 0.5) / se;
}

async function main() {
  console.log("\n" + "═".repeat(94));
  console.log("  H1 — Opening Auction Imbalance Persistence: FULL ANALYSIS");
  console.log("═".repeat(94));

  // Pull last ~90 days of statistics in 30-day chunks (Databento end-of-window is 4 days lag)
  const end = new Date(Date.now() - 4 * 86_400_000);
  const allStats: StatRec[] = [];
  for (let i = 0; i < 3; i++) {
    const windowEnd = new Date(end.getTime() - i * 30 * 86_400_000);
    const windowStart = new Date(windowEnd.getTime() - 30 * 86_400_000);
    try {
      const s = await fetchStatsWindow("ES.v.0", windowStart.toISOString().slice(0, 19), windowEnd.toISOString().slice(0, 19));
      console.log(`  pulled ${s.length.toLocaleString()} statistics records ${windowStart.toISOString().slice(0, 10)} → ${windowEnd.toISOString().slice(0, 10)}`);
      allStats.push(...s);
    } catch (e) {
      console.log(`  pull error: ${e instanceof Error ? e.message : e}`);
    }
  }
  console.log(`  TOTAL: ${allStats.length.toLocaleString()} records`);

  const events = buildOpenEvents(allStats);
  console.log(`\nOpening events with both IOP + open price: ${events.length}`);

  if (events.length < 10) {
    console.log("\n⚠️  Insufficient events for meaningful analysis. Possible reasons:");
    console.log("   - GLBX.MDP3 may not consistently publish IOP just before open");
    console.log("   - stat_type field encoding may differ from Databento docs");
    console.log("   - Sample window too small. Try fetching more days.");
    return;
  }

  // Show distribution of imbalances
  const imbalances = events.map((e) => e.imbalance);
  imbalances.sort((a, b) => a - b);
  const median = imbalances[Math.floor(imbalances.length / 2)];
  const p25 = imbalances[Math.floor(imbalances.length * 0.25)];
  const p75 = imbalances[Math.floor(imbalances.length * 0.75)];
  console.log(`Imbalance distribution: 25th ${p25.toFixed(2)} | median ${median.toFixed(2)} | 75th ${p75.toFixed(2)}`);

  // Load ES 1m bars and compute drifts
  const bars = loadES1m();
  console.log(`Loaded ${bars.length.toLocaleString()} ES 1m bars from local cache.`);
  const drifts = computeDrifts(events, bars);
  console.log(`\nComputed drift outcomes for ${drifts.length} events.\n`);

  // Overall rate analysis
  console.log("OVERALL — all events:");
  for (const tf of ["5", "15", "30"] as const) {
    const key = `match${tf}` as keyof DriftMatch;
    const arr = drifts.map((d) => d[key]) as (boolean | null)[];
    const r = rate(arr);
    const m = Math.round(r.rate * r.n);
    const z = zScoreVsHalf(m, r.n);
    const verdict = Math.abs(z) > 2 ? (z > 0 ? "✅ SIGNIFICANT (p<0.05)" : "❌ inverse / random") : "noise";
    console.log(`  ${tf.padStart(2)}min drift-match-rate: ${(r.rate * 100).toFixed(1)}% (${m}/${r.n}) | z=${z.toFixed(2)} ${verdict}`);
  }

  // Filtered: large imbalances only (above 75th percentile in absolute value)
  console.log("\nFILTERED — large imbalances only (|imbalance| > 75th percentile):");
  const absThreshold = Math.max(Math.abs(p25), Math.abs(p75));
  const largeDrifts = drifts.filter((d) => Math.abs(d.imbalance) >= absThreshold);
  console.log(`  ${largeDrifts.length} events qualified.`);
  for (const tf of ["5", "15", "30"] as const) {
    const key = `match${tf}` as keyof DriftMatch;
    const arr = largeDrifts.map((d) => d[key]) as (boolean | null)[];
    const r = rate(arr);
    const m = Math.round(r.rate * r.n);
    const z = zScoreVsHalf(m, r.n);
    const verdict = Math.abs(z) > 2 ? (z > 0 ? "✅ SIGNIFICANT" : "❌ inverse") : "noise";
    console.log(`  ${tf.padStart(2)}min: ${(r.rate * 100).toFixed(1)}% (${m}/${r.n}) | z=${z.toFixed(2)} ${verdict}`);
  }

  console.log("\n" + "─".repeat(94));
  console.log("DECISION:");
  const m30 = rate(drifts.map((d) => d.match30));
  const m30Largeacc = rate(largeDrifts.map((d) => d.match30));
  const bestRate = Math.max(m30.rate, m30Largeacc.rate);
  if (bestRate >= 0.60 && m30.n >= 60) {
    console.log("  ✅ H1 PROMOTE TO TIER 2 — drift-match-rate ≥ 60% with n ≥ 60.");
    console.log("     Add to EDGE-HIERARCHY.md as a plausible-unvalidated edge.");
  } else if (bestRate >= 0.55 && m30.n >= 60) {
    console.log("  🟡 H1 = TIER 3 candidate — drift-match-rate 55-60%. Worth larger sample.");
  } else if (m30.n < 30) {
    console.log("  ⏸  Insufficient data — pull more days to make a call.");
  } else {
    console.log("  ❌ H1 REJECTED — drift-match-rate < 55% (essentially random).");
    console.log("     Move to EDGE-HIERARCHY Rejected pile. Don't burn more cycles on this.");
  }
  console.log("═".repeat(94) + "\n");
}
main().catch((e) => { console.error(e); process.exit(1); });
