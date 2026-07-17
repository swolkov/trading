// Index short-setup backtest — tests whether the two setups the live engine REJECTS on the index
// (gap_fill short, trend_continuation short) have a real edge on months of 5-min NQ/ES data,
// net of realistic micro fills (commission + 1-tick slippage). Uses the engine's EXACT definitions
// (src/services/futures-realtime.ts): EMA9/EMA21, RSI14, ATR14, stop 1.5 ATR / target 4 ATR, ET sessions.
/* eslint-disable @typescript-eslint/no-explicit-any */

const KEY = process.env.DATABENTO_API_KEY!;
// Extended back through the 2022 BEAR + 2023-24 recovery + 2025 correction → multiple regimes, so we can
// test whether a regime-filtered LONG is a real edge or just beta from the 2025-26 uptrend.
const START = "2022-01-01", END = "2026-07-15";
const SYMS = [
  { db: "NQ.c.0", name: "NQ", ptVal: 2, tick: 0.25, gapMax: 50 },   // micro MNQ = $2/pt
  { db: "ES.c.0", name: "ES", ptVal: 5, tick: 0.25, gapMax: 10 },   // micro MES = $5/pt
];
const COMMISSION = 1.30; // round turn, micro (Tradovate ~$1.24)

type Bar = { ms: number; etDate: string; etH: number; o: number; h: number; l: number; c: number; v: number; idxInDay: number; prevClose: number };

const etFmt = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour12: false, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
function etParts(ms: number) {
  const p: any = {}; for (const x of etFmt.formatToParts(ms)) p[x.type] = x.value;
  let hh = parseInt(p.hour); if (hh === 24) hh = 0;
  return { date: `${p.year}-${p.month}-${p.day}`, h: hh + parseInt(p.minute) / 60 };
}

async function fetchMonth(sym: string, start: string, end: string): Promise<any[]> {
  const url = "https://hist.databento.com/v0/timeseries.get_range";
  const body = new URLSearchParams({ dataset: "GLBX.MDP3", symbols: sym, stype_in: "continuous", schema: "ohlcv-1m", start, end, encoding: "json" });
  const r = await fetch(url, { method: "POST", headers: { Authorization: "Basic " + Buffer.from(KEY + ":").toString("base64"), "Content-Type": "application/x-www-form-urlencoded" }, body });
  if (!r.ok) { console.error(`  fetch ${sym} ${start} -> ${r.status} ${(await r.text()).slice(0,100)}`); return []; }
  const text = await r.text();
  const out: any[] = [];
  for (const line of text.split("\n")) { if (!line.trim()) continue; try { out.push(JSON.parse(line)); } catch {} }
  return out;
}

function monthRanges(start: string, end: string): [string, string][] {
  const res: [string, string][] = []; let d = new Date(start + "T00:00:00Z"); const e = new Date(end + "T00:00:00Z");
  while (d < e) { const nx = new Date(d); nx.setUTCMonth(nx.getUTCMonth() + 1); const s = d.toISOString().slice(0, 10); const en = (nx < e ? nx : e).toISOString().slice(0, 10); res.push([s, en]); d = nx; }
  return res;
}

// aggregate 1m → 5m RTH bars (ET 9:30–16:00), tag day index + prevDayClose
async function loadBars(sym: { db: string }): Promise<Bar[]> {
  const buckets = new Map<number, { ms: number; o: number; h: number; l: number; c: number; v: number }>();
  for (const [s, e] of monthRanges(START, END)) {
    const rows = await fetchMonth(sym.db, s, e);
    for (const r of rows) {
      const ms = Number(r.hd.ts_event) / 1e6;
      const key = Math.floor(ms / 300000); // 5-min bucket
      const o = Number(r.open) / 1e9, h = Number(r.high) / 1e9, l = Number(r.low) / 1e9, c = Number(r.close) / 1e9, v = Number(r.volume);
      const b = buckets.get(key);
      if (!b) buckets.set(key, { ms: key * 300000, o, h, l, c, v });
      else { b.h = Math.max(b.h, h); b.l = Math.min(b.l, l); b.c = c; b.v += v; }
    }
    process.stdout.write(".");
  }
  const all = [...buckets.values()].sort((a, b) => a.ms - b.ms);
  // keep RTH, tag day index + prevDayClose
  const out: Bar[] = []; let curDate = "", idx = 0; let lastRthCloseByDate = new Map<string, number>();
  // first pass: last RTH close per date
  for (const b of all) { const { date, h } = etParts(b.ms); if (h >= 9.5 && h < 16) lastRthCloseByDate.set(date, b.c); }
  const dates = [...lastRthCloseByDate.keys()].sort();
  const prevCloseOf = new Map<string, number>();
  for (let i = 1; i < dates.length; i++) prevCloseOf.set(dates[i], lastRthCloseByDate.get(dates[i - 1])!);
  for (const b of all) {
    const { date, h } = etParts(b.ms);
    if (h < 9.5 || h >= 16) continue;
    if (date !== curDate) { curDate = date; idx = 0; }
    idx++;
    out.push({ ms: b.ms, etDate: date, etH: h, o: b.o, h: b.h, l: b.l, c: b.c, v: b.v, idxInDay: idx, prevClose: prevCloseOf.get(date) ?? 0 });
  }
  return out;
}

// ── indicators (Wilder RSI/ATR, standard EMA) ──
function emaAt(closes: number[], period: number, i: number): number { const k = 2 / (period + 1); let e = closes[Math.max(0, i - period * 3)]; for (let j = Math.max(1, i - period * 3 + 1); j <= i; j++) e = closes[j] * k + e * (1 - k); return e; }
function rsiAt(closes: number[], i: number, p = 14): number { if (i < p) return 50; let g = 0, l = 0; for (let j = i - p + 1; j <= i; j++) { const d = closes[j] - closes[j - 1]; if (d > 0) g += d; else l -= d; } const rs = l === 0 ? 100 : g / l; return 100 - 100 / (1 + rs); }
function atrAt(bars: Bar[], i: number, p = 14): number { if (i < p) return 0; let s = 0; for (let j = i - p + 1; j <= i; j++) { const tr = Math.max(bars[j].h - bars[j].l, Math.abs(bars[j].h - bars[j - 1].c), Math.abs(bars[j].l - bars[j - 1].c)); s += tr; } return s / p; }

type Trade = { setup: string; date: string; entry: number; pnl$: number; win: boolean };

function backtest(sym: typeof SYMS[0], bars: Bar[]): Trade[] {
  const closes = bars.map(b => b.c);
  const trades: Trade[] = [];
  const tickSlip = sym.tick, tickVal = sym.tick * sym.ptVal;
  let open: { setup: string; entry: number; stop: number; target: number; date: string } | null = null;

  const simExit = (dir: "long" | "short", entry: number, stop: number, target: number, from: number, date: string, setup: string) => {
    const short = dir === "short";
    const fillEntry = short ? entry - tickSlip : entry + tickSlip; // entry 1 tick adverse
    const pnlAt = (px: number) => (short ? fillEntry - px : px - fillEntry) * sym.ptVal - COMMISSION;
    for (let j = from + 1; j < bars.length; j++) {
      if (bars[j].etDate !== date) { const pnl = pnlAt(bars[j - 1].c); trades.push({ setup, date, entry: fillEntry, pnl$: pnl, win: pnl > 0 }); return; }
      const stopHit = short ? bars[j].h >= stop : bars[j].l <= stop;
      const tgtHit = short ? bars[j].l <= target : bars[j].h >= target;
      if (stopHit) { const px = short ? stop + tickSlip : stop - tickSlip; const pnl = pnlAt(px); trades.push({ setup, date, entry: fillEntry, pnl$: pnl, win: false }); return; }
      if (tgtHit) { const pnl = pnlAt(target); trades.push({ setup, date, entry: fillEntry, pnl$: pnl, win: pnl > 0 }); return; }
    }
  };

  for (let i = 30; i < bars.length; i++) {
    if (open) { // is it resolved? simExit already pushed + we clear when its date passed
      // find if trade closed: we resolve inline below by scanning; simpler: only one open at a time, resolve immediately
    }
    const b = bars[i];
    const price = b.c;
    const ema9 = emaAt(closes, 9, i), ema21 = emaAt(closes, 21, i);
    const rsi = rsiAt(closes, i), atr = atrAt(bars, i);
    if (atr === 0) continue;
    const session = b.etH < 9.75 ? "open" : b.etH < 12 ? "morning" : b.etH < 14 ? "midday" : b.etH < 15.75 ? "afternoon" : "close";

    // skip if a trade from this setup is still "open" — we resolve immediately in simExit, so no overlap tracking needed
    // GAP FILL (fade the gap), first 6 bars, open/morning — BOTH directions
    if (b.idxInDay >= 1 && b.idxInDay <= 6 && b.prevClose > 0 && (session === "open" || session === "morning")) {
      const firstIdx = i - (b.idxInDay - 1);
      const gap = bars[firstIdx].o - b.prevClose;
      const absGap = Math.abs(gap);
      if (absGap > 1 && absGap < sym.gapMax && Math.abs(price - b.prevClose) * 0.8 > atr * 0.3) {
        const fillDist = Math.abs(price - b.prevClose) * 0.8;
        if (gap > 0 && price > b.prevClose) { simExit("short", price, price + absGap * 1.5, price - fillDist, i, b.etDate, "gap_fill_short"); continue; }
        if (gap < 0 && price < b.prevClose) { simExit("long", price, price - absGap * 1.5, price + fillDist, i, b.etDate, "gap_fill_long"); continue; }
      }
    }
    // TREND CONTINUATION (pullback to EMA9), morning/afternoon RTH — BOTH directions
    if ((session === "morning" || session === "afternoon") && Math.abs(ema9 - ema21) / price > 0.001) {
      const nearEMA = Math.abs(price - ema9) / price < 0.003;
      if (nearEMA && rsi > 35 && rsi < 65) {
        if (ema9 < ema21 && price < ema21) { simExit("short", price, price + atr * 1.5, price - atr * 4.0, i, b.etDate, "trend_continuation_short"); continue; }
        if (ema9 > ema21 && price > ema21) {
          // REGIME FILTER: "smart about WHEN" — only count the long as a real uptrend-regime trade when price
          // is above the 200-period EMA (a confirmed higher-timeframe uptrend). Below it = we'd be buying a dip
          // in a down/flat tape (the beta trap). Split them so we can see if the FILTERED long holds across regimes.
          const ema200 = emaAt(closes, 200, i);
          const label = (i >= 250 && price > ema200) ? "tc_long_UPTREND" : "tc_long_weakRegime";
          simExit("long", price, price - atr * 1.5, price + atr * 4.0, i, b.etDate, label); continue;
        }
      }
    }
  }
  return trades;
}

function stats(ts: Trade[]) {
  if (!ts.length) return "n=0";
  const net = ts.reduce((s, t) => s + t.pnl$, 0);
  const wins = ts.filter(t => t.win);
  const gW = wins.reduce((s, t) => s + t.pnl$, 0), gL = -ts.filter(t => !t.win).reduce((s, t) => s + t.pnl$, 0);
  const pf = gL > 0 ? gW / gL : Infinity;
  return `n=${ts.length} WR=${(wins.length / ts.length * 100).toFixed(0)}% net$=${net.toFixed(0)} avg$=${(net / ts.length).toFixed(1)} PF=${pf.toFixed(2)}`;
}

async function main() {
  const all: Trade[] = [];
  for (const sym of SYMS) {
    process.stdout.write(`\nloading ${sym.name} `);
    const bars = await loadBars(sym);
    console.log(` ${bars.length} RTH 5m bars`);
    const t = backtest(sym, bars);
    all.push(...t.map(x => ({ ...x, setup: `${sym.name}:${x.setup}` })));
  }
  // split train/test by date median
  const dates = [...new Set(all.map(t => t.date))].sort();
  const cut = dates[Math.floor(dates.length * 0.6)];
  console.log(`\n\nWindow ${START} → ${END}. Train ≤ ${cut} < Test.  Fills: -1 tick entry, -1 tick on stops, +$${COMMISSION} round-turn commission. Micro sizing (MNQ $2/pt, MES $5/pt).\n`);
  const setups = [...new Set(all.map(t => t.setup.split(":")[1]))];
  const grp = (pred: (t: Trade) => boolean) => all.filter(pred);
  console.log("── by setup (both symbols pooled) ──");
  for (const su of setups) {
    console.log(`\n${su}`);
    console.log("  ALL  :", stats(grp(t => t.setup.endsWith(su))));
    console.log("  TRAIN:", stats(grp(t => t.setup.endsWith(su) && t.date <= cut)));
    console.log("  TEST :", stats(grp(t => t.setup.endsWith(su) && t.date > cut)));
  }
  console.log("\n── combined index (both setups, both symbols) ──");
  console.log("  ALL  :", stats(all));
  console.log("  TRAIN:", stats(all.filter(t => t.date <= cut)));
  console.log("  TEST :", stats(all.filter(t => t.date > cut)));
  console.log("\n── per symbol×setup ──");
  for (const s of [...new Set(all.map(t => t.setup))].sort()) console.log("  " + s.padEnd(26), stats(all.filter(t => t.setup === s)));
  console.log("\nEDGE TEST: an edge must be positive (PF>1) in BOTH train AND test. Positive in only one half = variance, not edge.");
}
main().catch(e => { console.error(e); process.exit(1); });
