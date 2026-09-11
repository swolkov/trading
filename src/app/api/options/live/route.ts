import { readAccountSnapshot, readLiveSnapshot, quoteStoreFreshness } from "@/lib/options-quote-store";
import { barsStoreFreshness } from "@/lib/options-bars-store";
import { OPTIONS_SYMBOLS } from "@/lib/options-paper-model";
import { prisma } from "@/lib/db";

// The real Robinhood account, as the desk session last pushed it — the counterpart of the
// Kraken Live Account page. Everything here is a SNAPSHOT with an age: the app holds no
// Robinhood credentials, so it cannot read the broker itself, and it never places an order.
export const dynamic = "force-dynamic";

export async function GET() {
  const [account, live, quoteStore, barsStore, lastRun] = await Promise.all([
    readAccountSnapshot().catch(() => null),
    readLiveSnapshot().catch(() => null),
    quoteStoreFreshness().catch(() => ({ newestQuoteTs: null, rows: 0, ageMinutes: null, stale: true })),
    barsStoreFreshness([...OPTIONS_SYMBOLS]).catch(() => ({ symbols: 0, newestDay: null, oldestNewestDay: null, staleSymbols: [], stale: true })),
    prisma.agentConfig.findUnique({ where: { key: "options_scan_last_run" } }).then((r) => r?.value ?? null).catch(() => null),
  ]);
  // Anything the desk did not put there. The runner's allowlist has no order tool, so a
  // non-"user" agent on an order is the one thing on this page that should never appear.
  const foreignOrders = (live?.orders ?? []).filter((o) => o.placedAgent && o.placedAgent !== "user");
  return Response.json({
    account, live, quoteStore, barsStore, lastRun,
    foreignOrders,
    // Plain statement of what can and cannot happen here, for the page to show verbatim.
    execution: {
      canPlaceOrders: false,
      why: "The app holds no Robinhood credentials, and the scheduled desk session runs with every order tool disallowed. Going live on Robinhood is a separate build: an executor inside the desk session, its own arm switch, its own guardian — none of which exists today.",
    },
  });
}
