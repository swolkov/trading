// Every ETH all-time high on Kraken, and how long the gaps between them were.
//
// DATA: Kraken's own ETH/USD weekly candles (interval=10080) — 577 of them, running from
// 2015-08-06 (the day Kraken listed ETH) to now. Kraken caps OHLC at 720 candles per interval and
// its `since` parameter does NOT page further back, so daily bars only reach ~2 years. Weekly is
// therefore the only full-history source on this venue, and every ATH date below is precise to the
// WEEK IT STARTED, not the exact day.
//
// "Major ATH" = the peak of a distinct run. A bull leg sets dozens of consecutive weekly ATHs; those
// are grouped into one cycle, and a cycle is closed once GAP_WEEKS pass with no new high.
//
// Run: npx tsx scripts/eth-ath-history.ts

const GAP_WEEKS = 8; // weeks without a new high before we call a run finished

type Bar = { t: number; h: number; c: number };

function fmt(ts: number) { return new Date(ts * 1000).toISOString().slice(0, 10); }
function usd(x: number) { return "$" + x.toLocaleString("en-US", { maximumFractionDigits: 2 }); }
function dur(days: number) {
  const y = Math.floor(days / 365.25);
  const m = Math.round((days - y * 365.25) / 30.44);
  if (y === 0) return `${Math.round(days)} days (${m} months)`;
  return `${y}y ${m}m  (${Math.round(days).toLocaleString()} days)`;
}

async function main() {
  const r = await (await fetch("https://api.kraken.com/0/public/OHLC?pair=ETHUSD&interval=10080")).json();
  if (r.error?.length) throw new Error(r.error.join(", "));
  const raw = Object.entries(r.result).find(([k]) => k !== "last")![1] as unknown[][];
  const bars: Bar[] = raw.map((x) => ({ t: Number(x[0]), h: parseFloat(x[2] as string), c: parseFloat(x[4] as string) }));

  console.log("=".repeat(96));
  console.log("ETHEREUM ALL-TIME HIGHS ON KRAKEN");
  console.log("=".repeat(96));
  console.log(`Source: Kraken ETH/USD weekly candles. ${bars.length} weeks, ${fmt(bars[0].t)} → ${fmt(bars[bars.length - 1].t)}.`);
  console.log("Kraken listed ETH on 2015-08-06, so this is the complete history on this exchange.");
  console.log("Dates are the START of the week in which the high printed.\n");

  // every week that set a new all-time high
  let peak = 0;
  const athWeeks: Bar[] = [];
  for (const b of bars) {
    if (b.h > peak) { peak = b.h; athWeeks.push(b); }
  }

  // group consecutive ATH weeks into runs
  type Cycle = { start: Bar; peakBar: Bar; peak: number; weeks: number };
  const cycles: Cycle[] = [];
  let cur: Cycle | null = null;
  for (const b of athWeeks) {
    if (cur && (b.t - cur.peakBar.t) / 604800 <= GAP_WEEKS) {
      cur.peakBar = b; cur.peak = b.h; cur.weeks++;
    } else {
      if (cur) cycles.push(cur);
      cur = { start: b, peakBar: b, peak: b.h, weeks: 1 };
    }
  }
  if (cur) cycles.push(cur);

  console.log(`${cycles.length} distinct all-time-high runs (a run ends after ${GAP_WEEKS} weeks with no new high):\n`);
  console.log("  #  | run began  | PEAK week  | peak price   | weeks setting highs | gap since previous peak");
  console.log("  " + "-".repeat(92));
  for (let i = 0; i < cycles.length; i++) {
    const c = cycles[i];
    const gap = i === 0 ? "—  (listing)" : dur((c.start.t - cycles[i - 1].peakBar.t) / 86400);
    console.log(
      `  ${String(i + 1).padStart(2)} | ${fmt(c.start.t)} | ${fmt(c.peakBar.t)} | ${usd(c.peak).padStart(12)} | ${String(c.weeks).padStart(19)} | ${gap}`
    );
  }

  console.log("\n" + "=".repeat(96));
  console.log("TIME BETWEEN ALL-TIME HIGHS — peak to the next time that peak was BEATEN");
  console.log("=".repeat(96));
  for (let i = 1; i < cycles.length; i++) {
    const prev = cycles[i - 1], next = cycles[i];
    const days = (next.start.t - prev.peakBar.t) / 86400;
    // how deep did it fall in between?
    const between = bars.filter((b) => b.t > prev.peakBar.t && b.t < next.start.t);
    const trough = between.length ? Math.min(...between.map((b) => b.c)) : prev.peak;
    console.log(
      `  ${fmt(prev.peakBar.t)} ${usd(prev.peak)} → ${fmt(next.start.t)}: ${dur(days)}`
    );
    console.log(`      bottomed around ${usd(trough)} in between = ${(((trough - prev.peak) / prev.peak) * 100).toFixed(1)}% off the high\n`);
  }

  // the current drought
  const last = cycles[cycles.length - 1];
  const now = bars[bars.length - 1];
  const daysSince = (now.t - last.peakBar.t) / 86400;
  const off = ((now.c - last.peak) / last.peak) * 100;
  console.log("=".repeat(96));
  console.log("WHERE IT STANDS NOW");
  console.log("=".repeat(96));
  console.log(`  All-time high : ${usd(last.peak)}, week of ${fmt(last.peakBar.t)}`);
  console.log(`  Latest close  : ${usd(now.c)}  (${off.toFixed(1)}% below the high)`);
  console.log(`  Time since ATH: ${dur(daysSince)} and counting`);
  const gaps = cycles.slice(1).map((c, i) => (c.start.t - cycles[i].peakBar.t) / 86400);
  if (gaps.length) {
    const longest = Math.max(...gaps);
    console.log(`  Longest previous gap between highs: ${dur(longest)}`);
    console.log(`  Current drought is ${(daysSince / longest).toFixed(2)}x the longest one ETH has ever recovered from.`);
    console.log(`  To make a new high it must rise ${(((last.peak / now.c) - 1) * 100).toFixed(0)}% from here.`);
  }
}

main();
