/**
 * EDGE SCAN — crypto futures, PRE-REGISTERED hypotheses.
 *
 * To avoid data-mining noise, I'm testing only 7 specific hypotheses chosen for theoretical
 * justification BEFORE seeing results. Each must clear a hard bar:
 *   - PF >= 1.30 over full period
 *   - Positive in 3+ consecutive years
 *   - n >= 50 trades total (where applicable)
 *
 * Pre-registered hypotheses:
 *   H1. Weekend gap fade — Sunday 6pm CME open gap vs Friday 5pm close mean-reverts
 *   H2. Long-only daily momentum — buy strength on daily breakout with ATR trail
 *   H3. Asian session fade — fade overnight Asian move at US open
 *   H4. Time-of-day bias — specific hours show consistent direction
 *   H5. BFF Friday gamma — weekly expiry afternoon behavior
 *   H6. NR4 range expansion — narrow-range day → breakout next session
 *   H7. Buy & hold w/ trailing stop — pure long-term BTC bull market
 *
 * Run: npx tsx scripts/edge-scan-crypto-deep.ts
 */
import fs from "node:fs";

interface Bar { t: number; o: number; h: number; l: number; c: number; v: number; }

const MULT: Record<string, number> = { MBT: 0.10, MET: 0.10, BFF: 0.01 };
const TICK: Record<string, number> = { MBT: 5, MET: 0.50, BFF: 5 };
const COMM = 2.0; // per side

function load1m(sym: string): Bar[] {
  const path = new URL(`../data/${sym}_1m.csv`, import.meta.url);
  if (!fs.existsSync(path)) throw new Error(`missing data/${sym}_1m.csv`);
  const rows = fs.readFileSync(path, "utf8").trim().split("\n").slice(1);
  const m1: Bar[] = [];
  for (const r of rows) {
    const c = r.split(",");
    m1.push({ t: new Date(c[0]).getTime(), o: +c[4], h: +c[5], l: +c[6], c: +c[7], v: +c[8] });
  }
  m1.sort((a, b) => a.t - b.t);
  return m1;
}

function aggregate(m1: Bar[], windowMs: number): Bar[] {
  const buckets = new Map<number, Bar>();
  for (const b of m1) {
    const key = Math.floor(b.t / windowMs) * windowMs;
    const ex = buckets.get(key);
    if (!ex) buckets.set(key, { t: key, o: b.o, h: b.h, l: b.l, c: b.c, v: b.v });
    else { ex.h = Math.max(ex.h, b.h); ex.l = Math.min(ex.l, b.l); ex.c = b.c; ex.v += b.v; }
  }
  return [...buckets.values()].sort((a, b) => a.t - b.t);
}

// Aggregate to "daily" using ET calendar date (CME GLOBEX session 6pm-5pm ET, but we'll use
// 5pm-5pm ET which is standard CME daily for crypto)
function aggregateDaily(m1: Bar[]): Bar[] {
  const buckets = new Map<string, Bar>();
  for (const b of m1) {
    const d = new Date(b.t);
    // Roll: bars at >=18:00 ET belong to NEXT day's session
    const etOff = -5 * 3600_000; // approximate ET offset (DST varies but close enough for daily)
    const sessDate = new Date(b.t + etOff);
    // Use UTC of the session-date to bucket
    const key = sessDate.toISOString().slice(0, 10);
    const ex = buckets.get(key);
    if (!ex) buckets.set(key, { t: b.t, o: b.o, h: b.h, l: b.l, c: b.c, v: b.v });
    else { ex.h = Math.max(ex.h, b.h); ex.l = Math.min(ex.l, b.l); ex.c = b.c; ex.v += b.v; }
  }
  return [...buckets.values()].sort((a, b) => a.t - b.t);
}

function atr(bars: Bar[], period = 14): number[] {
  const out: number[] = [];
  for (let i = 0; i < bars.length; i++) {
    if (i < period) { out.push(0); continue; }
    let s = 0;
    for (let j = i - period + 1; j <= i; j++) {
      const tr = j === 0 ? bars[j].h - bars[j].l : Math.max(bars[j].h - bars[j].l, Math.abs(bars[j].h - bars[j - 1].c), Math.abs(bars[j].l - bars[j - 1].c));
      s += tr;
    }
    out.push(s / period);
  }
  return out;
}

function etHour(d: Date): { h: number; dow: string; dateStr: string } {
  const s = d.toLocaleString("en-US", { timeZone: "America/New_York", hour12: false, weekday: "short", hour: "2-digit", minute: "2-digit", year: "numeric", month: "2-digit", day: "2-digit" });
  const dow = s.slice(0, 3);
  const hm = s.match(/(\d{2}):(\d{2})/);
  const h = hm ? +hm[1] + +hm[2] / 60 : 0;
  const dateStr = d.toLocaleDateString("en-CA", { timeZone: "America/New_York" });
  return { h, dow, dateStr };
}

interface Trade { sym: string; hypothesis: string; entry: number; exit: number; pnl: number; r: number; entryTime: number; exitTime: number; dir: "long" | "short"; }

function tradePnl(sym: string, dir: "long" | "short", entry: number, exit: number, stopDist: number): { pnl: number; r: number } {
  const mult = MULT[sym];
  const pnl = (dir === "long" ? exit - entry : entry - exit) * mult - COMM * 2;
  const riskDollars = stopDist * mult;
  return { pnl, r: riskDollars > 0 ? pnl / riskDollars : 0 };
}

// =================== H1: Weekend gap fade ===================
function testH1_WeekendGap(sym: string, m1: Bar[]): Trade[] {
  const trades: Trade[] = [];
  const tickSz = TICK[sym];
  // Find Friday-close / Sunday-open pairs
  // Friday close: last 1m bar with ET time <= 16:59 (since CME closes 17:00 ET Fri)
  // Sunday open: first 1m bar with ET time >= 18:00 ET Sun
  const fridayCloses = new Map<string, Bar>();   // yyyy-mm-dd → last bar
  const sundayOpens = new Map<string, Bar>();    // yyyy-mm-dd → first bar
  for (const b of m1) {
    const e = etHour(new Date(b.t));
    if (e.dow === "Fri" && e.h < 17) {
      const cur = fridayCloses.get(e.dateStr);
      if (!cur || b.t > cur.t) fridayCloses.set(e.dateStr, b);
    }
    if (e.dow === "Sun" && e.h >= 18) {
      const cur = sundayOpens.get(e.dateStr);
      if (!cur || b.t < cur.t) sundayOpens.set(e.dateStr, b);
    }
  }
  // Iterate Sundays; for each, find prior Friday's close
  const sundays = [...sundayOpens.keys()].sort();
  for (const sunDate of sundays) {
    const sunOpen = sundayOpens.get(sunDate)!;
    // Prior Friday: 2 days before sunday
    const sunD = new Date(sunDate);
    sunD.setUTCDate(sunD.getUTCDate() - 2);
    const friDate = sunD.toISOString().slice(0, 10);
    const friClose = fridayCloses.get(friDate);
    if (!friClose) continue;

    const gapPct = (sunOpen.o - friClose.c) / friClose.c;
    if (Math.abs(gapPct) < 0.005) continue; // gap < 0.5% — skip

    const dir: "long" | "short" = gapPct > 0 ? "short" : "long";
    // Entry = sunday open, target = friday close (full fade), stop = 2x gap size away
    const entry = dir === "long" ? sunOpen.o + tickSz : sunOpen.o - tickSz;
    const target = friClose.c;
    const gapSize = Math.abs(sunOpen.o - friClose.c);
    const stop = dir === "long" ? sunOpen.o - gapSize * 1.5 : sunOpen.o + gapSize * 1.5;
    const stopDist = Math.abs(entry - stop);

    // Walk forward up to 5 days (~7200 minutes); find which hits first
    const startIdx = m1.findIndex(x => x.t >= sunOpen.t);
    if (startIdx < 0) continue;
    const maxTime = sunOpen.t + 5 * 86_400_000;
    let exitPx = entry, exitTime = sunOpen.t, exited = false;
    for (let i = startIdx + 1; i < m1.length && m1[i].t <= maxTime; i++) {
      const b = m1[i];
      const hitStop = dir === "long" ? b.l <= stop : b.h >= stop;
      const hitTarget = dir === "long" ? b.h >= target : b.l <= target;
      if (hitStop) { exitPx = stop; exitTime = b.t; exited = true; break; }
      if (hitTarget) { exitPx = target; exitTime = b.t; exited = true; break; }
    }
    if (!exited) {
      // time-exit at end of window
      const last = m1.find(x => x.t > maxTime - 60000) || m1[m1.length - 1];
      exitPx = last.c; exitTime = last.t;
    }
    const exitWithSlip = dir === "long" ? exitPx - tickSz : exitPx + tickSz;
    const { pnl, r } = tradePnl(sym, dir, entry, exitWithSlip, stopDist);
    trades.push({ sym, hypothesis: "H1_weekend_gap", entry, exit: exitWithSlip, pnl, r, entryTime: sunOpen.t, exitTime, dir });
  }
  return trades;
}

// =================== H2: Long-only daily momentum ===================
function testH2_DailyMomentum(sym: string, m1: Bar[]): Trade[] {
  const trades: Trade[] = [];
  const tickSz = TICK[sym];
  const daily = aggregateDaily(m1);
  if (daily.length < 60) return trades;
  const atrD = atr(daily, 20);

  for (let i = 50; i < daily.length; i++) {
    // Signal: today closes > 20-day high (excluding today)
    const win = daily.slice(i - 20, i);
    const high20 = Math.max(...win.map(b => b.h));
    if (daily[i].c <= high20) continue;

    // Enter next day at open (approx: first 1m bar of next session)
    const entryDay = daily[i + 1];
    if (!entryDay) continue;
    const entry = entryDay.o + tickSz;

    // Trail at 3x daily ATR
    const trailMult = 3.0;
    let trailStop = entry - atrD[i] * trailMult;
    let exitPx = entry, exitTime = entryDay.t, exited = false;

    for (let j = i + 1; j < daily.length; j++) {
      // Update trail using prior day's close (don't peek)
      trailStop = Math.max(trailStop, daily[j].c - atrD[j] * trailMult);
      // Check if next day's low takes out trail
      const next = daily[j + 1];
      if (!next) break;
      if (next.l <= trailStop) { exitPx = trailStop; exitTime = next.t; exited = true; break; }
    }
    if (!exited) { const last = daily[daily.length - 1]; exitPx = last.c; exitTime = last.t; }
    const exitWithSlip = exitPx - tickSz;
    const stopDist = atrD[i] * trailMult;
    const { pnl, r } = tradePnl(sym, "long", entry, exitWithSlip, stopDist);
    trades.push({ sym, hypothesis: "H2_daily_momentum", entry, exit: exitWithSlip, pnl, r, entryTime: entryDay.t, exitTime, dir: "long" });
  }
  return trades;
}

// =================== H3: Asian session fade ===================
function testH3_AsianFade(sym: string, m1: Bar[]): Trade[] {
  const trades: Trade[] = [];
  const tickSz = TICK[sym];
  // For each weekday: measure 20:00 prior day → 09:30 ET move; if > 1%, fade at 9:30
  const byDate = new Map<string, Bar[]>();
  for (const b of m1) {
    const e = etHour(new Date(b.t));
    if (!byDate.has(e.dateStr)) byDate.set(e.dateStr, []);
    byDate.get(e.dateStr)!.push(b);
  }
  const dates = [...byDate.keys()].sort();
  for (let di = 1; di < dates.length; di++) {
    const today = byDate.get(dates[di])!;
    const yest = byDate.get(dates[di - 1])!;
    const dow = etHour(new Date(today[0].t)).dow;
    if (dow === "Sat" || dow === "Sun") continue;

    // Get last bar of prior day at 20:00 ET start
    const overnightStart = yest.find(b => etHour(new Date(b.t)).h >= 20);
    if (!overnightStart) continue;
    // Get bar at 9:30 ET today
    const usOpen = today.find(b => etHour(new Date(b.t)).h >= 9.5);
    if (!usOpen) continue;

    const overnight = (usOpen.o - overnightStart.o) / overnightStart.o;
    if (Math.abs(overnight) < 0.01) continue; // <1% — skip

    const dir: "long" | "short" = overnight > 0 ? "short" : "long";
    const entry = dir === "long" ? usOpen.o + tickSz : usOpen.o - tickSz;
    const moveSz = Math.abs(usOpen.o - overnightStart.o);
    const stop = dir === "long" ? entry - moveSz * 0.7 : entry + moveSz * 0.7;
    const target = dir === "long" ? entry + moveSz * 1.2 : entry - moveSz * 1.2;
    const stopDist = Math.abs(entry - stop);

    // Walk forward through today only; exit at 16:00 ET or stop/target
    let exitPx = entry, exitTime = usOpen.t, exited = false;
    for (const b of today) {
      if (b.t <= usOpen.t) continue;
      const e = etHour(new Date(b.t));
      if (e.h >= 16) { exitPx = b.c; exitTime = b.t; exited = true; break; }
      const hitStop = dir === "long" ? b.l <= stop : b.h >= stop;
      const hitTarget = dir === "long" ? b.h >= target : b.l <= target;
      if (hitStop) { exitPx = stop; exitTime = b.t; exited = true; break; }
      if (hitTarget) { exitPx = target; exitTime = b.t; exited = true; break; }
    }
    if (!exited) { exitPx = today[today.length - 1].c; exitTime = today[today.length - 1].t; }
    const exitWithSlip = dir === "long" ? exitPx - tickSz : exitPx + tickSz;
    const { pnl, r } = tradePnl(sym, dir, entry, exitWithSlip, stopDist);
    trades.push({ sym, hypothesis: "H3_asian_fade", entry, exit: exitWithSlip, pnl, r, entryTime: usOpen.t, exitTime, dir });
  }
  return trades;
}

// =================== H4: Time-of-day bias ===================
// Compute hourly returns; identify hours with statistically meaningful positive bias.
// "Trade" = enter long at hour start, exit at hour end. Report per-hour stats.
function testH4_TimeOfDay(sym: string, m1: Bar[]): { hour: number; n: number; meanRet: number; tStat: number }[] {
  const hourly = aggregate(m1, 3600_000);
  const byHour = new Map<number, number[]>();
  for (let i = 1; i < hourly.length; i++) {
    const e = etHour(new Date(hourly[i].t));
    if (e.dow === "Sat" || e.dow === "Sun") continue;
    const ret = (hourly[i].c - hourly[i].o) / hourly[i].o;
    const h = Math.floor(e.h);
    if (!byHour.has(h)) byHour.set(h, []);
    byHour.get(h)!.push(ret);
  }
  const out: { hour: number; n: number; meanRet: number; tStat: number }[] = [];
  for (const [hour, rets] of [...byHour.entries()].sort((a, b) => a[0] - b[0])) {
    const n = rets.length;
    const mean = rets.reduce((s, x) => s + x, 0) / n;
    const variance = rets.reduce((s, x) => s + (x - mean) ** 2, 0) / (n - 1);
    const stderr = Math.sqrt(variance / n);
    const tStat = stderr > 0 ? mean / stderr : 0;
    out.push({ hour, n, meanRet: mean, tStat });
  }
  return out;
}

// =================== H5: BFF Friday gamma ===================
function testH5_BFFFriday(m1: Bar[]): Trade[] {
  const trades: Trade[] = [];
  const tickSz = TICK["BFF"];
  // For each Friday: enter long at 9:30 ET, exit at 15:00 ET. Also test short 13:00-15:00.
  const byDate = new Map<string, Bar[]>();
  for (const b of m1) {
    const e = etHour(new Date(b.t));
    if (e.dow !== "Fri") continue;
    if (!byDate.has(e.dateStr)) byDate.set(e.dateStr, []);
    byDate.get(e.dateStr)!.push(b);
  }
  for (const [date, bars] of byDate) {
    // Long 9:30 → 12:00
    const a = bars.find(b => etHour(new Date(b.t)).h >= 9.5);
    const b1 = bars.find(b => etHour(new Date(b.t)).h >= 12);
    if (a && b1) {
      const entry = a.o + tickSz; const exit = b1.o - tickSz;
      const { pnl, r } = tradePnl("BFF", "long", entry, exit, Math.abs(a.o * 0.01));
      trades.push({ sym: "BFF", hypothesis: "H5a_BFF_fri_morn_long", entry, exit, pnl, r, entryTime: a.t, exitTime: b1.t, dir: "long" });
    }
    // Short 13:00 → 15:00 (afternoon decay test)
    const c = bars.find(b => etHour(new Date(b.t)).h >= 13);
    const d = bars.find(b => etHour(new Date(b.t)).h >= 15);
    if (c && d) {
      const entry = c.o - tickSz; const exit = d.o + tickSz;
      const { pnl, r } = tradePnl("BFF", "short", entry, exit, Math.abs(c.o * 0.01));
      trades.push({ sym: "BFF", hypothesis: "H5b_BFF_fri_aft_short", entry, exit, pnl, r, entryTime: c.t, exitTime: d.t, dir: "short" });
    }
  }
  return trades;
}

// =================== H6: NR4 range expansion ===================
function testH6_NR4(sym: string, m1: Bar[]): Trade[] {
  const trades: Trade[] = [];
  const tickSz = TICK[sym];
  const daily = aggregateDaily(m1);
  if (daily.length < 30) return trades;
  for (let i = 25; i < daily.length - 1; i++) {
    const win = daily.slice(i - 20, i);
    const avgRange = win.reduce((s, b) => s + (b.h - b.l), 0) / 20;
    const todayRange = daily[i].h - daily[i].l;
    if (todayRange >= avgRange * 0.5) continue; // not narrow enough

    // Next day: break of prior day's range = entry
    const next = daily[i + 1];
    // Approx: use next day's open vs prior day's H/L
    if (next.h > daily[i].h && next.o < daily[i].h) {
      // breakout up — enter long at prior high
      const entry = daily[i].h + tickSz;
      const stop = entry - todayRange;
      const target = entry + todayRange * 3;
      const exitPx = next.c;
      let outcome: "stop" | "target" | "close" = "close";
      if (next.l <= stop) { outcome = "stop"; }
      else if (next.h >= target) { outcome = "target"; }
      const exit = outcome === "stop" ? stop : outcome === "target" ? target : next.c;
      const { pnl, r } = tradePnl(sym, "long", entry, exit - tickSz, todayRange);
      trades.push({ sym, hypothesis: "H6_NR4", entry, exit: exit - tickSz, pnl, r, entryTime: next.t, exitTime: next.t, dir: "long" });
    } else if (next.l < daily[i].l && next.o > daily[i].l) {
      const entry = daily[i].l - tickSz;
      const stop = entry + todayRange;
      const target = entry - todayRange * 3;
      const exitPx = next.c;
      let outcome: "stop" | "target" | "close" = "close";
      if (next.h >= stop) { outcome = "stop"; }
      else if (next.l <= target) { outcome = "target"; }
      const exit = outcome === "stop" ? stop : outcome === "target" ? target : next.c;
      const { pnl, r } = tradePnl(sym, "short", entry, exit + tickSz, todayRange);
      trades.push({ sym, hypothesis: "H6_NR4", entry, exit: exit + tickSz, pnl, r, entryTime: next.t, exitTime: next.t, dir: "short" });
    }
  }
  return trades;
}

// =================== H7: Buy & hold with trailing stop ===================
function testH7_BuyHoldTrail(sym: string, m1: Bar[], trailMult: number): { equity: number[]; finalReturn: number; maxDD: number; trail: number } {
  const daily = aggregateDaily(m1);
  if (daily.length < 30) return { equity: [], finalReturn: 0, maxDD: 0, trail: trailMult };
  const atrD = atr(daily, 20);
  const tickSz = TICK[sym];
  const mult = MULT[sym];
  let positions = 0, entryPx = 0, trailStop = 0;
  let cash = 0;
  const equity: number[] = [];
  let peak = 0, maxDD = 0;
  for (let i = 20; i < daily.length; i++) {
    // Enter if flat
    if (positions === 0) {
      positions = 1; entryPx = daily[i].o + tickSz; trailStop = entryPx - atrD[i] * trailMult;
    } else {
      // Update trail
      trailStop = Math.max(trailStop, daily[i].c - atrD[i] * trailMult);
      // Check if today's low hit trail
      if (daily[i].l <= trailStop) {
        const exitPx = trailStop - tickSz;
        cash += (exitPx - entryPx) * mult - COMM * 2;
        positions = 0;
        // Re-enter next day if signal still valid (price > 20-day SMA)
        const sma20 = daily.slice(Math.max(0, i - 19), i + 1).reduce((s, b) => s + b.c, 0) / 20;
        if (daily[i].c > sma20) {
          positions = 1; entryPx = daily[i].c + tickSz; trailStop = entryPx - atrD[i] * trailMult;
        }
      }
    }
    const markToMarket = cash + (positions > 0 ? (daily[i].c - entryPx) * mult : 0);
    equity.push(markToMarket);
    peak = Math.max(peak, markToMarket);
    maxDD = Math.min(maxDD, markToMarket - peak);
  }
  return { equity, finalReturn: equity[equity.length - 1] || 0, maxDD, trail: trailMult };
}

// =================== Stats helpers ===================
function stats(trades: Trade[]) {
  const n = trades.length; if (!n) return null;
  const wins = trades.filter(t => t.pnl > 0), losses = trades.filter(t => t.pnl < 0);
  const net = trades.reduce((s, t) => s + t.pnl, 0);
  const gw = wins.reduce((s, t) => s + t.pnl, 0), gl = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));
  return { n, wr: wins.length / n, exp: net / n, expR: trades.reduce((s, t) => s + t.r, 0) / n, pf: gl ? gw / gl : (gw > 0 ? Infinity : 0), net };
}
const money = (n: number) => `${n < 0 ? "-" : ""}$${Math.abs(n).toFixed(0)}`;
function fmt(s: ReturnType<typeof stats>) { return s ? `n=${String(s.n).padStart(3)} PF ${(s.pf === Infinity ? "INF" : s.pf.toFixed(2)).padStart(4)} ${s.expR >= 0 ? "+" : ""}${s.expR.toFixed(2)}R net ${money(s.net).padStart(7)} wr ${(s.wr * 100).toFixed(0)}%` : "n=0"; }

function byYear(trades: Trade[]) {
  const years = [...new Set(trades.map(t => new Date(t.entryTime).getUTCFullYear()))].sort();
  return years.map(y => {
    const s = stats(trades.filter(t => new Date(t.entryTime).getUTCFullYear() === y));
    return { y, s };
  });
}

// =================== Main ===================
async function main() {
  console.log("\n" + "═".repeat(110));
  console.log("  CRYPTO FUTURES — DEEP EDGE SCAN (7 PRE-REGISTERED HYPOTHESES)");
  console.log("  Real-edge bar: PF >= 1.30 overall AND positive in 3+ consecutive years");
  console.log("═".repeat(110));

  const SYMBOLS = ["MBT", "MET", "BFF"];
  const datasets: Record<string, Bar[]> = {};
  for (const sym of SYMBOLS) {
    try {
      datasets[sym] = load1m(sym);
      const first = new Date(datasets[sym][0].t).toISOString().slice(0, 10);
      const last = new Date(datasets[sym][datasets[sym].length - 1].t).toISOString().slice(0, 10);
      console.log(`  ${sym} loaded — ${datasets[sym].length} 1m bars  ${first} → ${last}`);
    } catch (e) { console.log(`  ${sym}: ${e instanceof Error ? e.message : e}`); }
  }

  // === H1 ===
  console.log("\n" + "─".repeat(110));
  console.log("H1. WEEKEND GAP FADE — Sunday CME open mean-reverts to Friday close");
  console.log("─".repeat(110));
  for (const sym of SYMBOLS) {
    if (!datasets[sym]) continue;
    const trades = testH1_WeekendGap(sym, datasets[sym]);
    const s = stats(trades);
    console.log(`  ${sym.padEnd(4)} ${fmt(s)}`);
    for (const yr of byYear(trades)) console.log(`        ${yr.y}: ${fmt(yr.s)}`);
  }

  // === H2 ===
  console.log("\n" + "─".repeat(110));
  console.log("H2. LONG-ONLY DAILY MOMENTUM — buy 20-day breakout, 3x ATR trail");
  console.log("─".repeat(110));
  for (const sym of SYMBOLS) {
    if (!datasets[sym]) continue;
    const trades = testH2_DailyMomentum(sym, datasets[sym]);
    const s = stats(trades);
    console.log(`  ${sym.padEnd(4)} ${fmt(s)}`);
    for (const yr of byYear(trades)) console.log(`        ${yr.y}: ${fmt(yr.s)}`);
  }

  // === H3 ===
  console.log("\n" + "─".repeat(110));
  console.log("H3. ASIAN SESSION FADE — fade overnight (20:00→09:30 ET) move at US open");
  console.log("─".repeat(110));
  for (const sym of SYMBOLS) {
    if (!datasets[sym]) continue;
    const trades = testH3_AsianFade(sym, datasets[sym]);
    const s = stats(trades);
    console.log(`  ${sym.padEnd(4)} ${fmt(s)}`);
    for (const yr of byYear(trades)) console.log(`        ${yr.y}: ${fmt(yr.s)}`);
  }

  // === H4 ===
  console.log("\n" + "─".repeat(110));
  console.log("H4. TIME-OF-DAY BIAS — hourly return averages (t-stat > 2 = statistically meaningful)");
  console.log("─".repeat(110));
  for (const sym of SYMBOLS) {
    if (!datasets[sym]) continue;
    const hourStats = testH4_TimeOfDay(sym, datasets[sym]);
    console.log(`  ${sym}:`);
    for (const h of hourStats) {
      const flag = Math.abs(h.tStat) > 2 ? (h.tStat > 0 ? "✅ LONG" : "✅ SHORT") : "  ";
      console.log(`    ${String(h.hour).padStart(2)}:00 ET  n=${String(h.n).padStart(4)}  mean ${(h.meanRet * 10000).toFixed(2).padStart(7)} bp  t=${h.tStat.toFixed(2).padStart(6)}  ${flag}`);
    }
  }

  // === H5 ===
  console.log("\n" + "─".repeat(110));
  console.log("H5. BFF FRIDAY GAMMA — long Fri morning, short Fri afternoon");
  console.log("─".repeat(110));
  if (datasets["BFF"]) {
    const trades = testH5_BFFFriday(datasets["BFF"]);
    for (const hyp of ["H5a_BFF_fri_morn_long", "H5b_BFF_fri_aft_short"]) {
      const t = trades.filter(x => x.hypothesis === hyp);
      const s = stats(t);
      console.log(`  ${hyp.padEnd(28)} ${fmt(s)}`);
      for (const yr of byYear(t)) console.log(`        ${yr.y}: ${fmt(yr.s)}`);
    }
  }

  // === H6 ===
  console.log("\n" + "─".repeat(110));
  console.log("H6. NR4 RANGE EXPANSION — narrow range day → breakout next day");
  console.log("─".repeat(110));
  for (const sym of SYMBOLS) {
    if (!datasets[sym]) continue;
    const trades = testH6_NR4(sym, datasets[sym]);
    const s = stats(trades);
    console.log(`  ${sym.padEnd(4)} ${fmt(s)}`);
    for (const yr of byYear(trades)) console.log(`        ${yr.y}: ${fmt(yr.s)}`);
  }

  // === H7 ===
  console.log("\n" + "─".repeat(110));
  console.log("H7. BUY & HOLD WITH TRAILING STOP — pure long-term capture");
  console.log("─".repeat(110));
  for (const sym of ["MBT", "MET"]) {
    if (!datasets[sym]) continue;
    for (const trail of [3, 5, 10]) {
      const r = testH7_BuyHoldTrail(sym, datasets[sym], trail);
      console.log(`  ${sym} ${trail}xATR trail:  finalP&L ${money(r.finalReturn).padStart(8)}  maxDD ${money(r.maxDD).padStart(8)}`);
    }
  }

  console.log("\n═".repeat(55) + "═");
  console.log("Hypothesis tests complete. Look for ANY row showing year-on-year");
  console.log("consistent positive expectancy. Single-year wins = noise.");
  console.log("═".repeat(110) + "\n");
}
main().catch(e => { console.error(e); process.exit(1); });
