import { prisma } from "@/lib/db";

// System-health API for the Kraken MARGIN era. The spot trend bot was retired Aug 31 2026, so
// this monitors the machinery that's actually live: the margin scanner + guardian crons, trade
// sync, the TradingView webhook, and the margin executor's arm-state + drawdown breaker + lock.
// Reads live DB state every call — never statically cached. Returns a fully-shaped body even on
// error so the page never white-screens.
export const dynamic = "force-dynamic";

const EMPTY = {
  heartbeats: { marginScan: null, marginWatch: null, tradeSync: null, tradingViewAlert: null },
  config: { marginAuto: false, marginValidateOnly: true, shadowAutotrack: true, drawdownDisarmed: false },
  execLock: { held: false, since: null as string | null },
};

export async function GET() {
  try {
    const configs = await prisma.agentConfig.findMany();
    const c: Record<string, string> = {};
    for (const row of configs) c[row.key] = row.value;

    // Margin executor lock: "" = released (healthy); a timestamp = held since then (only while
    // placing a real order). A held lock older than its 120s TTL means a run died mid-flight.
    const lock = c["kraken_margin_exec_lock"];
    const lockHeld = Boolean(lock && lock !== "");

    return Response.json({
      heartbeats: {
        marginScan: c["margin_scan_last_run"] || null,
        marginWatch: c["margin_watch_last_run"] || null,
        tradeSync: c["margin_trades_synced_at"] || null,
        tradingViewAlert: c["tradingview_last_alert"] || null,
      },
      config: {
        // Fail-closed reads, matching the executor's own gating (unset/garbage → safe).
        marginAuto: c["kraken_margin_auto"] === "true",
        marginValidateOnly: c["kraken_margin_validate_only"] !== "false", // default ON (safe)
        shadowAutotrack: c["kraken_shadow_autotrack"] !== "false",        // default ON
        drawdownDisarmed: c["kraken_margin_disarmed_dd"] === "true",
      },
      execLock: { held: lockHeld, since: lockHeld ? lock : null },
    });
  } catch (error) {
    console.error("[/api/command]", error);
    // Shaped default + error flag: the page shows a banner instead of crashing on undefined.
    return Response.json({ ...EMPTY, error: String(error) }, { status: 200 });
  }
}
