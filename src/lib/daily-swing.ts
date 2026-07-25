// ============ DAILY INDEX MEAN-REVERSION — PAPER FORWARD-TEST ============
// A self-contained, PAPER-ONLY swing edge. No broker orders, no engine coupling.
//
// THE EDGE — daily RSI<30 mean-reversion on equity index futures. Validated twice, on two
// independent data vendors, by scripts/daily-swing-validation.ts (Databento, 2011-2026, 30+
// markets) and scripts/daily-crosscheck-yahoo.ts (Yahoo, 2000-2026):
//   ES  PF 3.14 / 2.47   NQ  PF 2.22   YM  PF 1.79   — positive in BOTH halves AND in every
//   5-year block, on both vendors. The Russell (RTY) FAILS everywhere and is deliberately
//   excluded; gold fails once a hard stop is attached and is excluded too.
//
//   Entry (paper long): daily RSI(14) < 30 AND close > 200-day SMA × 0.92
//     (crash/trend filter — don't buy a collapsing market). One pos per symbol.
//   Exit: daily RSI(14) ≥ 50 (bounce complete) OR the 1.5 × ATR(14) stop is hit
//     OR 30 calendar days elapsed (time stop). Long-only.
//   The 1.5 × ATR stop is kept deliberately: wider stops post a higher headline PF but the
//   1.5x setting is the one that is positive in EVERY 5-year block. Consistency over headline.
//
//   Size for P&L accounting: 1 MICRO contract — MES $5/pt, MNQ $2/pt, MYM $0.50/pt —
//     minus $4 round-turn commission.
//
// ⚠️ CAPITAL NOTE: a 1.5 × ATR daily stop is a big move. One micro risks roughly $300-1,000 per
//   trade depending on the symbol, so this edge needs a far larger account than the live futures
//   book to trade for real. That is why it is paper: it proves the edge while capital catches up.
//
// State lives in agentConfig JSON (daily_swing_open / daily_swing_closed) so it
// survives restarts without any schema migration.

import { getFuturesDailyBars } from "./futures-data";
import { prisma } from "./db";

// Track the three validated index symbols. `micro` is the accounting instrument (1 micro contract).
const SYMBOLS = [
  { symbol: "ES", micro: "MES", mult: 5 },    // $5/point
  { symbol: "NQ", micro: "MNQ", mult: 2 },    // $2/point
  { symbol: "YM", micro: "MYM", mult: 0.5 },  // $0.50/point — Dow; most signals of the three
] as const;

const COMMISSION = 4; // round-turn, per micro contract
const RSI_ENTRY = 30;
const RSI_EXIT = 50;
const SMA_FILTER = 0.92; // close must be above 200-SMA × 0.92
const ATR_STOP_MULT = 1.5;
const TIME_STOP_DAYS = 30;

// History request. NOTE: getFuturesDailyBars passes `days` to Tradovate as a BAR COUNT and to the
// Yahoo fallback as CALENDAR DAYS — so this has to be comfortable under both readings. 400 gives
// 400 bars from Tradovate or ~275 trading days from Yahoo; both clear MIN_BARS with room to spare.
// (The previous 320 produced exactly 221 bars against a 220 minimum — one holiday from silently
// disabling itself forever.)
const HISTORY_REQUEST = 400;
const MIN_BARS = 220; // 200 for the SMA + 14 for RSI/ATR + margin

const OPEN_KEY = "daily_swing_open";
const CLOSED_KEY = "daily_swing_closed";

export interface OpenPosition {
  symbol: string; // ES / NQ / YM
  entryPrice: number;
  entryDate: string; // ISO — when the run booked it
  /** Timestamp of the daily BAR the entry was taken on. Exits only consider bars after this,
   *  which is what makes the walk below correct even if the cron misses a day. Optional so
   *  positions written by the previous version still load. */
  entryBarTime?: string;
  stop: number;
  /** Dollar risk to the stop on 1 micro at entry — surfaced so the scoreboard can show the
   *  account size this edge really needs. Optional for back-compat. */
  riskUsd?: number;
}
export interface ClosedTrade {
  symbol: string;
  entryPrice: number;
  exitPrice: number;
  entryDate: string;
  exitDate: string;
  pnl: number;
  reason: "rsi_exit" | "stop" | "stop_gap" | "time_stop";
}
export interface SwingRunSummary {
  symbol: string;
  rsi: number | null;
  sma200: number | null;
  inPosition: boolean;
  action: "open" | "close" | "hold" | "flat" | "skip";
  note?: string;
}

// ── Indicators (Wilder's smoothing, matches the backtest) ────────────

function rsi14(closes: number[], period = 14): number | null {
  if (closes.length < period + 1) return null;
  let gain = 0, loss = 0;
  // Seed with the first `period` changes
  for (let i = 1; i <= period; i++) {
    const ch = closes[i] - closes[i - 1];
    if (ch >= 0) gain += ch; else loss -= ch;
  }
  let avgGain = gain / period;
  let avgLoss = loss / period;
  // Wilder-smooth the rest
  for (let i = period + 1; i < closes.length; i++) {
    const ch = closes[i] - closes[i - 1];
    const up = ch > 0 ? ch : 0;
    const dn = ch < 0 ? -ch : 0;
    avgGain = (avgGain * (period - 1) + up) / period;
    avgLoss = (avgLoss * (period - 1) + dn) / period;
  }
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

function sma(values: number[], period: number): number | null {
  if (values.length < period) return null;
  const slice = values.slice(-period);
  return slice.reduce((a, b) => a + b, 0) / period;
}

function atr14(
  bars: { h: number; l: number; c: number }[],
  period = 14,
): number | null {
  if (bars.length < period + 1) return null;
  const trs: number[] = [];
  for (let i = 1; i < bars.length; i++) {
    const prevClose = bars[i - 1].c;
    const tr = Math.max(
      bars[i].h - bars[i].l,
      Math.abs(bars[i].h - prevClose),
      Math.abs(bars[i].l - prevClose),
    );
    trs.push(tr);
  }
  if (trs.length < period) return null;
  // Wilder-smoothed ATR
  let atr = trs.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < trs.length; i++) {
    atr = (atr * (period - 1) + trs[i]) / period;
  }
  return atr;
}

// ── State helpers ────────────────────────────────────────────────────

async function loadOpen(): Promise<OpenPosition[]> {
  try {
    const row = await prisma.agentConfig.findUnique({ where: { key: OPEN_KEY } });
    return row?.value ? (JSON.parse(row.value) as OpenPosition[]) : [];
  } catch {
    return [];
  }
}
async function loadClosed(): Promise<ClosedTrade[]> {
  try {
    const row = await prisma.agentConfig.findUnique({ where: { key: CLOSED_KEY } });
    return row?.value ? (JSON.parse(row.value) as ClosedTrade[]) : [];
  } catch {
    return [];
  }
}
async function saveOpen(open: OpenPosition[]): Promise<void> {
  await prisma.agentConfig
    .upsert({
      where: { key: OPEN_KEY },
      update: { value: JSON.stringify(open) },
      create: { key: OPEN_KEY, value: JSON.stringify(open) },
    })
    .catch(() => {});
}
async function saveClosed(closed: ClosedTrade[]): Promise<void> {
  await prisma.agentConfig
    .upsert({
      where: { key: CLOSED_KEY },
      update: { value: JSON.stringify(closed) },
      create: { key: CLOSED_KEY, value: JSON.stringify(closed) },
    })
    .catch(() => {});
}

// ── Main run ─────────────────────────────────────────────────────────

export async function runDailySwing(): Promise<SwingRunSummary[]> {
  const open = await loadOpen();
  const closed = await loadClosed();
  const summaries: SwingRunSummary[] = [];
  let openChanged = false;
  let closedChanged = false;

  for (const spec of SYMBOLS) {
    const { symbol, mult } = spec;
    let bars: { t: string; o: number; h: number; l: number; c: number; v: number }[] = [];
    try {
      bars = await getFuturesDailyBars(symbol, HISTORY_REQUEST);
    } catch {
      bars = [];
    }
    // Drop malformed bars BEFORE any maths. The Yahoo fallback coerces a missing open/high/low to
    // 0, and a single 0 would corrupt ATR or fire a phantom stop at price 0.
    bars = bars.filter(
      (b) => Number.isFinite(b.o) && b.o > 0 && Number.isFinite(b.h) && b.h > 0 &&
             Number.isFinite(b.l) && b.l > 0 && Number.isFinite(b.c) && b.c > 0 &&
             Number.isFinite(new Date(b.t).getTime()),
    );
    if (bars.length < MIN_BARS) {
      // Not enough data — skip this symbol this run, never crash. The note is surfaced on the
      // scoreboard so a silently-disabled symbol can't masquerade as "no signal yet".
      summaries.push({
        symbol,
        rsi: null,
        sma200: null,
        inPosition: open.some((p) => p.symbol === symbol),
        action: "skip",
        note: `insufficient daily bars (${bars.length} of ${MIN_BARS} needed) — data feed short`,
      });
      continue;
    }

    const closes = bars.map((b) => b.c);
    const price = closes[closes.length - 1];
    const rsi = rsi14(closes);
    const sma200 = sma(closes, 200);
    const atr = atr14(bars);
    const existing = open.find((p) => p.symbol === symbol);

    if (existing) {
      // ── Manage the open position ────────────────────────────────────────────────
      // Walk EVERY daily bar after the entry bar, in order, and apply the exits the way a real
      // resting stop behaves: a day that GAPS through the stop fills at that day's open, otherwise
      // it fills at the stop. Two things this fixes versus checking only today's close:
      //   1. Honest accounting. Booking a fill at the stop off a close-only test credits a price
      //      that never traded when the market closed far below — it flattered the paper P&L.
      //   2. No skipped days. A missed cron run (holiday, outage, redeploy) can no longer step
      //      over the day the stop was actually hit.
      const entryBarMs = new Date(existing.entryBarTime ?? existing.entryDate).getTime();
      let reason: ClosedTrade["reason"] | null = null;
      let exitPrice = price;
      let exitBarTime = bars[bars.length - 1].t;

      for (let i = 0; i < bars.length; i++) {
        const b = bars[i];
        const barMs = new Date(b.t).getTime();
        if (barMs <= entryBarMs) continue; // entry bar and anything before it can't exit the trade

        if (b.o <= existing.stop) {
          reason = "stop_gap"; // gapped through the stop overnight — fill at the open, not the stop
          exitPrice = b.o;
        } else if (b.l <= existing.stop) {
          reason = "stop";
          exitPrice = existing.stop;
        } else {
          const barRsi = rsi14(closes.slice(0, i + 1));
          if (barRsi != null && barRsi >= RSI_EXIT) {
            reason = "rsi_exit";
            exitPrice = b.c;
          } else if ((barMs - entryBarMs) / (24 * 60 * 60 * 1000) >= TIME_STOP_DAYS) {
            reason = "time_stop";
            exitPrice = b.c;
          }
        }
        if (reason) {
          exitBarTime = b.t;
          break;
        }
      }

      if (reason) {
        const pnl = (exitPrice - existing.entryPrice) * mult - COMMISSION;
        closed.push({
          symbol,
          entryPrice: existing.entryPrice,
          exitPrice: Math.round(exitPrice * 100) / 100,
          entryDate: existing.entryDate,
          exitDate: new Date(exitBarTime).toISOString(), // the bar it actually exited on
          pnl: Math.round(pnl * 100) / 100,
          reason,
        });
        closedChanged = true;
        const idx = open.findIndex((p) => p.symbol === symbol);
        if (idx >= 0) open.splice(idx, 1);
        openChanged = true;
        summaries.push({ symbol, rsi, sma200, inPosition: false, action: "close", note: reason });
      } else {
        summaries.push({ symbol, rsi, sma200, inPosition: true, action: "hold" });
      }
    } else {
      // ── Flat: check the entry condition ──
      const trendOk = sma200 != null && price > sma200 * SMA_FILTER;
      const oversold = rsi != null && rsi < RSI_ENTRY;
      if (oversold && trendOk && atr != null) {
        const stop = price - ATR_STOP_MULT * atr;
        const lastBar = bars[bars.length - 1];
        open.push({
          symbol,
          entryPrice: price,
          entryDate: new Date().toISOString(),
          entryBarTime: lastBar.t, // exits only consider bars after this one
          stop: Math.round(stop * 100) / 100,
          riskUsd: Math.round(ATR_STOP_MULT * atr * mult),
        });
        openChanged = true;
        summaries.push({ symbol, rsi, sma200, inPosition: true, action: "open" });
      } else {
        summaries.push({
          symbol,
          rsi,
          sma200,
          inPosition: false,
          action: "flat",
          note: !oversold ? `RSI ${rsi?.toFixed(1)} ≥ ${RSI_ENTRY}` : "below trend filter",
        });
      }
    }
  }

  if (openChanged) await saveOpen(open);
  if (closedChanged) await saveClosed(closed);
  return summaries;
}

// ── Performance / scoreboard read ────────────────────────────────────

export interface SwingPerformance {
  net: number;
  trades: number;
  wins: number;
  losses: number;
  winRate: number;
  recent: ClosedTrade[];
  open: OpenPosition[];
  watching: {
    symbol: string;
    micro: string;
    rsi: number | null;
    entryTrigger: number;
    inPosition: boolean;
    /** $ risk to the 1.5xATR stop on 1 micro at today's volatility — the real capital ask. */
    riskUsd: number | null;
    /** false = the data feed came back short, so this symbol is NOT being evaluated. */
    dataOk: boolean;
  }[];
}

export async function getSwingPerformance(): Promise<SwingPerformance> {
  const open = await loadOpen();
  const closed = await loadClosed();

  const net = closed.reduce((a, t) => a + t.pnl, 0);
  const wins = closed.filter((t) => t.pnl > 0).length;
  const losses = closed.filter((t) => t.pnl <= 0).length;
  const resolved = wins + losses;

  // Live read per symbol so the UI can show "watching, RSI 47" when flat.
  // Deliberately requests the SAME history as runDailySwing: Wilder RSI depends on how much
  // history it is fed, so a shorter request here would display a number the bot never acted on.
  const watching = await Promise.all(
    SYMBOLS.map(async (spec) => {
      let rsi: number | null = null;
      let riskUsd: number | null = null;
      let dataOk = false;
      try {
        const raw = await getFuturesDailyBars(spec.symbol, HISTORY_REQUEST);
        const bars = raw.filter(
          (b) => Number.isFinite(b.o) && b.o > 0 && Number.isFinite(b.h) && b.h > 0 &&
                 Number.isFinite(b.l) && b.l > 0 && Number.isFinite(b.c) && b.c > 0,
        );
        dataOk = bars.length >= MIN_BARS;
        if (bars.length >= 15) {
          rsi = rsi14(bars.map((b) => b.c));
          const a = atr14(bars);
          if (a != null) riskUsd = Math.round(ATR_STOP_MULT * a * spec.mult);
        }
      } catch {
        rsi = null;
      }
      return {
        symbol: spec.symbol,
        micro: spec.micro,
        rsi,
        entryTrigger: RSI_ENTRY,
        inPosition: open.some((p) => p.symbol === spec.symbol),
        riskUsd,
        dataOk,
      };
    }),
  );

  return {
    net: Math.round(net * 100) / 100,
    trades: closed.length,
    wins,
    losses,
    winRate: resolved > 0 ? wins / resolved : 0,
    recent: closed.slice(-8).reverse(),
    open,
    watching,
  };
}
