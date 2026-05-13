// ============ RESEARCH AGENT ============
// Populates the Obsidian vault Brain/ and Research/ files with live market intelligence.
// Runs daily at premarket (9:00 AM ET) via cron.
// Does NOT trade — purely intelligence gathering.

import { detectMarketRegime } from "./market-regime";
import { generateMacroBriefing } from "./macro-briefing";
import { updateMarketRegime, updateVolatilityEnvironment, vaultWrite } from "./vault";
import { getHistoricalBars } from "./yahoo";

export interface ResearchResult {
  regimeUpdated: boolean;
  macroUpdated: boolean;
  volUpdated: boolean;
  sectorsUpdated: boolean;
  details: string[];
}

export async function runResearchAgent(): Promise<ResearchResult> {
  const details: string[] = [];
  const result: ResearchResult = {
    regimeUpdated: false,
    macroUpdated: false,
    volUpdated: false,
    sectorsUpdated: false,
    details,
  };

  const today = new Date().toISOString().slice(0, 10);

  // 1. Market Regime
  try {
    const regime = await detectMarketRegime();
    await updateMarketRegime(regime.regime, {
      trend: regime.spyAbove50sma ? "Above 50 SMA" : "Below 50 SMA",
      volatility: `Annualized ${(regime.volatility * 100).toFixed(1)}%`,
      momentum: `1M: ${(regime.spy1mReturn * 100).toFixed(1)}%, 3M: ${(regime.spy3mReturn * 100).toFixed(1)}%`,
      breadth: regime.goldenCross ? "Golden Cross (50 > 200 SMA)" : regime.deathCross ? "Death Cross (50 < 200 SMA)" : "Neutral",
      implications: regime.recommendation,
    });
    result.regimeUpdated = true;
    details.push(`REGIME: ${regime.regime.toUpperCase()} — ${regime.recommendation}`);
  } catch (err) {
    details.push(`Regime detection failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  // 2. Macro Briefing
  try {
    const briefing = await generateMacroBriefing();
    await vaultWrite("Brain/macro-outlook.md", `---
last_updated: "${today}"
updated_by: "research-agent"
---

# Macro Outlook

## Summary
${briefing.summary}

## Bias: ${briefing.bias.toUpperCase()}

## Key Risks
${briefing.keyRisks?.map((r: string) => `- ${r}`).join("\n") || "None flagged"}

## Trading Rules
${briefing.tradingRules?.map((r: string) => `- ${r}`).join("\n") || "Standard parameters"}

## Sector Favors
${briefing.sectorFavors?.map((s: string) => `- ${s}`).join("\n") || "None specified"}

## Sector Avoids
${briefing.sectorAvoids?.map((s: string) => `- ${s}`).join("\n") || "None specified"}
`, "research-agent");
    result.macroUpdated = true;
    details.push(`MACRO: ${briefing.bias.toUpperCase()} — ${briefing.summary.slice(0, 100)}`);
  } catch (err) {
    details.push(`Macro briefing failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  // 3. Volatility Environment
  try {
    const vixBars = await getHistoricalBars("^VIX", 30);
    if (vixBars.length > 0) {
      const currentVix = vixBars[vixBars.length - 1].c;
      const vixValues = vixBars.map((b) => b.c);
      const sortedVix = [...vixValues].sort((a, b) => a - b);
      const percentileIdx = sortedVix.findIndex((v) => v >= currentVix);
      const percentile = Math.round((percentileIdx / sortedVix.length) * 100);

      const prevVix = vixBars.length > 1 ? vixBars[vixBars.length - 2].c : currentVix;
      const termStructure = currentVix < prevVix ? "Contango (normal)" : "Backwardation (fear)";

      let volRegime = "NORMAL";
      if (currentVix > 30) volRegime = "HIGH";
      else if (currentVix > 25) volRegime = "ELEVATED";
      else if (currentVix < 15) volRegime = "LOW";

      await updateVolatilityEnvironment(currentVix, `${percentile}th`, termStructure, volRegime);
      result.volUpdated = true;
      details.push(`VIX: ${currentVix.toFixed(1)} (${percentile}th percentile, ${volRegime})`);
    }
  } catch (err) {
    details.push(`VIX update failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  // 4. Sector Rotation
  try {
    const sectors = ["XLK", "XLF", "XLE", "XLV", "XLI", "XLC", "XLY", "XLP", "XLU", "XLRE", "XLB"];
    const sectorData: { symbol: string; change1d: number; change5d: number }[] = [];

    for (const sym of sectors) {
      try {
        const bars = await getHistoricalBars(sym, 10);
        if (bars.length >= 5) {
          const latest = bars[bars.length - 1].c;
          const prev1d = bars[bars.length - 2].c;
          const prev5d = bars[bars.length - 5].c;
          sectorData.push({
            symbol: sym,
            change1d: ((latest - prev1d) / prev1d) * 100,
            change5d: ((latest - prev5d) / prev5d) * 100,
          });
        }
      } catch { /* skip individual sector failures */ }
    }

    if (sectorData.length > 0) {
      const sorted1d = [...sectorData].sort((a, b) => b.change1d - a.change1d);
      const sorted5d = [...sectorData].sort((a, b) => b.change5d - a.change5d);

      const content = `---
last_updated: "${today}"
updated_by: "research-agent"
---

# Sector Relative Strength

## 1-Day Performance
| Sector | 1D Change |
|--------|-----------|
${sorted1d.map((s) => `| ${s.symbol} | ${s.change1d >= 0 ? "+" : ""}${s.change1d.toFixed(2)}% |`).join("\n")}

## 5-Day Performance
| Sector | 5D Change |
|--------|-----------|
${sorted5d.map((s) => `| ${s.symbol} | ${s.change5d >= 0 ? "+" : ""}${s.change5d.toFixed(2)}% |`).join("\n")}

## Leaders (Momentum)
${sorted5d.slice(0, 3).map((s) => `- **${s.symbol}**: +${s.change5d.toFixed(2)}% (5D)`).join("\n")}

## Laggards (Potential Mean Reversion)
${sorted5d.slice(-3).map((s) => `- **${s.symbol}**: ${s.change5d.toFixed(2)}% (5D)`).join("\n")}
`;
      await vaultWrite("Research/sectors.md", content, "research-agent");
      result.sectorsUpdated = true;
      details.push(`SECTORS: Leaders: ${sorted5d.slice(0, 2).map((s) => s.symbol).join(", ")}, Laggards: ${sorted5d.slice(-2).map((s) => s.symbol).join(", ")}`);
    }
  } catch (err) {
    details.push(`Sector scan failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  return result;
}
