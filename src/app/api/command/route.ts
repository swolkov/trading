import { prisma } from "@/lib/db";
import { execLockHeldSince } from "@/lib/margin-live-risk";
import { quoteStoreFreshness, readAccountSnapshot, readLiveSnapshot } from "@/lib/options-quote-store";
import { barsStoreFreshness } from "@/lib/options-bars-store";
import { futuresHealth } from "@/lib/futures-health";
import { OPTIONS_SYMBOLS } from "@/lib/options-paper-model";

// Read-only telemetry for Kraken, Robinhood and the paper-only futures requirement.
// Missing or stale engine telemetry must not appear ready.
export const dynamic = "force-dynamic";

const EMPTY = {
  futures: futuresHealth({}),
  heartbeats: { marginScan: null, marginWatch: null, tradeSync: null, tradingViewAlert: null },
  config: { marginAuto: false, marginValidateOnly: true, shadowAutotrack: true, drawdownDisarmed: false },
  execLock: { held: false, since: null as string | null },
  paper: {
    optionsScan: null as string | null, stockScan: null as string | null,
    optionsAutotrack: false, stockAutotrack: true,
    robinhood: {
      newestQuoteTs: null as string | null, quoteAgeMinutes: null as number | null,
      quotesStale: true, quoteRows: 0, openPositions: 0,
      optionLevel: null as string | null, accountAt: null as string | null,
      barsNewestDay: null as string | null, barsStale: true, barsStaleSymbols: 0,
      liveAt: null as string | null, livePositions: 0, liveOrders: 0, liveForeignOrders: 0,
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
    const [quotes, account, bars, live] = await Promise.all([
      quoteStoreFreshness().catch(() => null),
      readAccountSnapshot().catch(() => null),
      barsStoreFreshness([...OPTIONS_SYMBOLS]).catch(() => null),
      readLiveSnapshot().catch(() => null),
    ]);

    return Response.json({
      futures: futuresHealth(c, Date.now(), Boolean(process.env.TRADOVATE_USERNAME && process.env.TRADINGVIEW_WEBHOOK_SECRET)),
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
        optionsAutotrack: false,
        stockAutotrack: c["stock_paper_autotrack"] !== "false",
        robinhood: {
          newestQuoteTs: quotes?.newestQuoteTs ?? null,
          quoteAgeMinutes: quotes?.ageMinutes ?? null,
          // Fail CLOSED: if the freshness read itself failed, call it stale rather than
          // healthy. An unknown state on a silent-failure path is not a green light.
          quotesStale: quotes ? quotes.stale : true,
          quoteRows: quotes?.rows ?? 0,
          openPositions: 0,
          optionLevel: account?.optionLevel ?? null,
          accountAt: account?.at ?? null,
          // The bars inbox (Robinhood daily bars) — a separate failure from stale quotes:
          // stale bars mean the SIGNAL is blind. Fail closed like the quotes.
          barsNewestDay: bars?.newestDay ?? null,
          barsStale: bars ? bars.stale : true,
          barsStaleSymbols: bars?.staleSymbols.length ?? 0,
          // The real account's positions/orders snapshot, and the one thing that must never
          // appear on it: an order placed by anything other than Spencer's own hand.
          liveAt: live?.at ?? null,
          livePositions: live?.positions.length ?? 0,
          liveOrders: live?.orders.length ?? 0,
          liveForeignOrders: (live?.orders ?? []).filter((o) => o.placedAgent && o.placedAgent !== "user").length,
        },
      },
    });
  } catch (error) {
    console.error("[/api/command]", error);
    // Shaped default + error flag: the page shows a banner instead of crashing on undefined.
    return Response.json({ ...EMPTY, error: String(error) }, { status: 200 });
  }
}
