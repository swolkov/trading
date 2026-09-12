// FUTURES DESK — the page's one read. Ledger, per-edge scoreboard with the shared verdict, the
// alert inbox, the broker snapshot and the desk's own state. Read-only.
import { prisma } from "@/lib/db";
import { EDGES, deskVerdict, tStatOf } from "@/lib/futures-desk-rules";
import { deskEnabled, deskLimits, ensureDeskTables, loadState, openTrades, type TradeRow } from "@/lib/futures-desk";
import { deskBalance, deskOrders, deskPositions, isWorking } from "@/lib/tradovate-desk";

export interface EdgeCard {
  key: string; name: string; timeframe: string; roots: string[]; evidence: string;
  resolved: number; open: number; wins: number; net: number; meanR: number | null; tStat: number | null; days: number; verdict: string;
}

export async function edgeScoreboard(): Promise<EdgeCard[]> {
  await ensureDeskTables();
  const rows = await prisma.$queryRawUnsafe<{ edge: string; status: string; pnl_usd: number | null; risk_usd: number; opened_at: string; closed_at: string | null }[]>(
    `SELECT edge, status, pnl_usd, risk_usd, opened_at, closed_at FROM futures_desk_trades`);
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
  const ledger = await prisma.$queryRawUnsafe<TradeRow[]>(`SELECT * FROM futures_desk_trades ORDER BY id DESC LIMIT 60`);
  const signals = await prisma.$queryRawUnsafe<{ id: number; received_at: string; edge: string; root: string; action: string; side: string; price: number; stop: number | null; status: string; reason: string | null; trade_id: number | null }[]>(
    `SELECT id, received_at, edge, root, action, side, price, stop, status, reason, trade_id FROM futures_desk_signals ORDER BY id DESC LIMIT 40`);
  let broker: { balance: number; netLiq: number; positions: { contractId: number; netPos: number; netPrice: number }[]; workingOrders: number } | null = null;
  let brokerError: string | null = null;
  try {
    const [bal, pos, orders] = await Promise.all([deskBalance(), deskPositions(), deskOrders()]);
    broker = { balance: bal.balance, netLiq: bal.netLiq, positions: pos.map((p) => ({ contractId: p.contractId, netPos: p.netPos, netPrice: p.netPrice })), workingOrders: orders.filter(isWorking).length };
  } catch (e) { brokerError = String(e).slice(0, 200); }
  const guardianAgeMs = state.guardianAt ? Date.now() - Date.parse(state.guardianAt) : null;
  const closed = ledger.filter((t) => t.status === "closed" && t.pnl_usd != null);
  return {
    enabled, disabledReason: state.disabledReason ?? null, limits, state, guardian: { at: state.guardianAt ?? null, fresh: guardianAgeMs != null && guardianAgeMs < 20 * 60_000, lastError: state.lastError ?? null },
    broker, brokerError, open, ledger, signals, cards,
    record: { trades: closed.length, wins: closed.filter((t) => (t.pnl_usd as number) > 0).length, pnl: closed.reduce((s, t) => s + (t.pnl_usd as number), 0) },
    webhookPath: "/api/webhook/tradingview-futures",
    configured: !!(process.env.TRADOVATE_USERNAME && process.env.TRADINGVIEW_WEBHOOK_SECRET),
  };
}
