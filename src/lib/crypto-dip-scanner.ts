// Crypto dip scanner — READ-ONLY detection of oversold / pulled-back coins (XRP, SOL, DOGE, etc.).
// This is INFORMATION, not a buy signal: a dip detector tells you a coin is down/oversold; it does
// NOT mean the dip will bounce profitably (rapid dip-buy/sell-bounce loses after fees — tested).
// Prices from Alpaca's public crypto bars (no key needed); ~identical to Kraken for reference.
// The future "buy dips & hold" accumulator (needs Kraken funded + key) would consume these signals.
import { prisma } from "./db";

const DEFAULT_WATCHLIST = ["XRP/USD", "SOL/USD", "DOGE/USD", "BTC/USD", "ETH/USD", "AVAX/USD", "LINK/USD"];
const SCAN_KEY = "crypto_dip_scan";

interface Bar { t: string; o: number; h: number; l: number; c: number; }

async function fetchDaily(symbol: string, days = 70): Promise<Bar[]> {
  const start = new Date(Date.now() - (days + 5) * 86_400_000).toISOString().split("T")[0];
  const p = new URLSearchParams({ symbols: symbol, timeframe: "1Day", start, limit: "1000" });
  const url = `https://data.alpaca.markets/v1beta3/crypto/us/bars?${p}`;
  const r = await fetch(url, { signal: AbortSignal.timeout(20000) });
  const d = await r.json();
  return (d.bars?.[symbol] || []).map((b: { t: string; o: number; h: number; l: number; c: number }) => ({ t: b.t, o: b.o, h: b.h, l: b.l, c: b.c }));
}

function rsi(closes: number[], p = 14): number | null {
  if (closes.length < p + 1) return null;
  let ag = 0, al = 0;
  for (let i = closes.length - p; i < closes.length; i++) {
    const ch = closes[i] - closes[i - 1];
    if (ch >= 0) ag += ch; else al -= ch;
  }
  ag /= p; al /= p;
  return 100 - 100 / (1 + ag / (al || 1e-9));
}

export type DipSignal = "DEEP DIP" | "DIP" | "neutral" | "extended";

export interface DipRow {
  symbol: string;
  price: number;
  rsi: number | null;
  pctOff7dHigh: number;   // negative = below the 7-day high
  pctOff30dHigh: number;
  chg24h: number;
  signal: DipSignal;
  note: string;
}

function classify(rsiVal: number | null, off7: number): { signal: DipSignal; note: string } {
  if ((rsiVal != null && rsiVal < 30) || off7 <= -0.15) return { signal: "DEEP DIP", note: "Deeply oversold / sharp pullback" };
  if ((rsiVal != null && rsiVal < 40) || off7 <= -0.08) return { signal: "DIP", note: "Pulling back / mildly oversold" };
  if (rsiVal != null && rsiVal > 70) return { signal: "extended", note: "Overbought / extended — not a dip" };
  return { signal: "neutral", note: "No notable dip" };
}

export async function runDipScan(): Promise<{ rows: DipRow[]; ts: string }> {
  let watchlist = DEFAULT_WATCHLIST;
  try {
    const cfg = await prisma.agentConfig.findUnique({ where: { key: "crypto_dip_watchlist" } });
    if (cfg?.value) watchlist = cfg.value.split(",").map((s) => s.trim().toUpperCase()).filter(Boolean);
  } catch { /* default */ }

  const rows: DipRow[] = [];
  for (const symbol of watchlist) {
    try {
      const bars = await fetchDaily(symbol);
      if (bars.length < 10) continue;
      const closes = bars.map((b) => b.c);
      const price = closes[closes.length - 1];
      const prev = closes[closes.length - 2] ?? price;
      const last7 = bars.slice(-7);
      const last30 = bars.slice(-30);
      const high7 = Math.max(...last7.map((b) => b.h));
      const high30 = Math.max(...last30.map((b) => b.h));
      const off7 = (price - high7) / high7;
      const off30 = (price - high30) / high30;
      const rsiVal = rsi(closes);
      const { signal, note } = classify(rsiVal, off7);
      rows.push({
        symbol,
        price,
        rsi: rsiVal,
        pctOff7dHigh: off7,
        pctOff30dHigh: off30,
        chg24h: (price - prev) / prev,
        signal,
        note,
      });
    } catch { /* skip coin on error */ }
  }

  // Dips first (deepest), then by how far off the 7d high.
  const rank: Record<DipSignal, number> = { "DEEP DIP": 0, DIP: 1, neutral: 2, extended: 3 };
  rows.sort((a, b) => rank[a.signal] - rank[b.signal] || a.pctOff7dHigh - b.pctOff7dHigh);

  const ts = new Date().toISOString();
  try {
    await prisma.agentConfig.upsert({
      where: { key: SCAN_KEY },
      update: { value: JSON.stringify({ rows, ts }) },
      create: { key: SCAN_KEY, value: JSON.stringify({ rows, ts }) },
    });
  } catch { /* best-effort persistence */ }

  return { rows, ts };
}

export async function getDipScan(): Promise<{ rows: DipRow[]; ts: string } | null> {
  try {
    const row = await prisma.agentConfig.findUnique({ where: { key: SCAN_KEY } });
    if (row?.value) return JSON.parse(row.value);
  } catch { /* ignore */ }
  return null;
}
