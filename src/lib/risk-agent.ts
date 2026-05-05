import { type Position } from "./alpaca";

// ============ RISK AGENT ============
// Reviews every proposed trade BEFORE execution.
// Acts as the final gatekeeper — can veto bad trades.
// No AI call needed — pure rules-based for speed.

interface RiskCheck {
  approved: boolean;
  reason: string;
  adjustments?: {
    reduceQty?: boolean;
    useSpread?: boolean;
    maxQty?: number;
  };
}

interface PortfolioState {
  equity: number;
  cash: number;
  positions: Position[];
  portfolioDelta: number;
  dailyPnl: number;
  totalTheta: number;
}

export function reviewTrade(
  symbol: string,
  direction: "bullish" | "bearish",
  strategy: string,
  estimatedCost: number,
  qty: number,
  portfolio: PortfolioState
): RiskCheck {
  const { equity, cash, positions, portfolioDelta, dailyPnl, totalTheta } = portfolio;

  // === RULE 1: Never risk more than 3% on a single trade ===
  if (estimatedCost > equity * 0.03) {
    const maxQty = Math.floor((equity * 0.03) / (estimatedCost / qty));
    if (maxQty <= 0) {
      return { approved: false, reason: `Trade cost $${estimatedCost.toFixed(0)} exceeds 3% risk limit ($${(equity * 0.03).toFixed(0)})` };
    }
    return {
      approved: true,
      reason: `Reduced qty from ${qty} to ${maxQty} (3% risk limit)`,
      adjustments: { reduceQty: true, maxQty },
    };
  }

  // === RULE 2: Don't add to losing days beyond threshold ===
  if (dailyPnl < -equity * 0.03 && strategy.includes("buy")) {
    return { approved: false, reason: `Down ${((dailyPnl / equity) * 100).toFixed(1)}% today — no new buys until recovery` };
  }

  // === RULE 3: Portfolio delta exposure limits ===
  const maxDelta = equity / 100; // e.g. $95k = max ±950 delta
  if (Math.abs(portfolioDelta) > maxDelta * 0.8) {
    // Portfolio is too directional — only allow opposite direction or neutral trades
    const portfolioIsBearish = portfolioDelta < 0;
    const tradeIsBearish = direction === "bearish";
    if (portfolioIsBearish === tradeIsBearish && strategy !== "iron_condor") {
      return {
        approved: false,
        reason: `Portfolio delta ${portfolioDelta.toFixed(0)} too extreme — only allow opposite direction or neutral trades`,
      };
    }
  }

  // === RULE 4: Max 8 total options positions ===
  const optPositions = positions.filter((p) => p.symbol.length > 10);
  if (optPositions.length >= 8) {
    return { approved: false, reason: `At max options positions (${optPositions.length}/8) — close something first` };
  }

  // === RULE 5: Theta decay limit — don't add positions if bleeding too much ===
  if (totalTheta < -200 && strategy.includes("buy")) {
    return {
      approved: true,
      reason: `WARNING: Theta at $${Math.abs(totalTheta).toFixed(0)}/day — prefer selling premium`,
      adjustments: { useSpread: true },
    };
  }

  // === RULE 6: Cash reserve — keep 20% minimum ===
  if (cash - estimatedCost < equity * 0.20) {
    return { approved: false, reason: `Would drop cash below 20% reserve ($${(equity * 0.20).toFixed(0)})` };
  }

  // === RULE 7: No more than 3 positions in same underlying ===
  const underlying = symbol.replace(/\d.*$/, ""); // extract base symbol
  const sameUnderlying = positions.filter((p) => p.symbol.startsWith(underlying)).length;
  if (sameUnderlying >= 3) {
    return { approved: false, reason: `Already have ${sameUnderlying} positions in ${underlying} — too concentrated` };
  }

  // === RULE 8: Prefer spreads over naked options in all cases ===
  if ((strategy === "buy_call" || strategy === "buy_put") && estimatedCost > equity * 0.015) {
    return {
      approved: true,
      reason: `Large naked position ($${estimatedCost.toFixed(0)}) — recommend spread instead`,
      adjustments: { useSpread: true },
    };
  }

  return { approved: true, reason: "Approved" };
}
