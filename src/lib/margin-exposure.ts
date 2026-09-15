// CORRELATED EXPOSURE (Sep 15 2026) — what the whole book risks if every stop is hit at once.
//
// Crypto positions are one bet wearing different tickers: on a BTC air-pocket every alt long
// stops out in the same hour. Per-pair netting and the slot count do not see that; this does.
// The account-level number is the sum of each position's risk to ITS stop — the ledgered stop
// fraction for a bot position, and for anything without a ledgered stop (Spencer's manual
// positions, an adopted position, a tranche whose ledger entry was lost) the full liquidation
// cushion (0.6 ÷ leverage), because a position whose stop we cannot see is a position that may
// run to liquidation. Fail closed: unknown risk is the largest risk, never zero.
//
// The cluster gate (clusterEntryAllowed) refuses a NEW entry when the book's all-stops risk plus
// the new trade's would exceed a cap. The default cap is the breaker's headroom — the 15% halt
// minus the drawdown already taken — so the desk can never put on a set of positions whose
// simultaneous stop-out trips the breaker from here. At one slot it is inert (8% < 15%); at
// three slots it refuses a second A+ (8 + 8 > 15) and allows A+ beside Strong (8 + 4).
//
// Pure: no I/O. The executor and the guardian read positions and the ledger and call in.
import { LIQ_CUSHION } from "@/lib/margin-live-risk";

export interface ExposurePosition {
  pair: string;
  side: "long" | "short";
  vol: number;
  entryPrice: number;
  leverage: number;
  ours: boolean;                  // ledgered/adopted bot position
  stopFrac: number | null;        // the ledgered 1R as a fraction of entry (null = no ledgered stop)
  stopPrice?: number | null;      // a KNOWN resting stop level (the guardian's managed level) — wins over stopFrac
}

export interface ExposureSummary {
  positions: number;
  unledgered: number;             // positions counted at the liquidation cushion (no known stop)
  longNotional: number;
  shortNotional: number;
  grossNotional: number;
  netNotional: number;            // long − short
  grossToEquity: number;          // gross ÷ equity (×)
  riskIfAllStopsHitUsd: number;
  riskIfAllStopsHitPct: number;   // of equity
  breakerHeadroomPct: number;     // halt − drawdown taken, floored at 0
  clusterOk: boolean;             // all-stops risk fits inside the breaker headroom
}

const fin = (n: number | null | undefined) => n != null && Number.isFinite(n);

/** What one position loses at its stop, in dollars. Unknown stop → the full cushion. */
export function positionRiskUsd(p: ExposurePosition): { usd: number; atCushion: boolean } {
  const notional = fin(p.vol) && fin(p.entryPrice) && p.vol > 0 && p.entryPrice > 0 ? p.vol * p.entryPrice : 0;
  if (!(notional > 0)) return { usd: 0, atCushion: false };
  if (fin(p.stopPrice) && (p.stopPrice as number) > 0) {
    const dir = p.side === "long" ? 1 : -1;
    // A stop already past breakeven risks nothing; a stop on the wrong side of the entry is
    // treated as a full 1R-less unknown below, never as negative risk.
    return { usd: Math.max(0, dir * (p.entryPrice - (p.stopPrice as number))) * p.vol, atCushion: false };
  }
  if (fin(p.stopFrac) && (p.stopFrac as number) > 0) return { usd: notional * (p.stopFrac as number), atCushion: false };
  const lev = fin(p.leverage) && p.leverage >= 1 ? p.leverage : 1;
  return { usd: notional * (LIQ_CUSHION / lev), atCushion: true };
}

export function exposureSummary(positions: ExposurePosition[], equity: number, ddHaltPct: number, ddNow: number): ExposureSummary {
  let longNotional = 0, shortNotional = 0, risk = 0, unledgered = 0;
  for (const p of positions) {
    const notional = fin(p.vol) && fin(p.entryPrice) && p.vol > 0 && p.entryPrice > 0 ? p.vol * p.entryPrice : 0;
    if (p.side === "long") longNotional += notional; else shortNotional += notional;
    const r = positionRiskUsd(p);
    risk += r.usd;
    if (r.atCushion) unledgered++;
  }
  const gross = longNotional + shortNotional;
  const eq = fin(equity) && equity > 0 ? equity : 0;
  // Headroom: unreadable drawdown or halt → 0 (fail closed: no room until the guardian says so).
  const headroom = fin(ddHaltPct) && ddHaltPct > 0 && fin(ddNow) ? Math.max(0, ddHaltPct - Math.max(0, ddNow)) : 0;
  const riskPct = eq > 0 ? (risk / eq) * 100 : (risk > 0 ? Infinity : 0);
  return {
    positions: positions.length,
    unledgered,
    longNotional, shortNotional, grossNotional: gross, netNotional: longNotional - shortNotional,
    grossToEquity: eq > 0 ? gross / eq : (gross > 0 ? Infinity : 0),
    riskIfAllStopsHitUsd: risk,
    riskIfAllStopsHitPct: riskPct,
    breakerHeadroomPct: headroom,
    clusterOk: Number.isFinite(riskPct) && riskPct <= headroom + 1e-9,
  };
}

export interface ClusterVerdict { ok: boolean; existingUsd: number; newUsd: number; totalPct: number; capPct: number }

/** May a new entry risking `newRiskUsd` join the book under `capPct` of equity? Non-finite anything → no. */
export function clusterEntryAllowed(summary: Pick<ExposureSummary, "riskIfAllStopsHitUsd">, newRiskUsd: number, equity: number, capPct: number): ClusterVerdict {
  const existing = fin(summary.riskIfAllStopsHitUsd) ? Math.max(0, summary.riskIfAllStopsHitUsd) : NaN;
  const cap = fin(capPct) ? capPct : NaN;
  if (!fin(existing) || !fin(newRiskUsd) || !(newRiskUsd >= 0) || !fin(equity) || !(equity > 0) || !fin(cap)) {
    return { ok: false, existingUsd: existing, newUsd: newRiskUsd, totalPct: NaN, capPct: cap };
  }
  const totalPct = ((existing + newRiskUsd) / equity) * 100;
  return { ok: totalPct <= cap + 1e-9, existingUsd: existing, newUsd: newRiskUsd, totalPct, capPct: cap };
}
