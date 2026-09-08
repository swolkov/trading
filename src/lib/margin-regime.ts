import { prisma } from "@/lib/db";
import { getKrakenOHLC } from "@/lib/kraken-margin";
import { SIM_VERSION, SIM_COHORT_SQL } from "@/lib/margin-shadow";

// ── PRE-REGISTERED PAPER SLEEVES THAT NEED DAILY BARS (Sep 7 2026) ─────────────────────────
// Two of the four twins registered on Sep 7 read the daily chart:
//   • selective-btc — the live candidate's own signals, opened ONLY while BTC is in an
//     up-regime (daily close above its 20-day average). Tests the regime hypothesis behind
//     the 12–18 UTC and clustered-alt losses without touching the live rule.
//   • tsmom — daily time-series momentum on the majors, the horizon the literature finds
//     robust (Han/Kang/Ryu 2023; Reading 2021): long a coin when its 20-day return is
//     positive AND it closes above its 20-day average; 8% stop, breakeven-then-trail, 14-day
//     time stop. A different ENTRY at a horizon where fees stop dominating — not a twin.
// Both are paper only, judged at 30 resolved / t ≥ 2 / 7 days like every sleeve. Nothing
// here can trade live unless armed by name.

export const REGIME_LOOKBACK = 20;
export const TSMOM_COINS = ["BTC/USD", "ETH/USD", "SOL/USD", "XRP/USD", "ADA/USD", "LINK/USD", "LTC/USD", "DOGE/USD", "AVAX/USD", "SUI/USD"];
export const TSMOM_LEV = 2;

/** Daily closes, oldest → newest, LAST ONE COMPLETE. null until 21 closes exist. */
export function btcRegimeUp(closes: number[]): boolean | null {
  if (closes.length < REGIME_LOOKBACK + 1) return null;
  const last = closes[closes.length - 1];
  const window = closes.slice(-REGIME_LOOKBACK);
  const sma = window.reduce((a, b) => a + b, 0) / window.length;
  if (!(last > 0) || !(sma > 0)) return null;
  return last > sma;
}

/** Time-series momentum signal from daily closes (oldest → newest, last complete). */
export function tsmomSignal(closes: number[]): { long: boolean; short: boolean; ret20: number; sma20: number; close: number } | null {
  if (closes.length < REGIME_LOOKBACK + 1) return null;
  const close = closes[closes.length - 1];
  const prior = closes[closes.length - 1 - REGIME_LOOKBACK];
  const window = closes.slice(-REGIME_LOOKBACK);
  const sma20 = window.reduce((a, b) => a + b, 0) / window.length;
  if (!(close > 0) || !(prior > 0) || !(sma20 > 0)) return null;
  const ret20 = close / prior - 1;
  return { long: ret20 > 0 && close > sma20, short: ret20 < 0 && close < sma20, ret20, sma20, close };
}

// Daily bars from Kraken; the newest bar is the in-progress day and is dropped so the
// signal is computed on COMPLETE closes only (a half-formed bar would let the regime flip
// intraday and then flip back — the classic look-ahead through the current bar).
export async function completedDailyCloses(symbol: string): Promise<number[]> {
  const bars = await getKrakenOHLC(symbol, 1440);
  const dedup = bars.filter((b, i) => i === bars.length - 1 || bars[i + 1].t !== b.t);
  return dedup.slice(0, -1).map((b) => b.c);
}

export async function readBtcRegime(): Promise<boolean | null> {
  return btcRegimeUp(await completedDailyCloses("BTC/USD"));
}

const TSMOM_DAY_KEY = "margin_tsmom_last_day";
const CHASE = 0.001;   // the same 0.1% adverse entry every paper entry pays

/**
 * Once per UTC day: open a tsmom paper long on each major whose daily signal is long and
 * that has no open tsmom row. Returns what it opened. Idempotent within the day.
 */
export async function openTsmomPaper(): Promise<{ opened: string[]; skipped: string[]; errors: string[] }> {
  const out = { opened: [] as string[], skipped: [] as string[], errors: [] as string[] };
  const today = new Date().toISOString().slice(0, 10);
  const last = await prisma.agentConfig.findUnique({ where: { key: TSMOM_DAY_KEY } }).then((r) => r?.value ?? null).catch(() => null);
  if (last === today) return out;
  for (const symbol of TSMOM_COINS) {
    try {
      const closes = await completedDailyCloses(symbol);
      const sig = tsmomSignal(closes);
      if (!sig) { out.skipped.push(`${symbol}: <21 daily closes`); continue; }
      // Long leg (Sep 7) and short leg (Sep 8) — mutually exclusive by construction.
      const leg = sig.long ? { source: "tsmom", side: "buy", px: sig.close * (1 + CHASE), note: `auto: tsmom trend 1d [med — 20d +${(sig.ret20 * 100).toFixed(1)}%, above 20d avg]` }
        : sig.short ? { source: "tsmom-short", side: "sell", px: sig.close * (1 - CHASE), note: `auto: tsmom-short trend 1d [med — 20d ${(sig.ret20 * 100).toFixed(1)}%, below 20d avg]` }
        : null;
      if (!leg) { out.skipped.push(`${symbol}: 20d ${(sig.ret20 * 100).toFixed(1)}%, no trend either way`); continue; }
      const [{ n }] = await prisma.$queryRawUnsafe<{ n: bigint }[]>(
        `SELECT count(*)::bigint AS n FROM tradingview_alerts WHERE symbol=$1 AND source=$2 AND COALESCE(shadow_status,'open')='open' AND ${SIM_COHORT_SQL}`,
        symbol, leg.source,
      );
      if (Number(n) > 0) { out.skipped.push(`${symbol}: ${leg.source} already open`); continue; }
      await prisma.$executeRawUnsafe(
        `INSERT INTO tradingview_alerts (symbol, side, leverage, note, mark_price, executed, validated, conviction, conviction_score, source, sim_version)
         VALUES ($1,$2,$3,$4,$5,false,false,'med',NULL,$6,$7)`,
        symbol, leg.side, TSMOM_LEV, leg.note, leg.px, leg.source, SIM_VERSION,
      );
      out.opened.push(`${symbol} ${leg.source}`);
    } catch (e) { out.errors.push(`${symbol}: ${String(e).slice(0, 80)}`); }
    await new Promise((r) => setTimeout(r, 120));
  }
  await prisma.agentConfig.upsert({ where: { key: TSMOM_DAY_KEY }, update: { value: today }, create: { key: TSMOM_DAY_KEY, value: today } }).catch(() => {});
  return out;
}
