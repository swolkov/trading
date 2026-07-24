// ============ DAILY INDEX MEAN-REVERSION — PAPER FORWARD-TEST ============
// A self-contained, PAPER-ONLY swing edge. No broker orders, no engine coupling.
//
// THE EDGE (validated in backtest — daily RSI<30 mean-reversion, PF ~1.8 on
// indexes, durable in/out-of-sample):
//   Entry (paper long): daily RSI(14) < 30 AND close > 200-day SMA × 0.92
//     (crash/trend filter — don't buy a collapsing market). One pos per symbol.
//   Exit: daily RSI(14) ≥ 50 (bounce complete) OR price ≤ entry − 1.5 × ATR(14)
//     (hard stop) OR 30 calendar days elapsed (time stop). Long-only.
//   Size for P&L accounting: 1 MICRO contract — MES = $5/pt, MNQ = $2/pt —
//     minus $4 round-turn commission.
//
// State lives in agentConfig JSON (daily_swing_open / daily_swing_closed) so it
// survives restarts without any schema migration.

import { getFuturesDailyBars } from "./futures-data";
import { prisma } from "./db";

// Track two index symbols. `micro` is the accounting instrument (1 micro contract).
const SYMBOLS = [
  { symbol: "ES", micro: "MES", mult: 5 }, // $5/point
  { symbol: "NQ", micro: "MNQ", mult: 2 }, // $2/point
] as const;

const COMMISSION = 4; // round-turn, per micro contract
const RSI_ENTRY = 30;
const RSI_EXIT = 50;
const SMA_FILTER = 0.92; // close must be above 200-SMA × 0.92
const ATR_STOP_MULT = 1.5;
const TIME_STOP_DAYS = 30;

const OPEN_KEY = "daily_swing_open";
const CLOSED_KEY = "daily_swing_closed";

export interface OpenPosition {
  symbol: string; // ES / NQ
  entryPrice: number;
  entryDate: string; // ISO
  stop: number;
}
export interface ClosedTrade {
  symbol: string;
  entryPrice: number;
  exitPrice: number;
  entryDate: string;
  exitDate: string;
  pnl: number;
  reason: "rsi_exit" | "stop" | "time_stop";
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
    // Need ≥220 daily bars for RSI + 200-SMA. Ask for 320 calendar days to be safe.
    let bars: { t: string; o: number; h: number; l: number; c: number; v: number }[] = [];
    try {
      bars = await getFuturesDailyBars(symbol, 320);
    } catch {
      bars = [];
    }
    if (bars.length < 220) {
      // Not enough data — skip this symbol this run, never crash.
      summaries.push({
        symbol,
        rsi: null,
        sma200: null,
        inPosition: open.some((p) => p.symbol === symbol),
        action: "skip",
        note: `insufficient daily bars (${bars.length})`,
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
      // ── Manage the open position: check 3 exit conditions ──
      let reason: ClosedTrade["reason"] | null = null;
      if (rsi != null && rsi >= RSI_EXIT) {
        reason = "rsi_exit";
      } else if (price <= existing.stop) {
        reason = "stop";
      } else {
        const held =
          (Date.now() - new Date(existing.entryDate).getTime()) /
          (24 * 60 * 60 * 1000);
        if (held >= TIME_STOP_DAYS) reason = "time_stop";
      }

      if (reason) {
        // Use the stop level as the fill on a stop exit (conservative accounting).
        const exitPrice = reason === "stop" ? existing.stop : price;
        const pnl = (exitPrice - existing.entryPrice) * mult - COMMISSION;
        closed.push({
          symbol,
          entryPrice: existing.entryPrice,
          exitPrice,
          entryDate: existing.entryDate,
          exitDate: new Date().toISOString(),
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
        open.push({
          symbol,
          entryPrice: price,
          entryDate: new Date().toISOString(),
          stop: Math.round(stop * 100) / 100,
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
  watching: { symbol: string; rsi: number | null; entryTrigger: number; inPosition: boolean }[];
}

export async function getSwingPerformance(): Promise<SwingPerformance> {
  const open = await loadOpen();
  const closed = await loadClosed();

  const net = closed.reduce((a, t) => a + t.pnl, 0);
  const wins = closed.filter((t) => t.pnl > 0).length;
  const losses = closed.filter((t) => t.pnl <= 0).length;
  const resolved = wins + losses;

  // Live RSI read per symbol so the UI can show "watching, RSI 47" when flat.
  const watching = await Promise.all(
    SYMBOLS.map(async (spec) => {
      let rsi: number | null = null;
      try {
        const bars = await getFuturesDailyBars(spec.symbol, 60);
        if (bars.length >= 15) rsi = rsi14(bars.map((b) => b.c));
      } catch {
        rsi = null;
      }
      return {
        symbol: spec.symbol,
        rsi,
        entryTrigger: RSI_ENTRY,
        inPosition: open.some((p) => p.symbol === spec.symbol),
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
