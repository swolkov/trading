import { getTopMovers, getMostActives, getNews } from "@/lib/alpaca";
import { getHistoricalBars } from "@/lib/yahoo";
import { generateMacroBriefing } from "@/lib/macro-briefing";
import { detectMarketRegime } from "@/lib/market-regime";
import { scanSector, SECTOR_UNIVERSES } from "@/lib/sector-scanner";
import { prisma } from "@/lib/db";
import { sendNotification } from "@/lib/notifications";

export const maxDuration = 120;

// ============ PRE-MARKET RESEARCH AGENT ============
// Runs at 9:00 AM ET (13:00 UTC) before market open.
// Scans overnight news, pre-market movers, prepares the day's watchlist,
// and sends a morning briefing notification.

export async function GET(request: Request) {
  const authHeader = request.headers.get("authorization");
  if (process.env.CRON_SECRET && authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const details: string[] = [];

    // 1. Market regime
    let regimeSummary = "";
    try {
      const regime = await detectMarketRegime();
      regimeSummary = `REGIME: ${regime.regime.toUpperCase()} — ${regime.recommendation}`;
      details.push(regimeSummary);
    } catch {
      details.push("REGIME: Unable to detect");
    }

    // 2. Macro briefing
    let macroBriefingSummary = "";
    try {
      const briefing = await generateMacroBriefing();
      macroBriefingSummary = `MACRO: ${briefing.bias.toUpperCase()} — ${briefing.summary}`;
      details.push(macroBriefingSummary);
      if (briefing.tradingRules.length > 0) {
        details.push(`RULES: ${briefing.tradingRules.join(" | ")}`);
      }
    } catch {
      details.push("MACRO: Unable to generate");
    }

    // 3. Overnight news for focus symbols
    let newsHighlights: string[] = [];
    try {
      const focusConfig = await prisma.agentConfig.findUnique({ where: { key: "focus_symbols" } });
      const focusSymbols = focusConfig?.value?.split(",").map((s) => s.trim()).filter(Boolean) || [];

      if (focusSymbols.length > 0) {
        const news = await getNews(focusSymbols.slice(0, 10), 10);
        const overnight = news.filter((n) => {
          const newsTime = new Date(n.created_at);
          const hoursSince = (Date.now() - newsTime.getTime()) / (1000 * 60 * 60);
          return hoursSince <= 16; // last 16 hours (since previous close)
        });

        for (const n of overnight.slice(0, 5)) {
          const headline = `${n.symbols?.join(", ") || "?"}: ${n.headline}`;
          newsHighlights.push(headline);
          details.push(`NEWS: ${headline}`);
        }
      }
    } catch { /* ignore */ }

    // 4. Sector scan
    let sectorInsights: string[] = [];
    try {
      const activeSectors = ["ai_capex"]; // primary sector
      for (const key of activeSectors) {
        if (!SECTOR_UNIVERSES[key]) continue;
        const scan = await scanSector(key);
        const insight = `${scan.sectorHealth.sectorName}: ${scan.sectorHealth.signal.replace(/_/g, " ").toUpperCase()} — ${scan.sectorHealth.summary.slice(0, 150)}`;
        sectorInsights.push(insight);
        details.push(`SECTOR: ${insight}`);

        // Top candidates for today
        const topCandidates = scan.candidates.slice(0, 5);
        if (topCandidates.length > 0) {
          details.push(`TOP CANDIDATES: ${topCandidates.map((c) => `${c.symbol} (score ${c.score}, ${c.direction})`).join(", ")}`);
        }
      }
    } catch { /* ignore */ }

    // 5. Check existing positions for overnight gaps
    let positionAlerts: string[] = [];
    try {
      const positions = await prisma.autoTradeLog.findMany({
        where: { action: { in: ["buy", "buy_call", "buy_put", "iron_condor", "sell_bull_put", "sell_bear_call"] }, pnl: null },
        orderBy: { createdAt: "desc" },
        take: 20,
      });

      const uniqueSymbols = [...new Set(positions.map((p) => {
        const match = p.symbol.match(/^([A-Z]+)/);
        return match ? match[1] : p.symbol;
      }))];

      for (const sym of uniqueSymbols.slice(0, 10)) {
        try {
          const bars = await getHistoricalBars(sym, 5);
          if (bars.length >= 2) {
            const prevClose = bars[bars.length - 2].c;
            const lastClose = bars[bars.length - 1].c;
            const gapPct = ((lastClose - prevClose) / prevClose) * 100;
            if (Math.abs(gapPct) >= 2) {
              const alert = `${sym} gapped ${gapPct >= 0 ? "+" : ""}${gapPct.toFixed(1)}% overnight`;
              positionAlerts.push(alert);
              details.push(`GAP ALERT: ${alert}`);
            }
          }
        } catch { /* ignore */ }
      }
    } catch { /* ignore */ }

    // 6. Build morning briefing
    const briefing = [
      `MORNING BRIEFING — ${new Date().toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric" })}`,
      "",
      regimeSummary,
      macroBriefingSummary,
      "",
      newsHighlights.length > 0 ? `OVERNIGHT NEWS:\n${newsHighlights.map((n) => `  - ${n}`).join("\n")}` : "No major overnight news",
      "",
      sectorInsights.length > 0 ? `SECTORS:\n${sectorInsights.map((s) => `  - ${s}`).join("\n")}` : "",
      "",
      positionAlerts.length > 0 ? `POSITION ALERTS:\n${positionAlerts.map((a) => `  - ${a}`).join("\n")}` : "No overnight gaps on held positions",
    ].filter(Boolean).join("\n");

    // Send notification
    try {
      await sendNotification(briefing.slice(0, 2000), "general");
    } catch { /* ignore */ }

    // Log the pre-market run
    await prisma.agentRun.create({
      data: {
        runType: "premarket",
        stocksScanned: 0,
        tradesPlaced: 0,
        positionsManaged: 0,
        errors: 0,
        summary: `Pre-market briefing: ${regimeSummary}. ${newsHighlights.length} news items. ${positionAlerts.length} gap alerts.`,
        durationMs: 0,
      },
    });

    return Response.json({ status: "ok", briefing, details });
  } catch (error) {
    console.error("[premarket]", error);
    return Response.json({ error: String(error) }, { status: 500 });
  }
}
