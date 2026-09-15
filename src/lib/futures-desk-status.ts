// FUTURES DESK — the page's one read. Ledger, per-edge scoreboard with the shared verdict, the
// alert inbox, the broker snapshot and the desk's own state. Read-only.
import { prisma } from "@/lib/db";
import { EDGES, deskVerdict, tStatOf } from "@/lib/futures-desk-rules";
import { deskEnabled, deskLimits, ensureDeskTables, ledgerRows, loadState, openTrades, rawRows, type TradeRow } from "@/lib/futures-desk";
import { ANOMALY_KEY, FEED_SEEN_KEY, cfg } from "@/lib/futures-desk-store";
import { feedStale, parseAnomaly } from "@/lib/futures-desk-safety";
import { mergeRollChains } from "@/lib/futures-desk-review";
import { reviewSnapshot } from "@/lib/futures-desk-review-jobs";
import { deskBalance, deskOrders, deskPositions, isWorking } from "@/lib/tradovate-desk";

// The roll-chain fold moved to futures-desk-review.ts (E6); the stage route and the tests keep this import.
export { mergeRollChains };

export interface EdgeCard {
  key: string; name: string; timeframe: string; roots: string[]; evidence: string;
  resolved: number; open: number; wins: number; net: number; meanR: number | null; tStat: number | null; days: number; verdict: string;
}

export async function edgeScoreboard(): Promise<EdgeCard[]> {
  await ensureDeskTables();
  const raw = await rawRows<{ id: number; edge: string; status: string; exit_reason: string | null; pnl_usd: number | null; risk_usd: number; rolled_from: number | null; opened_at: string; closed_at: string | null }>(
    `SELECT id, edge, status, exit_reason, pnl_usd, risk_usd, rolled_from, opened_at, closed_at FROM futures_desk_trades`);
  const rows = mergeRollChains(raw);
  return EDGES.map((e) => {
    const mine = rows.filter((r) => r.edge === e.key);
    const closed = mine.filter((r) => r.status === "closed" && r.pnl_usd != null);
    const rs = closed.map((r) => (r.risk_usd > 0 ? (r.pnl_usd as number) / r.risk_usd : 0));
    const net = closed.reduce((s, r) => s + (r.pnl_usd as number), 0);
    const times = closed.map((r) => Date.parse(r.closed_at ?? r.opened_at)).filter(Number.isFinite);
    const days = times.length ? Math.max(1, Math.round((Math.max(...times) - Math.min(...times)) / 86_400_000)) : 0;
    const t = tStatOf(rs);
    return {
      key: e.key, name: e.name, timeframe: e.timeframe, roots: e.roots, evidence: e.evidence,
      resolved: closed.length, open: mine.filter((r) => r.status === "open").length, wins: closed.filter((r) => (r.pnl_usd as number) > 0).length,
      net, meanR: rs.length ? rs.reduce((s, v) => s + v, 0) / rs.length : null, tStat: t, days, verdict: deskVerdict(closed.length, net, t, days),
    };
  });
}

export async function deskStatus() {
  await ensureDeskTables();
  const [enabled, limits, state, open, cards] = await Promise.all([deskEnabled(), deskLimits(), loadState(), openTrades(), edgeScoreboard()]);
  // The leaderboard, the promotion gate and stage readiness (E6) — read-only, from the whole ledger; a failure here is a field, not a 500.
  const review = await reviewSnapshot(limits).catch((e) => ({ error: String(e).slice(0, 200) }));
  const ledger: TradeRow[] = await ledgerRows(60);
  // Watch rows are context, not inbox: the inbox stays the desk's decisions; the last ten watches ride separately.
  const signalCols = `id, received_at, edge, root, action, side, price, stop, status, reason, trade_id`;
  type SignalRow = { id: number; received_at: string; edge: string; root: string; action: string; side: string; price: number; stop: number | null; status: string; reason: string | null; trade_id: number | null };
  const [signals, watch, anomalyRaw, feedSeenAt] = await Promise.all([
    rawRows<SignalRow>(`SELECT ${signalCols} FROM futures_desk_signals WHERE action <> 'watch' ORDER BY id DESC LIMIT 40`),
    rawRows<SignalRow>(`SELECT ${signalCols} FROM futures_desk_signals WHERE action = 'watch' ORDER BY id DESC LIMIT 10`),
    cfg(ANOMALY_KEY), cfg(FEED_SEEN_KEY),
  ]);
  const entriesRow = await prisma.$queryRawUnsafe<{ n: bigint | number }[]>(`SELECT count(*) AS n FROM futures_desk_trades WHERE rolled_from IS NULL AND (opened_at AT TIME ZONE 'America/New_York')::date = (now() AT TIME ZONE 'America/New_York')::date`);
  const entriesToday = Number(entriesRow[0]?.n ?? 0);
  let broker: { balance: number; netLiq: number; positions: { contractId: number; netPos: number; netPrice: number }[]; workingOrders: number } | null = null;
  let brokerError: string | null = null;
  try {
    const [bal, pos, orders] = await Promise.all([deskBalance(), deskPositions(), deskOrders()]);
    broker = { balance: bal.balance, netLiq: bal.netLiq, positions: pos.map((p) => ({ contractId: p.contractId, netPos: p.netPos, netPrice: p.netPrice })), workingOrders: orders.filter(isWorking).length };
  } catch (e) { brokerError = String(e).slice(0, 200); }
  const guardianAgeMs = state.guardianAt ? Date.now() - Date.parse(state.guardianAt) : null;
  const closed = mergeRollChains(ledger).filter((t) => t.status === "closed" && t.pnl_usd != null);
  return {
    enabled, disabledReason: state.disabledReason ?? null, limits, state, entriesToday, guardian: { at: state.guardianAt ?? null, fresh: guardianAgeMs != null && guardianAgeMs < 20 * 60_000, lastError: state.lastError ?? null },
    broker, brokerError, open, ledger, signals, watch, cards,
    anomaly: parseAnomaly(anomalyRaw),                                   // entries paused until cleared (type CLEAR)
    feedSeenAt, feedStale: feedStale(feedSeenAt, Date.now()),            // the TradingView heartbeat; a NO TRADE chip, never a refusal
    record: { trades: closed.length, wins: closed.filter((t) => (t.pnl_usd as number) > 0).length, pnl: closed.reduce((s, t) => s + (t.pnl_usd as number), 0) },
    leaderboard: "error" in review ? null : review.leaderboard, promotion: "error" in review ? null : review.promotion, stageReadiness: "error" in review ? null : review.readiness,
    reviewError: "error" in review ? review.error : null,
    webhookPath: "/api/webhook/tradingview-futures",
    configured: !!(process.env.TRADOVATE_USERNAME && process.env.TRADINGVIEW_WEBHOOK_SECRET),
  };
}
