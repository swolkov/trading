import { prisma } from "./db";
import { getAccount, getPositions, getOptionsSnapshots, type Position } from "./alpaca";
import { sendNotification } from "./notifications";
import { getHistoricalBars } from "./yahoo";

// ============ PORTFOLIO RISK AGENT ============
// Unified cross-asset risk view across Alpaca (equities/options) + Tradovate (futures).
// Monitors: sector concentration, Greeks exposure, VaR, drawdown, correlation.
// Fires alerts when risk limits are breached.

export interface PortfolioGreeks {
  totalDelta: number;
  totalGamma: number;
  totalTheta: number;
  totalVega: number;
  betaWeightedDelta: number; // SPY-equivalent delta
}

export interface SectorExposure {
  sector: string;
  symbols: string[];
  notional: number;
  pctOfPortfolio: number;
}

export interface RiskAlert {
  severity: "info" | "warning" | "critical";
  category: string;
  message: string;
}

export interface PortfolioRiskSnapshot {
  timestamp: string;
  // Account
  equity: number;
  cash: number;
  cashPct: number;
  dayPnl: number;
  dayPnlPct: number;
  // Positions
  totalPositions: number;
  equityPositions: number;
  optionsPositions: number;
  futuresPositions: number;
  // Exposure
  longExposure: number;
  shortExposure: number;
  netExposure: number;
  grossExposure: number;
  leverageRatio: number; // gross / equity
  // Greeks (options + futures combined)
  greeks: PortfolioGreeks;
  // Sector
  sectorExposures: SectorExposure[];
  topConcentration: { symbol: string; pct: number };
  // Risk metrics
  historicalVaR95: number; // 95% 1-day VaR in dollars
  maxDrawdownPct: number; // from recent peak
  // Alerts
  alerts: RiskAlert[];
}

// Sector mapping for common symbols
const SECTOR_MAP: Record<string, string> = {
  AAPL: "Technology", MSFT: "Technology", GOOGL: "Technology", GOOG: "Technology",
  META: "Technology", AMZN: "Consumer", NVDA: "Technology", AMD: "Technology",
  TSLA: "Consumer", NFLX: "Communication", CRM: "Technology", ADBE: "Technology",
  INTC: "Technology", AVGO: "Technology", QCOM: "Technology", MU: "Technology",
  JPM: "Financial", BAC: "Financial", GS: "Financial", MS: "Financial",
  WFC: "Financial", C: "Financial", V: "Financial", MA: "Financial",
  XOM: "Energy", CVX: "Energy", COP: "Energy", SLB: "Energy",
  JNJ: "Healthcare", UNH: "Healthcare", PFE: "Healthcare", MRK: "Healthcare",
  ABBV: "Healthcare", LLY: "Healthcare", BMY: "Healthcare",
  DIS: "Communication", CMCSA: "Communication", T: "Communication", VZ: "Communication",
  WMT: "Consumer", COST: "Consumer", HD: "Consumer", TGT: "Consumer",
  BA: "Industrial", CAT: "Industrial", GE: "Industrial", HON: "Industrial",
  SPY: "Index", QQQ: "Index", IWM: "Index", DIA: "Index",
};

// Futures delta equivalent in SPY terms
const FUTURES_SPY_DELTA: Record<string, number> = {
  MES: 50, ES: 500,    // S&P 500
  MNQ: 20, NQ: 200,    // Nasdaq
  MYM: 5, YM: 50,      // Dow
  M2K: 10, RTY: 100,   // Russell
};

function getUnderlying(symbol: string): string {
  // Options: AAPL240119C00150000 → AAPL
  const match = symbol.match(/^([A-Z]+)\d{6}/);
  return match ? match[1] : symbol;
}

function getSector(symbol: string): string {
  const underlying = getUnderlying(symbol);
  return SECTOR_MAP[underlying] || "Other";
}

export async function runPortfolioRiskCheck(): Promise<PortfolioRiskSnapshot> {
  const startTime = Date.now();
  const alerts: RiskAlert[] = [];

  // === FETCH ALL DATA IN PARALLEL ===
  const [account, positions, spyBars] = await Promise.all([
    getAccount(),
    getPositions(),
    getHistoricalBars("SPY", 60).catch(() => []),
  ]);

  const equity = parseFloat(account.equity);
  const cash = parseFloat(account.cash);
  const lastEquity = parseFloat(account.last_equity);
  const dayPnl = equity - lastEquity;
  const dayPnlPct = lastEquity > 0 ? (dayPnl / lastEquity) * 100 : 0;
  const cashPct = equity > 0 ? (cash / equity) * 100 : 0;

  // === CLASSIFY POSITIONS ===
  const equityPositions = positions.filter((p) => p.symbol.length <= 10 && p.asset_class === "us_equity");
  const optionsPositions = positions.filter((p) => p.symbol.length > 10);

  // === FETCH OPTIONS GREEKS ===
  let greeks: PortfolioGreeks = { totalDelta: 0, totalGamma: 0, totalTheta: 0, totalVega: 0, betaWeightedDelta: 0 };

  if (optionsPositions.length > 0) {
    try {
      const optSymbols = optionsPositions.map((p) => p.symbol);
      const snapshots = await getOptionsSnapshots(optSymbols);

      for (const pos of optionsPositions) {
        const snap = snapshots[pos.symbol];
        if (!snap?.greeks) continue;
        const qty = parseInt(pos.qty);
        const multiplier = 100; // options multiplier

        greeks.totalDelta += (snap.greeks.delta || 0) * qty * multiplier;
        greeks.totalGamma += (snap.greeks.gamma || 0) * qty * multiplier;
        greeks.totalTheta += (snap.greeks.theta || 0) * qty * multiplier;
        greeks.totalVega += (snap.greeks.vega || 0) * qty * multiplier;
      }
    } catch {
      // Options greeks unavailable — continue with zeros
    }
  }

  // Add equity position deltas (delta = 1 per share)
  for (const pos of equityPositions) {
    const qty = parseInt(pos.qty);
    greeks.totalDelta += qty;
  }

  // === FETCH FUTURES POSITIONS ===
  let futuresPositions = 0;
  try {
    const { getTradovatePositions } = await import("./tradovate");
    const fPositions = await getTradovatePositions();
    futuresPositions = fPositions.length;

    for (const fp of fPositions) {
      const name = fp.contractName || "";
      // Map futures to SPY-equivalent delta
      for (const [prefix, spyDelta] of Object.entries(FUTURES_SPY_DELTA)) {
        if (name.toUpperCase().includes(prefix)) {
          const netPos = fp.netPos || 0;
          greeks.totalDelta += netPos * spyDelta;
          greeks.betaWeightedDelta += netPos * spyDelta;
          break;
        }
      }
    }
  } catch {
    // Tradovate not configured — skip
  }

  // SPY beta-weighted delta for equities/options
  const spyPrice = spyBars.length > 0 ? spyBars[spyBars.length - 1].c : 500;
  greeks.betaWeightedDelta += greeks.totalDelta; // simplified — could weight by beta

  // === EXPOSURE CALCULATION ===
  let longExposure = 0;
  let shortExposure = 0;

  for (const pos of positions) {
    const marketValue = parseFloat(pos.market_value);
    if (marketValue > 0) longExposure += marketValue;
    else shortExposure += Math.abs(marketValue);
  }

  const netExposure = longExposure - shortExposure;
  const grossExposure = longExposure + shortExposure;
  const leverageRatio = equity > 0 ? grossExposure / equity : 0;

  // === SECTOR CONCENTRATION ===
  const sectorMap: Record<string, { symbols: Set<string>; notional: number }> = {};
  for (const pos of positions) {
    const sector = getSector(pos.symbol);
    const underlying = getUnderlying(pos.symbol);
    if (!sectorMap[sector]) sectorMap[sector] = { symbols: new Set(), notional: 0 };
    sectorMap[sector].symbols.add(underlying);
    sectorMap[sector].notional += Math.abs(parseFloat(pos.market_value));
  }

  const sectorExposures: SectorExposure[] = Object.entries(sectorMap)
    .map(([sector, data]) => ({
      sector,
      symbols: [...data.symbols],
      notional: data.notional,
      pctOfPortfolio: equity > 0 ? (data.notional / equity) * 100 : 0,
    }))
    .sort((a, b) => b.notional - a.notional);

  // Top single-name concentration
  const symbolExposure: Record<string, number> = {};
  for (const pos of positions) {
    const underlying = getUnderlying(pos.symbol);
    symbolExposure[underlying] = (symbolExposure[underlying] || 0) + Math.abs(parseFloat(pos.market_value));
  }
  const topSymbol = Object.entries(symbolExposure).sort((a, b) => b[1] - a[1])[0];
  const topConcentration = topSymbol
    ? { symbol: topSymbol[0], pct: equity > 0 ? (topSymbol[1] / equity) * 100 : 0 }
    : { symbol: "none", pct: 0 };

  // === HISTORICAL VaR (95%, 1-day) ===
  let historicalVaR95 = 0;
  if (spyBars.length >= 30) {
    const returns: number[] = [];
    for (let i = 1; i < spyBars.length; i++) {
      returns.push((spyBars[i].c - spyBars[i - 1].c) / spyBars[i - 1].c);
    }
    returns.sort((a, b) => a - b);
    const var95Index = Math.floor(returns.length * 0.05);
    const var95Return = returns[var95Index] || -0.02;
    // Portfolio VaR = equity * beta-weighted exposure * VaR return
    const portfolioBeta = equity > 0 ? netExposure / equity : 1;
    historicalVaR95 = Math.abs(equity * portfolioBeta * var95Return);
  }

  // === MAX DRAWDOWN (from portfolio history) ===
  let maxDrawdownPct = 0;
  // Approximate from day's P&L for now
  if (dayPnlPct < 0) maxDrawdownPct = Math.abs(dayPnlPct);

  // === GENERATE ALERTS ===

  // Cash too low
  if (cashPct < 15) {
    alerts.push({
      severity: cashPct < 10 ? "critical" : "warning",
      category: "Cash Reserve",
      message: `Cash at ${cashPct.toFixed(1)}% ($${cash.toFixed(0)}) — minimum 20% recommended`,
    });
  }

  // Daily loss limit
  if (dayPnlPct < -3) {
    alerts.push({
      severity: "critical",
      category: "Daily Loss",
      message: `DOWN ${dayPnlPct.toFixed(2)}% TODAY ($${dayPnl.toFixed(0)}) — daily loss limit breached, halt all new trades`,
    });
  } else if (dayPnlPct < -1.5) {
    alerts.push({
      severity: "warning",
      category: "Daily Loss",
      message: `Down ${dayPnlPct.toFixed(2)}% today ($${dayPnl.toFixed(0)}) — approaching daily limit`,
    });
  }

  // Leverage
  if (leverageRatio > 2) {
    alerts.push({
      severity: "critical",
      category: "Leverage",
      message: `Leverage ratio ${leverageRatio.toFixed(1)}x — gross exposure $${grossExposure.toFixed(0)} vs equity $${equity.toFixed(0)}`,
    });
  } else if (leverageRatio > 1.5) {
    alerts.push({
      severity: "warning",
      category: "Leverage",
      message: `Elevated leverage ${leverageRatio.toFixed(1)}x`,
    });
  }

  // Sector concentration
  for (const sector of sectorExposures) {
    if (sector.pctOfPortfolio > 40) {
      alerts.push({
        severity: "critical",
        category: "Sector Concentration",
        message: `${sector.sector} at ${sector.pctOfPortfolio.toFixed(0)}% of portfolio (${sector.symbols.join(", ")}) — max 30% recommended`,
      });
    } else if (sector.pctOfPortfolio > 30) {
      alerts.push({
        severity: "warning",
        category: "Sector Concentration",
        message: `${sector.sector} at ${sector.pctOfPortfolio.toFixed(0)}% (${sector.symbols.join(", ")})`,
      });
    }
  }

  // Single name concentration
  if (topConcentration.pct > 15) {
    alerts.push({
      severity: topConcentration.pct > 25 ? "critical" : "warning",
      category: "Name Concentration",
      message: `${topConcentration.symbol} is ${topConcentration.pct.toFixed(0)}% of portfolio — max 10-15% per name`,
    });
  }

  // Delta exposure
  const maxDelta = equity / 100;
  if (Math.abs(greeks.totalDelta) > maxDelta) {
    alerts.push({
      severity: "critical",
      category: "Delta Exposure",
      message: `Portfolio delta ${greeks.totalDelta.toFixed(0)} exceeds limit ±${maxDelta.toFixed(0)} — too directional`,
    });
  } else if (Math.abs(greeks.totalDelta) > maxDelta * 0.7) {
    alerts.push({
      severity: "warning",
      category: "Delta Exposure",
      message: `Portfolio delta ${greeks.totalDelta.toFixed(0)} approaching limit ±${maxDelta.toFixed(0)}`,
    });
  }

  // Theta bleed
  if (greeks.totalTheta < -300) {
    alerts.push({
      severity: "critical",
      category: "Theta Decay",
      message: `Losing $${Math.abs(greeks.totalTheta).toFixed(0)}/day to theta — sell premium or reduce long options`,
    });
  } else if (greeks.totalTheta < -150) {
    alerts.push({
      severity: "warning",
      category: "Theta Decay",
      message: `Theta decay $${Math.abs(greeks.totalTheta).toFixed(0)}/day`,
    });
  }

  // VaR warning
  if (historicalVaR95 > equity * 0.03) {
    alerts.push({
      severity: "critical",
      category: "Value at Risk",
      message: `95% VaR = $${historicalVaR95.toFixed(0)} (${((historicalVaR95 / equity) * 100).toFixed(1)}% of equity) — reduce exposure`,
    });
  }

  // === SEND CRITICAL ALERTS ===
  const criticalAlerts = alerts.filter((a) => a.severity === "critical");
  if (criticalAlerts.length > 0) {
    await sendNotification(
      `🚨 PORTFOLIO RISK ALERT:\n${criticalAlerts.map((a) => `• [${a.category}] ${a.message}`).join("\n")}`,
      "general"
    );
  }

  // === STORE SNAPSHOT ===
  const snapshot: PortfolioRiskSnapshot = {
    timestamp: new Date().toISOString(),
    equity,
    cash,
    cashPct,
    dayPnl,
    dayPnlPct,
    totalPositions: positions.length + futuresPositions,
    equityPositions: equityPositions.length,
    optionsPositions: optionsPositions.length,
    futuresPositions,
    longExposure,
    shortExposure,
    netExposure,
    grossExposure,
    leverageRatio,
    greeks,
    sectorExposures,
    topConcentration,
    historicalVaR95,
    maxDrawdownPct,
    alerts,
  };

  await prisma.agentConfig.upsert({
    where: { key: "portfolio_risk_snapshot" },
    update: { value: JSON.stringify(snapshot) },
    create: { key: "portfolio_risk_snapshot", value: JSON.stringify(snapshot) },
  });

  const summary = `Risk: Equity $${equity.toFixed(0)} | Delta ${greeks.totalDelta.toFixed(0)} | Theta $${greeks.totalTheta.toFixed(0)}/d | Leverage ${leverageRatio.toFixed(1)}x | VaR95 $${historicalVaR95.toFixed(0)} | ${criticalAlerts.length} critical, ${alerts.length - criticalAlerts.length} warnings`;

  await prisma.agentRun.create({
    data: {
      runType: "portfolio_risk",
      stocksScanned: positions.length,
      tradesPlaced: 0,
      positionsManaged: alerts.length,
      errors: criticalAlerts.length,
      summary,
      durationMs: Date.now() - startTime,
    },
  });

  return snapshot;
}
