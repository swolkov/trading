import { prisma } from "@/lib/db";

// System-health API for the Kraken-only era (futures meta-agents retired Aug 2026).
// Reads live DB state every call — must never be statically cached.
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const configs = await prisma.agentConfig.findMany();
    const configMap: Record<string, string> = {};
    for (const c of configs) configMap[c.key] = c.value;

    // Capital-flows freshness read DIRECTLY from the stored row — the resolver's own
    // asOf is absent on its fallback path, which would report "fresh" during exactly
    // the failure this exists to catch.
    let flowsAsOf: string | null = null;
    try {
      const flows = configMap.kraken_capital_flows ? JSON.parse(configMap.kraken_capital_flows) : null;
      flowsAsOf = flows?.asOf || null;
    } catch { /* leave null */ }

    // Run lock: "" = released (healthy); a timestamp = held since then. A held lock
    // older than its 5-minute TTL means a run died mid-flight.
    const lockRow = configMap.kraken_run_lock;
    const lockHeldSince = lockRow ? lockRow : null;

    const recentOrders = await prisma.autoTradeLog.findMany({
      where: { symbol: { startsWith: "KRK:" } },
      orderBy: { createdAt: "desc" },
      take: 10,
    });

    return Response.json({
      heartbeats: {
        krakenCron: configMap.kraken_cron_last_run || null,
        krakenAgent: configMap.kraken_last_run || null,
        marginWatch: configMap.margin_watch_last_run || null,
        tradeSync: configMap.margin_trades_synced_at || null,
        tradingViewAlert: configMap.tradingview_last_alert || null,
      },
      flowsAsOf,
      runLock: {
        held: Boolean(lockHeldSince),
        since: lockHeldSince,
      },
      makerMisses: (() => {
        try { return configMap.kraken_maker_misses ? JSON.parse(configMap.kraken_maker_misses) : {}; } catch { return {}; }
      })(),
      config: {
        enabled: configMap.kraken_enabled !== "false",
        validateOnly: configMap.kraken_validate_only !== "false",
        makerOrders: configMap.kraken_maker_orders !== "false",
        marginAuto: configMap.kraken_margin_auto === "true",
      },
      recentOrders: recentOrders.map((t) => ({
        symbol: t.symbol.replace("KRK:", ""),
        action: t.action,
        usd: t.price,
        reason: t.reason,
        time: t.createdAt.toISOString(),
      })),
    });
  } catch (error) {
    console.error("[/api/command]", error);
    return Response.json({ error: String(error) }, { status: 500 });
  }
}
