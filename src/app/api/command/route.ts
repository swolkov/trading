import { prisma } from "@/lib/db";
import { quoteStoreFreshness, readAccountSnapshot, readLiveSnapshot } from "@/lib/options-quote-store";
import { barsStoreFreshness } from "@/lib/options-bars-store";
import { futuresHealth } from "@/lib/futures-health";
import { OPTIONS_SYMBOLS } from "@/lib/options-paper-model";

// Read-only telemetry for Robinhood options and the paper-only futures desk. The Kraken
// margin desk was retired Sep 19 2026; its heartbeats and switches are gone with it.
// Missing or stale engine telemetry must not appear ready.
export const dynamic = "force-dynamic";

const EMPTY = {
  room: { lastTickAt: null as string | null, lastError: null as string | null, liveOk: false, liveAt: null as string | null, levelsAt: null as string | null, breakAt: null as string | null, ledgerAt: null as string | null },
  futures: futuresHealth({}),
  heartbeats: { tradingViewAlert: null as string | null },
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

    // Each read is independently caught: one store being unreachable must never blank out
    // the others.
    const [quotes, account, bars, live] = await Promise.all([
      quoteStoreFreshness().catch(() => null),
      readAccountSnapshot().catch(() => null),
      barsStoreFreshness([...OPTIONS_SYMBOLS]).catch(() => null),
      readLiveSnapshot().catch(() => null),
    ]);

    // The Trading Room (his live account, read-only): the tick, the live read, the chart's last level post, the last break.
    const j = (k: string) => { try { return JSON.parse(c[k] ?? "null"); } catch { return null; } };
    const roomState = j("trading_room_state") as { lastTickAt?: string; lastError?: string } | null;
    const roomLive = j("trading_room_live") as { at?: string; ok?: boolean } | null;
    const roomLevels = j("trading_room_chart_levels") as Record<string, { receivedAt?: string }> | null;
    const roomFeed = j("trading_room_feed") as { receivedAt?: string }[] | null;
    const levelsAt = roomLevels ? Object.values(roomLevels).map((x) => x?.receivedAt ?? "").filter(Boolean).sort().pop() ?? null : null;
    const room = {
      lastTickAt: roomState?.lastTickAt ?? null, lastError: roomState?.lastError ?? null,
      liveOk: roomLive?.ok === true, liveAt: roomLive?.at ?? null, levelsAt, breakAt: roomFeed?.[0]?.receivedAt ?? null, ledgerAt: null as string | null,
    };

    return Response.json({
      room,
      futures: futuresHealth(c, Date.now(), Boolean(process.env.TRADOVATE_USERNAME && process.env.TRADINGVIEW_WEBHOOK_SECRET)),
      heartbeats: {
        tradingViewAlert: c["tradingview_last_alert"] || null,
      },
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
          // The live desk on the Mac: the switch, the adapter verification, the guardian heartbeat.
          liveDesk: {
            armed: c["options_live_armed"] === "true",
            verified: c["options_live_integration_verified"] === "true",
            guardianAt: c["options_live_guardian_ok_at"] || null,
            guardianFresh: !!c["options_live_guardian_ok_at"] && Date.now() - Date.parse(c["options_live_guardian_ok_at"]) < 10 * 60_000,
          },
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
