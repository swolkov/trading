import { getLiveFuturesPnl } from "@/lib/live-pnl";

// Balance-based live-futures P&L (broker delta = netLiq − startingCapital − netDeposits) — the single
// source of truth for real-money live P&L. Exposed so CLIENT components (Track Record header, etc.) can
// read the authoritative number instead of summing autoTradeLog rows. When ok===false the broker was
// unreachable and callers should render "—", not the figure.
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const pnl = await getLiveFuturesPnl();
    return Response.json(pnl);
  } catch (error) {
    return Response.json({ ok: false, error: String(error) }, { status: 500 });
  }
}
