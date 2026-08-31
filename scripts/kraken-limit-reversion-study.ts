/**
 * THE "BUY THE LOW WITH A LIMIT ORDER" STUDY — Spencer's exact thesis, tested.
 *
 * Thesis: "if we can tell when it's at its high and low and get in with a limit order
 * we should be able to make a lot." Limit orders DO change the math: maker 0.085%/side
 * (his measured Bitnomial fill) vs taker 0.18% — the breakeven accuracy bar drops hard.
 * This tests whether mechanical high/low detection clears that lowered bar.
 *
 * Honesty rules baked in:
 *  - A resting limit only FILLS if the bar trades through it (low <= limit for buys).
 *    Touch-fill is already generous (assumes front of queue) — flagged in the verdict.
 *  - Stops exit as TAKER with 0.05% slippage. Stop-and-target same bar → stop wins.
 *  - Rollover 0.02% per 4h held on notional (his product's financing).
 *  - IS/OOS split 60/40 by time. A cell only PASSES with positive P&L in BOTH halves
 *    and OOS t-stat > 2 (house standard; ~30 cells tested, so a bare t=2 is suspect).
 *  - Includes the ORACLE ceiling: perfect daily low-buy/high-sell, to show what "if we
 *    could truly tell" is worth — the whole question is detection accuracy.
 *
 * Data: Binance klines (free, years of intraday history; Kraken public OHLC caps at
 * 720 bars so it cannot backtest this). Basis vs Kraken measured at −2.6 to +5.6bp —
 * immaterial here. Run: npx tsx scripts/kraken-limit-reversion-study.ts
 */

interface Bar { t: number; o: number; h: number; l: number; c: number }

const MAKER = 0.00085;        // his measured maker fee per side
const TAKER = 0.0018;         // his measured taker fee per side
const STOP_SLIP = 0.0005;     // extra slippage on stop-market exits
const ROLL_4H = 0.0002;       // financing per 4h on notional

async function fetchBinance(symbol: string, interval: string, bars: number): Promise<Bar[]> {
  const out: Bar[] = [];
  const ivMs: Record<string, number> = { "15m": 900_000, "1h": 3_600_000, "4h": 14_400_000 };
  let start = Date.now() - bars * ivMs[interval];
  while (out.length < bars) {
    // binance.us — api.binance.com is geo-blocked (451) from this machine. Same API.
    const url = `https://api.binance.us/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=1000&startTime=${start}`;
    const r = await fetch(url);
    if (!r.ok) throw new Error(`binance ${symbol} ${interval}: ${r.status}`);
    const rows = (await r.json()) as unknown[][];
    if (!rows.length) break;
    for (const k of rows) {
      out.push({ t: Number(k[0]), o: +String(k[1]), h: +String(k[2]), l: +String(k[3]), c: +String(k[4]) });
    }
    start = Number(rows[rows.length - 1][0]) + 1;
    await new Promise((res) => setTimeout(res, 120));
    if (rows.length < 1000) break;
  }
  return out;
}

function rsi14(closes: number[]): number[] {
  const out = new Array(closes.length).fill(NaN);
  let g = 0, l = 0;
  for (let i = 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    const gain = Math.max(0, d), loss = Math.max(0, -d);
    if (i <= 14) { g += gain; l += loss; if (i === 14) { g /= 14; l /= 14; out[i] = 100 - 100 / (1 + g / (l || 1e-9)); } }
    else { g = (g * 13 + gain) / 14; l = (l * 13 + loss) / 14; out[i] = 100 - 100 / (1 + g / (l || 1e-9)); }
  }
  return out;
}

interface Trade { entryT: number; exitT: number; ret: number; holdBars: number }

// One position at a time. Entry: rest a limit at `limitPx(i)` when `gate(i)` is true,
// good for one bar; filled if next bar trades through. Exit: TP limit (maker), stop
// (taker+slip), or time stop after maxHold bars (taker at close).
function simulate(
  bars: Bar[],
  side: "long" | "short",
  gate: (i: number) => boolean,
  limitOff: number,   // rest the entry limit this fraction away from close (in favor)
  tp: number,         // take profit fraction
  stop: number,       // stop fraction
  maxHold: number,
  ivMinutes: number,
): Trade[] {
  const trades: Trade[] = [];
  const dir = side === "long" ? 1 : -1;
  let i = 30;
  while (i < bars.length - 2) {
    if (!gate(i)) { i++; continue; }
    const limit = bars[i].c * (1 - dir * limitOff);
    const nb = bars[i + 1];
    const filled = side === "long" ? nb.l <= limit : nb.h >= limit;
    if (!filled) { i++; continue; }
    const entry = limit;
    const tpPx = entry * (1 + dir * tp);
    const stopPx = entry * (1 - dir * stop);
    let exitPx = NaN, exitFee = MAKER, k = i + 1, exited = false;
    for (; k <= Math.min(bars.length - 1, i + 1 + maxHold); k++) {
      const b = bars[k];
      const stopHit = side === "long" ? b.l <= stopPx : b.h >= stopPx;
      const tpHit = side === "long" ? b.h >= tpPx : b.l <= tpPx;
      if (stopHit) { exitPx = stopPx * (1 - dir * STOP_SLIP); exitFee = TAKER; exited = true; break; }  // stop first: conservative
      // NO take-profit on the entry bar: the bar's high may have printed BEFORE the low
      // that filled us — same-bar TP is the buy-the-wick look-ahead fantasy that made
      // the first run of this study print 80% win rates. Stops still count same-bar
      // (adverse continuation is the conservative assumption).
      if (tpHit && k > i + 1) { exitPx = tpPx; exitFee = MAKER; exited = true; break; }
    }
    if (!exited) { k = Math.min(bars.length - 1, i + 1 + maxHold); exitPx = bars[k].c; exitFee = TAKER; }
    const holdBars = k - (i + 1);
    const gross = dir * (exitPx - entry) / entry;
    const rollPeriods = Math.ceil((holdBars * ivMinutes) / 240);
    const net = gross - MAKER - exitFee - rollPeriods * ROLL_4H;
    trades.push({ entryT: bars[i + 1].t, exitT: bars[k].t, ret: net, holdBars });
    i = k + 1;
  }
  return trades;
}

function stats(trades: Trade[]): { n: number; win: number; avg: number; tot: number; t: number } {
  const n = trades.length;
  if (!n) return { n: 0, win: 0, avg: 0, tot: 0, t: 0 };
  const avg = trades.reduce((s, x) => s + x.ret, 0) / n;
  const sd = n > 1 ? Math.sqrt(trades.reduce((s, x) => s + (x.ret - avg) ** 2, 0) / (n - 1)) : 0;
  return {
    n,
    win: trades.filter((x) => x.ret > 0).length / n,
    avg,
    tot: trades.reduce((s, x) => s + x.ret, 0),
    t: sd > 0 ? avg / (sd / Math.sqrt(n)) : 0,
  };
}

function fmtCell(name: string, is: ReturnType<typeof stats>, oos: ReturnType<typeof stats>): string {
  const pass = is.tot > 0 && oos.tot > 0 && oos.t > 2;
  return `${name.padEnd(34)} IS: ${String(is.n).padStart(4)}t ${(is.win * 100).toFixed(0).padStart(3)}% ${(is.avg * 100).toFixed(3).padStart(7)}%/t t=${is.t.toFixed(1).padStart(5)} | OOS: ${String(oos.n).padStart(4)}t ${(oos.win * 100).toFixed(0).padStart(3)}% ${(oos.avg * 100).toFixed(3).padStart(7)}%/t t=${oos.t.toFixed(1).padStart(5)} ${pass ? "  ← PASSES" : ""}`;
}

async function main() {
  const coins = [
    { name: "BTC", sym: "BTCUSDT" },
    { name: "ETH", sym: "ETHUSDT" },
    { name: "SOL", sym: "SOLUSDT" },
  ];

  console.log("=".repeat(120));
  console.log(`"BUY THE LOW WITH A LIMIT" — maker ${MAKER * 100}%/side, taker ${TAKER * 100}% on stops, rollover ${ROLL_4H * 100}%/4h. IS/OOS 60/40.`);
  console.log(`PASS bar: positive BOTH halves AND OOS t>2. (~30 cells tested — one marginal pass is noise, a cluster is signal.)`);
  console.log("=".repeat(120));

  for (const coin of coins) {
    const h1 = await fetchBinance(coin.sym, "1h", 35000);     // ~4 years
    const m15 = await fetchBinance(coin.sym, "15m", 70000);   // ~2 years
    const h4 = await fetchBinance(coin.sym, "4h", 9000);      // ~4 years
    console.log(`\n### ${coin.name} — 1h ${h1.length} bars (${new Date(h1[0].t).toISOString().slice(0, 10)}→), 15m ${m15.length}, 4h ${h4.length}`);

    const split = (bars: Bar[]) => Math.floor(bars.length * 0.6);

    const closes1h = h1.map((b) => b.c);
    const r1h = rsi14(closes1h);
    // 4h RSI aligned to 1h index for multi-timeframe confluence (his style).
    const r4h = rsi14(h4.map((b) => b.c));
    const rsi4hAt = (i: number): number => {
      const t = h1[i].t;
      let lo = 0, hi = h4.length - 1, ans = NaN;
      while (lo <= hi) { const mid = (lo + hi) >> 1; if (h4[mid].t <= t) { ans = r4h[mid]; lo = mid + 1; } else hi = mid - 1; }
      return ans;
    };
    // Trailing 96h range position of the close (0 = at the low, 1 = at the high).
    const rangePos = (bars: Bar[], i: number, n: number): number => {
      let hh = -Infinity, ll = Infinity;
      for (let j = Math.max(0, i - n); j <= i; j++) { hh = Math.max(hh, bars[j].h); ll = Math.min(ll, bars[j].l); }
      return hh > ll ? (bars[i].c - ll) / (hh - ll) : 0.5;
    };

    const cells: { name: string; bars: Bar[]; iv: number; side: "long" | "short"; gate: (i: number) => boolean; p: [number, number, number, number] }[] = [
      { name: "1h dip-limit 1% → tp1/stop1", bars: h1, iv: 60, side: "long", gate: () => true, p: [0.01, 0.01, 0.01, 48] },
      { name: "1h dip-limit 2% → tp2/stop2", bars: h1, iv: 60, side: "long", gate: () => true, p: [0.02, 0.02, 0.02, 96] },
      { name: "1h range-bottom10% limit@close", bars: h1, iv: 60, side: "long", gate: (i) => rangePos(h1, i, 96) < 0.10, p: [0, 0.02, 0.02, 96] },
      { name: "1h range-top10% SHORT", bars: h1, iv: 60, side: "short", gate: (i) => rangePos(h1, i, 96) > 0.90, p: [0, 0.02, 0.02, 96] },
      { name: "1h RSI<30 AND 4hRSI<35 (confluence)", bars: h1, iv: 60, side: "long", gate: (i) => r1h[i] < 30 && rsi4hAt(i) < 35, p: [0, 0.02, 0.02, 96] },
      { name: "1h RSI>70 AND 4hRSI>65 SHORT", bars: h1, iv: 60, side: "short", gate: (i) => r1h[i] > 70 && rsi4hAt(i) > 65, p: [0, 0.02, 0.02, 96] },
      { name: "15m dip-limit 0.7% → tp0.7/stop0.7", bars: m15, iv: 15, side: "long", gate: () => true, p: [0.007, 0.007, 0.007, 96] },
    ];

    for (const cell of cells) {
      const [off, tp, stop, hold] = cell.p;
      const trades = simulate(cell.bars, cell.side, cell.gate, off, tp, stop, hold, cell.iv);
      const cut = cell.bars[split(cell.bars)].t;
      console.log(fmtCell(cell.name, stats(trades.filter((x) => x.entryT < cut)), stats(trades.filter((x) => x.entryT >= cut))));
    }

    // ORACLE: perfect knowledge — buy the exact low, sell the exact high of every day
    // (maker both sides). This is what "if we can tell" is worth with PERFECT telling.
    const days = new Map<string, { l: number; h: number }>();
    for (const b of h1) {
      const d = new Date(b.t).toISOString().slice(0, 10);
      const e = days.get(d) ?? { l: Infinity, h: -Infinity };
      e.l = Math.min(e.l, b.l); e.h = Math.max(e.h, b.h);
      days.set(d, e);
    }
    let oracle = 1;
    for (const { l, h } of days.values()) if (h > l) oracle *= 1 + ((h - l) / l - 2 * MAKER);
    console.log(`ORACLE (perfect daily low/high, maker fees): $1 → $${oracle.toExponential(2)} over ${days.size} days — perfection is astronomically profitable; the question is only detection accuracy.`);
  }

  console.log("\n" + "=".repeat(120));
  console.log("Read the table: a strategy is REAL only if it passes in BOTH halves with OOS t>2 — and even then, touch-fills flatter it.");
}

main().catch((e) => { console.error("FAIL:", e?.message ?? e); process.exit(1); });
