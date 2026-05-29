/**
 * H2, H4, H5 microstructure hypothesis tests using data we already have on the
 * current Databento plan (1m OHLCV + statistics schema).
 *
 *   H2 — Post-liquidation exhaustion reversal:
 *        After a high-volume directional flush, does price mean-revert?
 *
 *   H3 — Liquidity-vacuum continuation:
 *        SKIPPED — requires MBP-10 depth time series (not in our current plan).
 *
 *   H4 — Failed-auction continuation:
 *        When the actual open price deviates significantly from the IOP
 *        (the auction failed to clear cleanly), does first 30min continue
 *        in the deviation direction or revert?
 *
 *   H5 — Post-news/shock overreaction → reversion:
 *        After an extreme 5m bar (|return| > 3σ AND elevated volume),
 *        does subsequent price action partially retrace?
 *
 * Decision rule per hypothesis: a real edge needs >55% directional match with
 * n >= 50, and statistical significance (|z| > 2 vs 50% null).
 *
 * Run: npx tsx scripts/research-h2-h4-h5-analysis.ts
 */
import fs from "node:fs";

function apiKey(): string {
  if (process.env.DATABENTO_API_KEY) return process.env.DATABENTO_API_KEY;
  const env = fs.readFileSync(new URL("../.env.local", import.meta.url), "utf8");
  const m = env.match(/^DATABENTO_API_KEY=(.+)$/m);
  if (!m) throw new Error("DATABENTO_API_KEY not found");
  return m[1].trim();
}

interface Bar1m { ts: number; o: number; h: number; l: number; c: number; v: number; }
interface Bar5m extends Bar1m { /* same shape, ts is start of 5m window */ }

function load1m(sym: string): Bar1m[] {
  const path = new URL(`../data/${sym}_1m.csv`, import.meta.url);
  const rows = fs.readFileSync(path, "utf8").trim().split("\n").slice(1);
  const out: Bar1m[] = [];
  for (const r of rows) {
    const c = r.split(",");
    out.push({ ts: new Date(c[0]).getTime(), o: +c[4], h: +c[5], l: +c[6], c: +c[7], v: +c[8] });
  }
  return out.sort((a, b) => a.ts - b.ts);
}

function aggregate5m(m1: Bar1m[]): Bar5m[] {
  const buckets = new Map<number, Bar5m>();
  for (const b of m1) {
    const key = Math.floor(b.ts / 300_000) * 300_000;
    const ex = buckets.get(key);
    if (!ex) buckets.set(key, { ts: key, o: b.o, h: b.h, l: b.l, c: b.c, v: b.v });
    else { ex.h = Math.max(ex.h, b.h); ex.l = Math.min(ex.l, b.l); ex.c = b.c; ex.v += b.v; }
  }
  return [...buckets.values()].sort((a, b) => a.ts - b.ts);
}

function atr(bars: Bar1m[], period: number, atIdx: number): number {
  if (atIdx < period) return 0;
  let s = 0;
  for (let i = atIdx - period + 1; i <= atIdx; i++) {
    const tr = i === 0 ? bars[i].h - bars[i].l : Math.max(bars[i].h - bars[i].l, Math.abs(bars[i].h - bars[i - 1].c), Math.abs(bars[i].l - bars[i - 1].c));
    s += tr;
  }
  return s / period;
}

function priceAt(bars: Bar1m[], ts: number): number | null {
  let lo = 0, hi = bars.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (bars[mid].ts <= ts) lo = mid; else hi = mid - 1;
  }
  return bars[lo]?.c ?? null;
}

function zVs50(matches: number, n: number): number {
  if (n < 10) return 0;
  const p = matches / n;
  const se = Math.sqrt(0.25 / n);
  return (p - 0.5) / se;
}
function verdictLabel(z: number, n: number): string {
  if (n < 50) return `n=${n} too small`;
  if (z > 2) return "✅ SIGNIFICANT positive";
  if (z < -2) return "❌ SIGNIFICANT inverse";
  return "noise";
}

// ===================== H2 — Post-liquidation reversal =====================
function testH2(sym: string, m5: Bar5m[]): { n: number; r15: number; r30: number; r60: number; n15: number; n30: number; n60: number } {
  const VOL_MULT = 3.0; // bar volume must be >= 3× 20-bar avg
  const ATR_MULT = 2.0; // |body| must be >= 2× ATR(20)
  const events: { ts: number; entry: number; dir: number }[] = [];
  for (let i = 30; i < m5.length - 12; i++) {
    const recent = m5.slice(i - 20, i);
    const avgVol = recent.reduce((s, b) => s + b.v, 0) / 20;
    if (avgVol <= 0) continue;
    const a = atr(m5, 20, i - 1);
    if (a <= 0) continue;
    const body = m5[i].c - m5[i].o;
    if (m5[i].v < avgVol * VOL_MULT) continue;
    if (Math.abs(body) < a * ATR_MULT) continue;
    // Liquidation candidate. Direction = sign of body.
    events.push({ ts: m5[i].ts, entry: m5[i].c, dir: Math.sign(body) });
  }
  // For each, check 15/30/60 min later for REVERSAL (opposite sign drift)
  const checkAt = (mins: number) => {
    let matches = 0, total = 0;
    for (const e of events) {
      const p = priceAt(m5, e.ts + mins * 60_000);
      if (p === null) continue;
      total++;
      const drift = p - e.entry;
      if (Math.sign(drift) === -e.dir) matches++; // opposite of liquidation direction
    }
    return { matches, total };
  };
  const r15 = checkAt(15), r30 = checkAt(30), r60 = checkAt(60);
  return {
    n: events.length,
    n15: r15.total, r15: r15.total ? r15.matches / r15.total : 0,
    n30: r30.total, r30: r30.total ? r30.matches / r30.total : 0,
    n60: r60.total, r60: r60.total ? r60.matches / r60.total : 0,
  };
}

// ===================== H4 — Failed-auction continuation =====================
async function testH4(): Promise<{ n: number; r5: number; r15: number; r30: number; n5: number; n15: number; n30: number; threshold: number } | null> {
  const KEY = apiKey();
  const auth = "Basic " + Buffer.from(KEY + ":").toString("base64");
  // Reuse H1 methodology: pull statistics, extract IOP + open price pairs
  const end = new Date(Date.now() - 4 * 86_400_000);
  const start = new Date(end.getTime() - 90 * 86_400_000);
  console.log("  Fetching statistics (this may take ~10s)...");
  const body = new URLSearchParams({
    dataset: "GLBX.MDP3", symbols: "ES.v.0", stype_in: "continuous", schema: "statistics",
    start: start.toISOString().slice(0, 19), end: end.toISOString().slice(0, 19),
    encoding: "csv", pretty_px: "true", pretty_ts: "true",
  });
  const res = await fetch("https://hist.databento.com/v0/timeseries.get_range", {
    method: "POST", headers: { Authorization: auth, "Content-Type": "application/x-www-form-urlencoded" }, body,
  });
  if (!res.ok) {
    console.log(`  Databento ${res.status}: ${(await res.text()).slice(0, 200)}`);
    return null;
  }
  const csv = await res.text();
  const rows = csv.trim().split("\n");
  if (rows.length < 2) return null;
  const header = rows[0].split(",");
  const tsIdx = header.indexOf("ts_event");
  const typeIdx = header.indexOf("stat_type");
  const priceIdx = header.indexOf("price");

  // Group by ET date, find IOP-just-before-open + open price pairs
  const byDate = new Map<string, { ts: number; statType: number; price: number }[]>();
  for (const r of rows.slice(1)) {
    const c = r.split(",");
    const ts = new Date(c[tsIdx]).getTime();
    const sType = parseInt(c[typeIdx], 10);
    const price = parseFloat(c[priceIdx]);
    if (isNaN(ts) || isNaN(sType) || isNaN(price)) continue;
    const d = new Date(ts).toLocaleDateString("en-CA", { timeZone: "America/New_York" });
    if (!byDate.has(d)) byDate.set(d, []);
    byDate.get(d)!.push({ ts, statType: sType, price });
  }

  interface AuctionEvent { date: string; iop: number; open: number; deviationPct: number; openTs: number; }
  const events: AuctionEvent[] = [];
  for (const [date, recs] of byDate) {
    const opens = recs.filter((r) => r.statType === 1).sort((a, b) => a.ts - b.ts);
    if (!opens.length) continue;
    const op = opens[0];
    const iops = recs.filter((r) => r.statType === 2 && r.ts < op.ts && r.ts > op.ts - 30 * 60_000).sort((a, b) => b.ts - a.ts);
    if (!iops.length) continue;
    const iop = iops[0].price;
    const deviationPct = ((op.price - iop) / iop) * 100;
    events.push({ date, iop, open: op.price, deviationPct, openTs: op.ts });
  }
  console.log(`  ${events.length} auction events with IOP + open pairs`);
  if (events.length < 10) return null;

  // Threshold: "failed auction" = |deviation| > 0.05% (top tertile typically)
  const absDevs = events.map((e) => Math.abs(e.deviationPct)).sort((a, b) => a - b);
  const threshold = absDevs[Math.floor(absDevs.length * 0.66)] || 0.05;
  const failed = events.filter((e) => Math.abs(e.deviationPct) >= threshold);
  console.log(`  ${failed.length} "failed" auctions (deviation >= ${threshold.toFixed(3)}%)`);

  // Load ES 1m bars
  const m1 = load1m("ES");
  // For each failed auction: does first 5/15/30 min continue in deviation direction?
  const checkAt = (mins: number) => {
    let matches = 0, total = 0;
    for (const e of failed) {
      const p = priceAt(m1, e.openTs + mins * 60_000);
      if (p === null) continue;
      total++;
      const drift = p - e.open;
      if (Math.sign(drift) === Math.sign(e.deviationPct)) matches++;
    }
    return { matches, total };
  };
  const r5 = checkAt(5), r15 = checkAt(15), r30 = checkAt(30);
  return {
    n: failed.length, threshold,
    n5: r5.total, r5: r5.total ? r5.matches / r5.total : 0,
    n15: r15.total, r15: r15.total ? r15.matches / r15.total : 0,
    n30: r30.total, r30: r30.total ? r30.matches / r30.total : 0,
  };
}

// ===================== H5 — Post-news overreaction → reversion =====================
function testH5(sym: string, m5: Bar5m[]): { n: number; r15: number; r30: number; r60: number; n15: number; n30: number; n60: number; avgRetracePct: number } {
  // Find 5m bars with |return| > 3× rolling stddev of returns
  const returns: number[] = [];
  for (let i = 1; i < m5.length; i++) {
    returns.push((m5[i].c - m5[i - 1].c) / m5[i - 1].c);
  }

  const events: { idx: number; entry: number; dir: number }[] = [];
  for (let i = 50; i < m5.length - 12; i++) {
    const window = returns.slice(i - 50, i);
    const mean = window.reduce((s, x) => s + x, 0) / 50;
    const variance = window.reduce((s, x) => s + (x - mean) ** 2, 0) / 50;
    const std = Math.sqrt(variance);
    if (std === 0) continue;
    const z = (returns[i - 1] - mean) / std;
    if (Math.abs(z) < 3.0) continue;
    // Shock bar. dir = sign of the move
    events.push({ idx: i, entry: m5[i].c, dir: Math.sign(returns[i - 1]) });
  }

  const checkRetraceAt = (mins: number) => {
    let matches = 0, total = 0;
    const retracePcts: number[] = [];
    for (const e of events) {
      const target = e.idx + (mins / 5);
      if (target >= m5.length) continue;
      const futurePrice = m5[Math.floor(target)].c;
      total++;
      const drift = futurePrice - e.entry;
      // Retrace = drift sign is OPPOSITE to shock direction
      if (Math.sign(drift) === -e.dir) {
        matches++;
        // How much retrace? Take the shock-bar move size, then current drift size in opposite direction
        const shockMove = e.entry - m5[e.idx - 1].c;
        const retraceMove = e.entry - futurePrice;
        if (Math.abs(shockMove) > 0) retracePcts.push(Math.abs(retraceMove) / Math.abs(shockMove));
      }
    }
    const avgRetrace = retracePcts.length ? retracePcts.reduce((s, x) => s + x, 0) / retracePcts.length : 0;
    return { matches, total, avgRetrace };
  };
  const r15 = checkRetraceAt(15), r30 = checkRetraceAt(30), r60 = checkRetraceAt(60);
  return {
    n: events.length,
    n15: r15.total, r15: r15.total ? r15.matches / r15.total : 0,
    n30: r30.total, r30: r30.total ? r30.matches / r30.total : 0,
    n60: r60.total, r60: r60.total ? r60.matches / r60.total : 0,
    avgRetracePct: r30.avgRetrace * 100,
  };
}

// ===================== Main =====================
async function main() {
  console.log("\n" + "═".repeat(94));
  console.log("  H2/H4/H5 MICROSTRUCTURE HYPOTHESIS TESTS");
  console.log("═".repeat(94));

  // H2 across our 1m datasets — focus on ES, NQ, MBT
  console.log("\n── H2 — Post-liquidation exhaustion reversal (vol > 3× avg, body > 2× ATR) ──");
  for (const sym of ["ES", "NQ", "MBT"]) {
    try {
      const m1 = load1m(sym);
      const m5 = aggregate5m(m1);
      const r = testH2(sym, m5);
      const z15 = zVs50(Math.round(r.r15 * r.n15), r.n15);
      const z30 = zVs50(Math.round(r.r30 * r.n30), r.n30);
      const z60 = zVs50(Math.round(r.r60 * r.n60), r.n60);
      console.log(`  ${sym}: ${r.n} liquidation candidates`);
      console.log(`    15min reversal: ${(r.r15 * 100).toFixed(1)}% (${Math.round(r.r15 * r.n15)}/${r.n15}) z=${z15.toFixed(2)} — ${verdictLabel(z15, r.n15)}`);
      console.log(`    30min reversal: ${(r.r30 * 100).toFixed(1)}% (${Math.round(r.r30 * r.n30)}/${r.n30}) z=${z30.toFixed(2)} — ${verdictLabel(z30, r.n30)}`);
      console.log(`    60min reversal: ${(r.r60 * 100).toFixed(1)}% (${Math.round(r.r60 * r.n60)}/${r.n60}) z=${z60.toFixed(2)} — ${verdictLabel(z60, r.n60)}`);
    } catch (e) { console.log(`  ${sym} error: ${e instanceof Error ? e.message : e}`); }
  }

  console.log("\n── H3 — Liquidity-vacuum continuation ──");
  console.log("  SKIPPED — requires MBP-10 depth time series, not in current Databento plan.");
  console.log("  Could re-test if plan upgraded.");

  console.log("\n── H4 — Failed-auction continuation (ES) ──");
  try {
    const r = await testH4();
    if (r) {
      const z5 = zVs50(Math.round(r.r5 * r.n5), r.n5);
      const z15 = zVs50(Math.round(r.r15 * r.n15), r.n15);
      const z30 = zVs50(Math.round(r.r30 * r.n30), r.n30);
      console.log(`  ${r.n} failed-auction events (deviation threshold: ${r.threshold.toFixed(3)}%)`);
      console.log(`    5min continue: ${(r.r5 * 100).toFixed(1)}% (${Math.round(r.r5 * r.n5)}/${r.n5}) z=${z5.toFixed(2)} — ${verdictLabel(z5, r.n5)}`);
      console.log(`    15min continue: ${(r.r15 * 100).toFixed(1)}% (${Math.round(r.r15 * r.n15)}/${r.n15}) z=${z15.toFixed(2)} — ${verdictLabel(z15, r.n15)}`);
      console.log(`    30min continue: ${(r.r30 * 100).toFixed(1)}% (${Math.round(r.r30 * r.n30)}/${r.n30}) z=${z30.toFixed(2)} — ${verdictLabel(z30, r.n30)}`);
    } else {
      console.log("  Insufficient data or fetch failed.");
    }
  } catch (e) { console.log(`  H4 error: ${e instanceof Error ? e.message : e}`); }

  console.log("\n── H5 — Post-news overreaction → reversion (|return| > 3σ on 5m bars) ──");
  for (const sym of ["ES", "NQ", "MBT"]) {
    try {
      const m1 = load1m(sym);
      const m5 = aggregate5m(m1);
      const r = testH5(sym, m5);
      const z15 = zVs50(Math.round(r.r15 * r.n15), r.n15);
      const z30 = zVs50(Math.round(r.r30 * r.n30), r.n30);
      const z60 = zVs50(Math.round(r.r60 * r.n60), r.n60);
      console.log(`  ${sym}: ${r.n} shock events`);
      console.log(`    15min retrace: ${(r.r15 * 100).toFixed(1)}% (${Math.round(r.r15 * r.n15)}/${r.n15}) z=${z15.toFixed(2)} — ${verdictLabel(z15, r.n15)}`);
      console.log(`    30min retrace: ${(r.r30 * 100).toFixed(1)}% (${Math.round(r.r30 * r.n30)}/${r.n30}) z=${z30.toFixed(2)} — ${verdictLabel(z30, r.n30)}`);
      console.log(`    60min retrace: ${(r.r60 * 100).toFixed(1)}% (${Math.round(r.r60 * r.n60)}/${r.n60}) z=${z60.toFixed(2)} — ${verdictLabel(z60, r.n60)}`);
      console.log(`    Avg retracement magnitude (30min, when retracing): ${r.avgRetracePct.toFixed(1)}% of shock move`);
    } catch (e) { console.log(`  ${sym} error: ${e instanceof Error ? e.message : e}`); }
  }

  console.log("\n" + "═".repeat(94));
  console.log("  Decision rule: ≥55% directional match + n ≥ 50 + |z| > 2 = promote to EDGE-HIERARCHY Tier 3");
  console.log("                 ≥60% + same = Tier 2 plausible-unvalidated");
  console.log("                 Else = reject / noise");
  console.log("═".repeat(94) + "\n");
}
main().catch((e) => { console.error(e); process.exit(1); });
