import { getLiveFuturesStats } from "@/lib/live-pnl";

// The single source of truth for real-money live-futures P&L + performance stats. `netPnl` is the
// broker balance delta (netLiq − startingCapital − netDeposits); every trade stat (count, win rate,
// avg win/loss, best/worst, recent windows) is derived from the same clean incident-excluded round-trip
// set. Exposed so CLIENT components (Track Record header, the Futures Performance panel) read ONE
// authoritative object instead of summing autoTradeLog rows or mixing session-fill data. When
// ok===false the broker was unreachable and callers should render "—" for the balance figures.
// (Superset of the old shape, so existing readers of netPnl/roundTrips/winRate still work.)
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const stats = await getLiveFuturesStats();
    return Response.json(stats);
  } catch (error) {
    return Response.json({ ok: false, error: String(error) }, { status: 500 });
  }
}
