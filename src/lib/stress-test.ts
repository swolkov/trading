import { prisma } from "./db";
import { getPositions, getOptionsSnapshots, type Position } from "./alpaca";
import { getAccount } from "./alpaca";

// ============ SCENARIO / STRESS TESTING ============
// Models portfolio impact of tail events.
// "What happens if SPY drops 5%?" — every institutional desk runs these.
// Without this, you can't prepare for the inevitable.

export interface ScenarioResult {
  name: string;
  description: string;
  // Impact
  estimatedPnl: number;
  estimatedPnlPct: number;
  // Position-level impact
  positionImpacts: {
    symbol: string;
    currentValue: number;
    estimatedNewValue: number;
    estimatedLoss: number;
    pctChange: number;
  }[];
  // Assessment
  severity: "survivable" | "painful" | "critical" | "catastrophic";
  advice: string;
}

export interface StressTestResult {
  timestamp: string;
  equity: number;
  scenarios: ScenarioResult[];
  worstCase: { scenario: string; loss: number; lossPct: number };
  portfolioResilience: "strong" | "moderate" | "weak" | "fragile";
}

// Predefined scenarios
const SCENARIOS = [
  {
    name: "Market Crash (-5%)",
    description: "SPY drops 5% in one day (happens ~2x/year)",
    spyMove: -0.05,
    vixTarget: 35,
    sectorMultipliers: { Technology: 1.3, Financial: 1.2, Energy: 0.8, Healthcare: 0.6, Consumer: 1.0 } as Record<string, number>,
  },
  {
    name: "Flash Crash (-10%)",
    description: "SPY drops 10% (March 2020 level, happens ~1x/decade)",
    spyMove: -0.10,
    vixTarget: 60,
    sectorMultipliers: { Technology: 1.4, Financial: 1.5, Energy: 1.0, Healthcare: 0.5, Consumer: 1.1 } as Record<string, number>,
  },
  {
    name: "VIX Spike (VIX 40+)",
    description: "Volatility doubles — options premiums explode",
    spyMove: -0.03,
    vixTarget: 40,
    sectorMultipliers: { Technology: 1.2, Financial: 1.3, Energy: 1.0, Healthcare: 0.8, Consumer: 1.0 } as Record<string, number>,
  },
  {
    name: "Tech Rout (-8% QQQ)",
    description: "Tech sector sells off hard while defensives hold (sector rotation)",
    spyMove: -0.04,
    vixTarget: 28,
    sectorMultipliers: { Technology: 2.0, Communication: 1.5, Financial: 0.3, Energy: -0.5, Healthcare: 0.2, Consumer: 0.8 } as Record<string, number>,
  },
  {
    name: "Rate Shock (+50bps)",
    description: "Fed surprise hike — growth crushed, financials mixed",
    spyMove: -0.03,
    vixTarget: 30,
    sectorMultipliers: { Technology: 1.5, Financial: 0.5, Energy: 0.3, Healthcare: 0.6, Consumer: 1.0 } as Record<string, number>,
  },
  {
    name: "Bull Rally (+5%)",
    description: "Strong rally — tests short positions and premium sellers",
    spyMove: 0.05,
    vixTarget: 12,
    sectorMultipliers: { Technology: 1.3, Financial: 1.0, Energy: 0.8, Healthcare: 0.7, Consumer: 1.0 } as Record<string, number>,
  },
];

// Sector mapping
const SECTOR_MAP: Record<string, string> = {
  AAPL: "Technology", MSFT: "Technology", GOOGL: "Technology", GOOG: "Technology",
  META: "Technology", AMZN: "Consumer", NVDA: "Technology", AMD: "Technology",
  TSLA: "Consumer", NFLX: "Communication", CRM: "Technology", ADBE: "Technology",
  INTC: "Technology", AVGO: "Technology", QCOM: "Technology", MU: "Technology",
  JPM: "Financial", BAC: "Financial", GS: "Financial", MS: "Financial",
  WFC: "Financial", V: "Financial", MA: "Financial",
  XOM: "Energy", CVX: "Energy", COP: "Energy",
  JNJ: "Healthcare", UNH: "Healthcare", PFE: "Healthcare", LLY: "Healthcare",
  SPY: "Index", QQQ: "Technology", IWM: "Index", DIA: "Index",
};

function getUnderlying(symbol: string): string {
  const match = symbol.match(/^([A-Z]+)\d{6}/);
  return match ? match[1] : symbol;
}

function getSector(symbol: string): string {
  return SECTOR_MAP[getUnderlying(symbol)] || "Other";
}

function estimatePositionImpact(
  pos: Position,
  spyMove: number,
  sectorMultiplier: number,
  vixTarget: number,
  optionGreeks?: { delta: number; gamma: number; vega: number }
): { newValue: number; loss: number; pctChange: number } {
  const currentValue = parseFloat(pos.market_value);
  const isOptions = pos.symbol.length > 10;
  const qty = parseInt(pos.qty);
  const isShort = qty < 0;

  if (isOptions && optionGreeks) {
    // Options: use Greeks for more accurate estimation
    const underlyingMove = spyMove * sectorMultiplier;
    const underlyingPrice = parseFloat(pos.current_price) * 100; // approximate
    const priceChange = underlyingPrice * underlyingMove;

    // Delta P&L
    let deltaPnl = optionGreeks.delta * priceChange * qty * 100;
    // Gamma adjustment (second order)
    deltaPnl += 0.5 * optionGreeks.gamma * Math.pow(priceChange, 2) * qty * 100;
    // Vega P&L (vol change)
    const currentVix = 20; // approximate
    const vegaPnl = optionGreeks.vega * (vixTarget - currentVix) * qty * 100;

    const totalChange = deltaPnl + vegaPnl;
    return {
      newValue: currentValue + totalChange,
      loss: -totalChange,
      pctChange: currentValue !== 0 ? (totalChange / Math.abs(currentValue)) * 100 : 0,
    };
  }

  // Equities: linear approximation
  const move = spyMove * sectorMultiplier;
  const change = currentValue * move;
  return {
    newValue: currentValue + change,
    loss: -change,
    pctChange: move * 100,
  };
}

export async function runStressTest(): Promise<StressTestResult> {
  const [account, positions] = await Promise.all([
    getAccount(),
    getPositions(),
  ]);

  const equity = parseFloat(account.equity);

  // Fetch options Greeks for option positions
  const optPositions = positions.filter((p) => p.symbol.length > 10);
  let greeksMap: Record<string, { delta: number; gamma: number; vega: number }> = {};

  if (optPositions.length > 0) {
    try {
      const snapshots = await getOptionsSnapshots(optPositions.map((p) => p.symbol));
      for (const [sym, snap] of Object.entries(snapshots)) {
        if (snap.greeks) {
          greeksMap[sym] = {
            delta: snap.greeks.delta || 0,
            gamma: snap.greeks.gamma || 0,
            vega: snap.greeks.vega || 0,
          };
        }
      }
    } catch { /* continue without Greeks */ }
  }

  const scenarios: ScenarioResult[] = [];

  for (const scenario of SCENARIOS) {
    const positionImpacts: ScenarioResult["positionImpacts"] = [];
    let totalEstimatedPnl = 0;

    for (const pos of positions) {
      const sector = getSector(pos.symbol);
      const sectorMult = scenario.sectorMultipliers[sector] || 1.0;
      const greeks = greeksMap[pos.symbol];

      const impact = estimatePositionImpact(pos, scenario.spyMove, sectorMult, scenario.vixTarget, greeks);

      positionImpacts.push({
        symbol: pos.symbol.length > 15 ? getUnderlying(pos.symbol) + "..." : pos.symbol,
        currentValue: parseFloat(pos.market_value),
        estimatedNewValue: impact.newValue,
        estimatedLoss: impact.loss,
        pctChange: impact.pctChange,
      });

      totalEstimatedPnl -= impact.loss; // loss is negative of P&L
    }

    const estimatedPnlPct = equity > 0 ? (totalEstimatedPnl / equity) * 100 : 0;

    // Classify severity
    let severity: ScenarioResult["severity"];
    let advice: string;
    const absPctLoss = Math.abs(Math.min(0, estimatedPnlPct));

    if (absPctLoss < 2) {
      severity = "survivable";
      advice = "Portfolio is well-hedged for this scenario. No action needed.";
    } else if (absPctLoss < 5) {
      severity = "painful";
      advice = "Meaningful but manageable loss. Consider reducing largest positions or adding hedges.";
    } else if (absPctLoss < 10) {
      severity = "critical";
      advice = "Severe impact. Immediately review: reduce concentration, add protective puts, increase cash.";
    } else {
      severity = "catastrophic";
      advice = "EXISTENTIAL RISK. Portfolio would be devastated. Urgent: hedge with index puts, reduce leverage, raise cash to 40%+.";
    }

    // For rally scenario, flip the logic
    if (scenario.spyMove > 0 && totalEstimatedPnl < 0) {
      advice = "Short positions or premium sales would be squeezed. Consider reducing short exposure or adding upside hedges.";
    }

    scenarios.push({
      name: scenario.name,
      description: scenario.description,
      estimatedPnl: totalEstimatedPnl,
      estimatedPnlPct,
      positionImpacts: positionImpacts.sort((a, b) => a.estimatedLoss - b.estimatedLoss).slice(0, 5),
      severity,
      advice,
    });
  }

  // Find worst case
  const worstScenario = scenarios.reduce((worst, s) =>
    s.estimatedPnl < worst.estimatedPnl ? s : worst,
    scenarios[0]
  );

  // Portfolio resilience assessment
  const worstLossPct = Math.abs(Math.min(0, worstScenario.estimatedPnlPct));
  const portfolioResilience: StressTestResult["portfolioResilience"] =
    worstLossPct < 3 ? "strong" :
    worstLossPct < 7 ? "moderate" :
    worstLossPct < 15 ? "weak" :
    "fragile";

  const result: StressTestResult = {
    timestamp: new Date().toISOString(),
    equity,
    scenarios,
    worstCase: {
      scenario: worstScenario.name,
      loss: worstScenario.estimatedPnl,
      lossPct: worstScenario.estimatedPnlPct,
    },
    portfolioResilience,
  };

  // Store for dashboard
  await prisma.agentConfig.upsert({
    where: { key: "stress_test_result" },
    update: { value: JSON.stringify(result) },
    create: { key: "stress_test_result", value: JSON.stringify(result) },
  });

  return result;
}
