// FUTURES DESK — the page's one read. Ledger, per-edge scoreboard with the shared verdict, the
// alert inbox, the broker snapshot and the desk's own state. Read-only.
import { prisma } from "@/lib/db";
import { EDGES, deskVerdict, tStatOf } from "@/lib/futures-desk-rules";
import { deskEnabled, deskLimits, ensureDeskTables, ledgerRows, loadState, openTrades, rawRows, type TradeRow } from "@/lib/futures-desk";
import { deskBalance, deskOrders, deskPositions, isWorking } from "@/lib/tradovate-desk";

export interface EdgeCard {
  key: string; name: string; timeframe: string; roots: string[]; evidence: string;
  resolved: number; open: number; wins: number; net: number; meanR: number | null; tStat: number | null; days: number; verdict: string;
}

/** A rolled position is ONE trade: fold each leg that ended in a roll into its successor, so the
 *  scoreboard counts the round trip once with the summed P&L, and an open successor keeps the
 *  whole chain open. */
export function mergeRollChains<T extends { id: number; status: string; exit_reason: string | null; pnl_usd: number | null; rolled_from: number | null }>(rows: T[]): T[] {
  const byId = new Map(rows.map((r) => [r.id, { ...r }]));
  const successorOf = new Map<number, number>();
  for (const r of rows) if (r.rolled_from != null) successorOf.set(r.rolled_from, r.id);
  const out: T[] = [];
  for (const r of rows) {
    if (r.exit_reason === "roll" && successorOf.has(r.id)) continue;      // folded into its successor
    let pnl = r.pnl_usd ?? 0, from = r.rolled_from, complete = r.status === "closed" && r.pnl_usd != null;
    while (from != null) { const leg = byId.get(from); if (!leg) break; if (leg.pnl_usd == null) complete = false; pnl += leg.pnl_usd ?? 0; from = leg.rolled_from; }
    out.push({ ...r, pnl_usd: r.status === "closed" ? (complete ? pnl : null) : r.pnl_usd });
  }
  return out;
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
  const ledger: TradeRow[] = await ledgerRows(60);
  const signals = await rawRows<{ id: number; received_at: string; edge: string; root: string; action: string; side: string; price: number; stop: number | null; status: string; reason: string | null; trade_id: number | null }>(
    `SELECT id, received_at, edge, root, action, side, price, stop, status, reason, trade_id FROM futures_desk_signals ORDER BY id DESC LIMIT 40`);
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
    broker, brokerError, open, ledger, signals, cards,
    record: { trades: closed.length, wins: closed.filter((t) => (t.pnl_usd as number) > 0).length, pnl: closed.reduce((s, t) => s + (t.pnl_usd as number), 0) },
    webhookPath: "/api/webhook/tradingview-futures",
    configured: !!(process.env.TRADOVATE_USERNAME && process.env.TRADINGVIEW_WEBHOOK_SECRET),
  };
}
