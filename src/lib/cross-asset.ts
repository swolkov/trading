import { getHistoricalBars } from "./yahoo";

// ============ CROSS-ASSET INTELLIGENCE ============
// Like Citadel: watch bonds, dollar, oil, VIX for macro signals
// These move BEFORE stocks — giving us early warning

export interface CrossAssetSignals {
  // VIX (Fear Index)
  vix: number;
  vixSignal: "extreme_fear" | "fear" | "neutral" | "complacent" | "extreme_complacent";
  vixAdvice: string;

  // Dollar (DXY proxy via UUP ETF)
  dollarTrend: "rising" | "falling" | "flat";
  dollarImpact: string;

  // Bonds (TLT - 20yr Treasury ETF)
  bondTrend: "rising" | "falling" | "flat"; // rising bonds = falling yields = bullish stocks
  bondImpact: string;

  // Oil (USO ETF)
  oilTrend: "rising" | "falling" | "flat";
  oilImpact: string;

  // Gold (GLD ETF)
  goldTrend: "rising" | "falling" | "flat";
  goldImpact: string;

  // Overall macro signal
  macroSignal: "risk_on" | "risk_off" | "mixed";
  macroAdvice: string;

  // For AI prompt
  summary: string;
}

function getTrend(bars: { c: number }[], days: number = 5): "rising" | "falling" | "flat" {
  if (bars.length < days + 1) return "flat";
  const recent = bars[bars.length - 1].c;
  const prior = bars[bars.length - days - 1].c;
  const changePct = ((recent - prior) / prior) * 100;
  if (changePct > 1) return "rising";
  if (changePct < -1) return "falling";
  return "flat";
}

export async function getCrossAssetSignals(): Promise<CrossAssetSignals> {
  // Fetch macro assets in parallel
  const [vixBars, dollarBars, bondBars, oilBars, goldBars] = await Promise.all([
    getHistoricalBars("^VIX", 30).catch(() => getHistoricalBars("VIXY", 30).catch(() => [])),
    getHistoricalBars("UUP", 30).catch(() => []),   // Dollar bull ETF
    getHistoricalBars("TLT", 30).catch(() => []),   // 20yr Treasury
    getHistoricalBars("USO", 30).catch(() => []),   // Oil
    getHistoricalBars("GLD", 30).catch(() => []),   // Gold
  ]);

  // VIX Analysis
  const vixLevel = vixBars.length > 0 ? vixBars[vixBars.length - 1].c : 20;
  let vixSignal: CrossAssetSignals["vixSignal"] = "neutral";
  let vixAdvice = "";
  if (vixLevel > 35) { vixSignal = "extreme_fear"; vixAdvice = "EXTREME FEAR — historically great time to BUY calls. Markets are panicking, contrarian opportunity."; }
  else if (vixLevel > 25) { vixSignal = "fear"; vixAdvice = "Elevated fear — options are expensive. Consider spreads instead of naked buys. Look for oversold bounces."; }
  else if (vixLevel > 18) { vixSignal = "neutral"; vixAdvice = "Normal volatility. Options fairly priced."; }
  else if (vixLevel > 13) { vixSignal = "complacent"; vixAdvice = "Low volatility — options are cheap to buy. Good time for LEAPS and swing trades."; }
  else { vixSignal = "extreme_complacent"; vixAdvice = "EXTREME COMPLACENCY — VIX this low often precedes a spike. Consider buying cheap puts as insurance."; }

  // Dollar
  const dollarTrend = getTrend(dollarBars);
  const dollarImpact = dollarTrend === "rising"
    ? "Strong dollar HURTS: multinational earnings, tech, emerging markets. HELPS: domestic companies."
    : dollarTrend === "falling"
    ? "Weak dollar HELPS: multinationals, tech, commodities. Buy calls on exporters."
    : "Dollar neutral — no major impact.";

  // Bonds
  const bondTrend = getTrend(bondBars);
  const bondImpact = bondTrend === "rising"
    ? "Bonds rising (yields falling) — BULLISH for growth stocks and tech. Rate-sensitive sectors benefit."
    : bondTrend === "falling"
    ? "Bonds falling (yields rising) — BEARISH for growth. Money flowing out of bonds into cash. Be cautious on tech."
    : "Bonds flat — no major signal.";

  // Oil
  const oilTrend = getTrend(oilBars);
  const oilImpact = oilTrend === "rising"
    ? "Oil rising — BULLISH for energy (XOM, CVX). BEARISH for airlines, transports, consumers."
    : oilTrend === "falling"
    ? "Oil falling — BEARISH energy stocks. BULLISH consumer, airlines, transports."
    : "Oil flat — no major impact.";

  // Gold
  const goldTrend = getTrend(goldBars);
  const goldImpact = goldTrend === "rising"
    ? "Gold rising — flight to safety signal. Markets worried. Consider defensive plays."
    : goldTrend === "falling"
    ? "Gold falling — risk appetite increasing. Money flowing into stocks. Bullish signal."
    : "Gold flat — no major signal.";

  // Overall macro
  let bullSignals = 0;
  let bearSignals = 0;
  if (vixLevel < 20) bullSignals++; else if (vixLevel > 25) bearSignals++;
  if (bondTrend === "rising") bullSignals++; else if (bondTrend === "falling") bearSignals++;
  if (dollarTrend === "falling") bullSignals++; else if (dollarTrend === "rising") bearSignals++;
  if (goldTrend === "falling") bullSignals++; else if (goldTrend === "rising") bearSignals++;

  const macroSignal: CrossAssetSignals["macroSignal"] =
    bullSignals >= 3 ? "risk_on" : bearSignals >= 3 ? "risk_off" : "mixed";

  const macroAdvice = macroSignal === "risk_on"
    ? "RISK ON — Macro environment supports buying calls. Be aggressive on high-conviction setups."
    : macroSignal === "risk_off"
    ? "RISK OFF — Macro headwinds. Favor puts, hedges, and smaller positions. Cash is a position."
    : "MIXED SIGNALS — No clear macro direction. Be selective, trade only the best setups.";

  const summary = `CROSS-ASSET INTELLIGENCE (Citadel-style macro analysis):
- VIX: ${vixLevel.toFixed(1)} (${vixSignal.replace("_", " ").toUpperCase()}) — ${vixAdvice}
- Dollar: ${dollarTrend} — ${dollarImpact}
- Bonds: ${bondTrend} — ${bondImpact}
- Oil: ${oilTrend} — ${oilImpact}
- Gold: ${goldTrend} — ${goldImpact}
- MACRO SIGNAL: ${macroSignal.replace("_", " ").toUpperCase()} — ${macroAdvice}`;

  return {
    vix: vixLevel, vixSignal, vixAdvice,
    dollarTrend, dollarImpact,
    bondTrend, bondImpact,
    oilTrend, oilImpact,
    goldTrend, goldImpact,
    macroSignal, macroAdvice,
    summary,
  };
}
