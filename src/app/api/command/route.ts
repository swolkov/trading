import { prisma } from "@/lib/db";
import { execLockHeldSince } from "@/lib/margin-live-risk";
import { quoteStoreFreshness, readAccountSnapshot } from "@/lib/options-quote-store";
import { OPTIONS_COHORT_SQL } from "@/lib/options-paper-model";

// System-health API. Two halves, because there are now two kinds of failure.
//
// KRAKEN (real money): the margin scanner + guardian crons, trade sync, the TradingView
// webhook, and the executor's arm-state + drawdown breaker + lock.
//
// THE PAPER DESKS (Sep 10 2026): the stock and options books. The options book is the one
// that needs watching from here rather than only from its own page, because its data path is
// a scheduled agent on Spencer's Mac — Robinhood has no server credentials. If that agent
// stops, the book silently freezes: positions stop marking, stops go unchecked, and every
// page still renders perfectly. A stale quote inbox is therefore a first-class heartbeat,
// exactly like a dead cron.
// Reads live DB state every call — never statically cached. Returns a fully-shaped body even on
// error so the page never white-screens.
export const dynamic = "force-dynamic";

const EMPTY = {
  heartbeats: { marginScan: null, marginWatch: null, tradeSync: null, tradingViewAlert: null },
  config: { marginAuto: false, marginValidateOnly: true, shadowAutotrack: true, drawdownDisarmed: false },
  execLock: { held: false, since: null as string | null },
  paper: {
    optionsScan: null as string | null, stockScan: null as string | null,
    optionsAutotrack: true, stockAutotrack: true,
    robinhood: {
      newestQuoteTs: null as string | null, quoteAgeMinutes: null as number | null,
      quotesStale: true, quoteRows: 0, openPositions: 0,
      optionLevel: null as string | null, accountAt: null as string | null,
    },
  },
};

export async function GET() {
  try {
    const configs = await prisma.agentConfig.findMany();
    const c: Record<string, string> = {};
    for (const row of configs) c[row.key] = row.value;

    // Margin executor lock: "" = released; `${iso}#token` = held. Older than 330s TTL
    // means a run died mid-flight (webhook maxDuration is 300s; lock must outlive it).
    const lock = c["kraken_margin_exec_lock"];
    const lockSince = execLockHeldSince(lock);
    const lockHeld = Boolean(lock && lock !== "");

    // Paper-desk health. Each read is independently caught: a paper book being unreachable
    // must never blank out the Kraken heartbeats, which are the ones tied to real money.
    const [quotes, account, openOpts] = await Promise.all([
      quoteStoreFreshness().catch(() => null),
      readAccountSnapshot().catch(() => null),
      prisma.$queryRawUnsafe<{ n: bigint }[]>(
        `SELECT count(*)::bigint AS n FROM options_paper_trades WHERE status='open' AND ${OPTIONS_COHORT_SQL}`,
      ).then((r) => Number(r[0]?.n ?? 0)).catch(() => 0),
    ]);

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
      execLock: { held: lockHeld, since: lockHeld ? lockSince : null },
      paper: {
        optionsScan: c["options_scan_last_run"] || null,
        stockScan: c["stock_scan_last_run"] || null,
        optionsAutotrack: c["options_paper_autotrack"] !== "false",
        stockAutotrack: c["stock_paper_autotrack"] !== "false",
        robinhood: {
          newestQuoteTs: quotes?.newestQuoteTs ?? null,
          quoteAgeMinutes: quotes?.ageMinutes ?? null,
          // Fail CLOSED: if the freshness read itself failed, call it stale rather than
          // healthy. An unknown state on a silent-failure path is not a green light.
          quotesStale: quotes ? quotes.stale : true,
          quoteRows: quotes?.rows ?? 0,
          openPositions: openOpts,
          optionLevel: account?.optionLevel ?? null,
          accountAt: account?.at ?? null,
        },
      },
    });
  } catch (error) {
    console.error("[/api/command]", error);
    // Shaped default + error flag: the page shows a banner instead of crashing on undefined.
    return Response.json({ ...EMPTY, error: String(error) }, { status: 200 });
  }
}
