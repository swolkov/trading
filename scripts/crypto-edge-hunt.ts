// Crypto edge hunt for Kraken — rigorous, fee-aware backtest battery.
// Data: Alpaca crypto bars (public, paginated). Costs: Kraken taker 0.26%/side + 0.05% slippage.
// Long-only (spot). Reports net-of-fee metrics with in-sample (IS) vs out-of-sample (OOS) split.
// Run: npx tsx scripts/crypto-edge-hunt.ts

const FEE = 0.0026;   // Kraken taker per side (standard tier)
const SLIP = 0.0005;  // assumed slippage per side
const COST = FEE + SLIP;
const COINS = ["BTC/USD", "ETH/USD", "SOL/USD"];
const START = "2021-01-01";

interface Bar { t: string; o: number; h: number; l: number; c: number; v: number; }

async function fetchBars(symbol: string, timeframe: string): Promise<Bar[]> {
  const out: Bar[] = [];
  let pageToken = "";
  for (let i = 0; i < 50; i++) {
    const p = new URLSearchParams({ symbols: symbol, timeframe, start: START, limit: "10000" });
    if (pageToken) p.set("page_token", pageToken);
    const url = `https://data.alpaca.markets/v1beta3/crypto/us/bars?${p}`;
    const r = await fetch(url, { signal: AbortSignal.timeout(30000) });
    const d = await r.json();
    const bars = d.bars?.[symbol] || [];
    for (const b of bars) out.push({ t: b.t, o: b.o, h: b.h, l: b.l, c: b.c, v: b.v });
    pageToken = d.next_page_token || "";
    if (!pageToken) break;
  }
  return out;
}

// ---- indicators ----
function sma(a: number[], p: number, i: number): number | null {
  if (i < p - 1) return null;
  let s = 0; for (let k = i - p + 1; k <= i; k++) s += a[k];
  return s / p;
}
function emaSeries(a: number[], p: number): number[] {
  const k = 2 / (p + 1); const out: number[] = []; let e = a[0];
  for (let i = 0; i < a.length; i++) { e = i === 0 ? a[0] : a[i] * k + e * (1 - k); out.push(e); }
  return out;
}
function rsiSeries(c: number[], p = 14): (number | null)[] {
  const out: (number | null)[] = [null]; let ag = 0, al = 0;
  for (let i = 1; i < c.length; i++) {
    const ch = c[i] - c[i - 1];
    const g = Math.max(ch, 0), l = Math.max(-ch, 0);
    if (i <= p) { ag += g; al += l; if (i === p) { ag /= p; al /= p; out.push(100 - 100 / (1 + ag / (al || 1e-9))); } else out.push(null); }
    else { ag = (ag * (p - 1) + g) / p; al = (al * (p - 1) + l) / p; out.push(100 - 100 / (1 + ag / (al || 1e-9))); }
  }
  return out;
}
function atrSeries(b: Bar[], p = 14): number[] {
  const tr: number[] = [b[0].h - b[0].l];
  for (let i = 1; i < b.length; i++) tr.push(Math.max(b[i].h - b[i].l, Math.abs(b[i].h - b[i - 1].c), Math.abs(b[i].l - b[i - 1].c)));
  const out: number[] = []; let a = tr[0];
  for (let i = 0; i < tr.length; i++) { a = i === 0 ? tr[0] : (a * (p - 1) + tr[i]) / p; out.push(a); }
  return out;
}
function maxOf(a: number[], from: number, to: number) { let m = -Infinity; for (let i = from; i <= to; i++) m = Math.max(m, a[i]); return m; }
function minOf(a: number[], from: number, to: number) { let m = Infinity; for (let i = from; i <= to; i++) m = Math.min(m, a[i]); return m; }

interface Trade { entryIdx: number; exitIdx: number; entry: number; exit: number; t: string; }

// ---- strategies: return list of long trades ----
function rsiMeanRev(b: Bar[]): Trade[] {
  const c = b.map(x => x.c); const rsi = rsiSeries(c, 14); const trades: Trade[] = []; let inPos = false, ei = 0;
  for (let i = 15; i < b.length; i++) {
    if (!inPos && (rsi[i] ?? 50) < 30) { inPos = true; ei = i; }
    else if (inPos && ((rsi[i] ?? 0) > 50 || i - ei >= 48)) { trades.push({ entryIdx: ei, exitIdx: i, entry: c[ei], exit: c[i], t: b[ei].t }); inPos = false; }
  }
  return trades;
}
function rsiDipTrend(b: Bar[]): Trade[] { // dip-buy ONLY in an uptrend (close>SMA200h); exit RSI>55, 48h, or trend break
  const c = b.map(x => x.c); const rsi = rsiSeries(c, 14); const trades: Trade[] = []; let inPos = false, ei = 0;
  for (let i = 201; i < b.length; i++) {
    const trend = sma(c, 200, i)!;
    if (!inPos && (rsi[i] ?? 50) < 35 && c[i] > trend) { inPos = true; ei = i; }
    else if (inPos && ((rsi[i] ?? 0) > 55 || i - ei >= 48 || c[i] < trend)) { trades.push({ entryIdx: ei, exitIdx: i, entry: c[ei], exit: c[i], t: b[ei].t }); inPos = false; }
  }
  return trades;
}
function donchianHourly(b: Bar[]): Trade[] { // breakout 24h high, exit 12h low
  const c = b.map(x => x.c); const trades: Trade[] = []; let inPos = false, ei = 0;
  for (let i = 25; i < b.length; i++) {
    if (!inPos && c[i] > maxOf(c, i - 24, i - 1)) { inPos = true; ei = i; }
    else if (inPos && c[i] < minOf(c, i - 12, i - 1)) { trades.push({ entryIdx: ei, exitIdx: i, entry: c[ei], exit: c[i], t: b[ei].t }); inPos = false; }
  }
  return trades;
}
function emaCrossHourly(b: Bar[]): Trade[] { // EMA12 x EMA48
  const c = b.map(x => x.c); const f = emaSeries(c, 12), s = emaSeries(c, 48); const trades: Trade[] = []; let inPos = false, ei = 0;
  for (let i = 49; i < b.length; i++) {
    if (!inPos && f[i] > s[i] && f[i - 1] <= s[i - 1]) { inPos = true; ei = i; }
    else if (inPos && f[i] < s[i] && f[i - 1] >= s[i - 1]) { trades.push({ entryIdx: ei, exitIdx: i, entry: c[ei], exit: c[i], t: b[ei].t }); inPos = false; }
  }
  return trades;
}
function donchianDaily(b: Bar[]): Trade[] { // 20d high breakout, 10d low exit
  const c = b.map(x => x.c), h = b.map(x => x.h), l = b.map(x => x.l); const trades: Trade[] = []; let inPos = false, ei = 0;
  for (let i = 21; i < b.length; i++) {
    if (!inPos && c[i] > maxOf(h, i - 20, i - 1)) { inPos = true; ei = i; }
    else if (inPos && c[i] < minOf(l, i - 10, i - 1)) { trades.push({ entryIdx: ei, exitIdx: i, entry: c[ei], exit: c[i], t: b[ei].t }); inPos = false; }
  }
  return trades;
}
function sma50Daily(b: Bar[]): Trade[] { // hold above 50d SMA
  const c = b.map(x => x.c); const trades: Trade[] = []; let inPos = false, ei = 0;
  for (let i = 51; i < b.length; i++) {
    const m = sma(c, 50, i)!;
    if (!inPos && c[i] > m) { inPos = true; ei = i; }
    else if (inPos && c[i] < m) { trades.push({ entryIdx: ei, exitIdx: i, entry: c[ei], exit: c[i], t: b[ei].t }); inPos = false; }
  }
  return trades;
}
function volBreakoutDaily(b: Bar[]): Trade[] { // close > prevClose + 1*ATR, exit < 10d SMA
  const c = b.map(x => x.c); const atr = atrSeries(b, 14); const trades: Trade[] = []; let inPos = false, ei = 0;
  for (let i = 15; i < b.length; i++) {
    if (!inPos && c[i] > c[i - 1] + atr[i]) { inPos = true; ei = i; }
    else if (inPos && c[i] < (sma(c, 10, i) ?? c[i])) { trades.push({ entryIdx: ei, exitIdx: i, entry: c[ei], exit: c[i], t: b[ei].t }); inPos = false; }
  }
  return trades;
}

// ---- evaluation (net of fees) ----
function net(t: Trade) { return (t.exit * (1 - COST)) / (t.entry * (1 + COST)) - 1; }
function evalTrades(trades: Trade[], b: Bar[], splitIdx: number) {
  const calc = (ts: Trade[]) => {
    if (!ts.length) return { n: 0, win: 0, avg: 0, total: 0, pf: 0, dd: 0 };
    let eq = 1, peak = 1, dd = 0, gp = 0, gl = 0, win = 0, sum = 0;
    for (const t of ts) { const r = net(t); sum += r; if (r > 0) { win++; gp += r; } else gl += -r; eq *= (1 + r); peak = Math.max(peak, eq); dd = Math.max(dd, (peak - eq) / peak); }
    return { n: ts.length, win: win / ts.length, avg: sum / ts.length, total: eq - 1, pf: gl > 0 ? gp / gl : (gp > 0 ? 99 : 0), dd };
  };
  return { all: calc(trades), is: calc(trades.filter(t => t.entryIdx < splitIdx)), oos: calc(trades.filter(t => t.entryIdx >= splitIdx)) };
}

const STRATS: Record<string, { fn: (b: Bar[]) => Trade[]; tf: string }> = {
  "rsi-meanrev (1h)": { fn: rsiMeanRev, tf: "1Hour" },
  "rsi-dip+trend (1h)": { fn: rsiDipTrend, tf: "1Hour" },
  "donchian-break (1h)": { fn: donchianHourly, tf: "1Hour" },
  "ema12x48 (1h)": { fn: emaCrossHourly, tf: "1Hour" },
  "donchian20 (1d)": { fn: donchianDaily, tf: "1Day" },
  "sma50-trend (1d)": { fn: sma50Daily, tf: "1Day" },
  "vol-breakout (1d)": { fn: volBreakoutDaily, tf: "1Day" },
};

(async () => {
  console.log(`Crypto edge hunt — Kraken fees ${(FEE * 100).toFixed(2)}%/side + ${(SLIP * 100).toFixed(2)}% slip = ${((COST * 2) * 100).toFixed(2)}% round-trip\n`);
  const dataH: Record<string, Bar[]> = {}, dataD: Record<string, Bar[]> = {};
  for (const c of COINS) { dataH[c] = await fetchBars(c, "1Hour"); dataD[c] = await fetchBars(c, "1Day"); }
  for (const c of COINS) {
    const bh = dataD[c]; const buyHold = bh.length ? (bh[bh.length - 1].c / bh[0].c - 1) : 0;
    console.log(`\n===== ${c} (${dataD[c].length}d / ${dataH[c].length}h, ${dataD[c][0]?.t.slice(0,10)}→${dataD[c][dataD[c].length-1]?.t.slice(0,10)}) | buy&hold ${(buyHold*100).toFixed(0)}% =====`);
    console.log("strategy            | trades | win% |  avg%/t | NET total% |  PF  | maxDD% || OOS PF | OOS avg%/t | OOS trades");
    for (const [name, s] of Object.entries(STRATS)) {
      const b = s.tf === "1Hour" ? dataH[c] : dataD[c];
      if (b.length < 100) { console.log(`${name.padEnd(20)}| insufficient data`); continue; }
      const trades = s.fn(b);
      const split = Math.floor(b.length * 0.6);
      const m = evalTrades(trades, b, split);
      console.log(
        `${name.padEnd(20)}| ${String(m.all.n).padStart(6)} | ${(m.all.win*100).toFixed(0).padStart(3)}% | ${(m.all.avg*100).toFixed(3).padStart(7)} | ${(m.all.total*100).toFixed(0).padStart(9)} | ${m.all.pf.toFixed(2).padStart(4)} | ${(m.all.dd*100).toFixed(0).padStart(5)} || ${m.oos.pf.toFixed(2).padStart(5)} | ${(m.oos.avg*100).toFixed(3).padStart(9)} | ${String(m.oos.n).padStart(5)}`
      );
    }
  }
  console.log("\nLegend: avg%/t = net avg return PER TRADE (must clear ~0.62% round-trip cost). PF>1 & OOS PF>1 = candidate edge. avg%/t <0 = loses after fees.");
})();
