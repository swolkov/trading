// FUTURES DESK — the I/O half: the alert inbox, the ledger, entries on the Tradovate DEMO account
// and the guardian that manages what is open. Rules and sizing are in futures-desk-rules.ts (pure).
//
// ISOLATION: raw-SQL tables (never prisma-managed, so a schema push cannot drop them), config
// keys prefixed `futures_desk_`, state in one AgentConfig JSON row, and no import from any
// margin-*, kraken-*, prop-* or options-* module. Broker calls go through tradovate-desk.ts,
// which pins the demo account.
//
// THE INVARIANTS (review round 1, Sep 12 2026, found a path breaking each of these):
//   • A position always has exactly ONE working stop. A stop that cannot be placed or re-anchored
//     means the position is CLOSED, not "alerted about". A closed position never leaves a stop
//     working (a leftover GTC stop opens a reverse position on the next touch).
//   • An order is never sent twice for one signal: the clOrdId is looked up BEFORE placing.
//   • Raw reads normalise types at the boundary: Postgres bigint arrives as JS BigInt and
//     timestamptz as Date — JSON.stringify throws on the first and `===` fails on both.
//   • Entries per day come from the LEDGER, not from a JSON counter two writers race over.
import { prisma } from "@/lib/db";
import { sendNotification } from "@/lib/notifications";
import {
  DEFAULT_LIMITS, EDGES, FEE_PER_SIDE_MICRO, MICRO_FOR_ROOT, cmeOpen, dedupeKey, edgeByKey, entryRefusal, etDayKey,
  roundToTick, sizeEntry, tradePnlUsd, type AlertPayload, type DeskContext, type DeskLimits, type Side,
} from "@/lib/futures-desk-rules";
import {
  avgFill, cancelDeskOrder, contractExpiry, deskBalance, deskContract, deskOrders, deskPositions, fillsForOrder,
  findOrderByClOrdId, forgetContract, isWorking, liquidate, modifyStop, orderItem, placeEntryWithStop, placeStop, rollGuardDays,
  type DxOrder,
} from "@/lib/tradovate-desk";

const STATE_KEY = "futures_desk_state";
const ENTRY_LOCK_KEY = "futures_desk_entry_lock";
const GUARD_LOCK_KEY = "futures_desk_guard_lock";
const ENTRY_LOCK_TTL_MS = 120_000;
const GUARD_LOCK_TTL_MS = 290_000;   // just under the cron route's maxDuration
const QUEUE_MAX_AGE_MS = 12 * 60 * 60_000;
const LANE = "futures_demo" as const;

export interface DeskState {
  guardianAt?: string;
  equity?: number;
  equityHigh?: number;
  dayKey?: string;
  dayStartEquity?: number;
  alerts: Record<string, string>;
  lastError?: string;
  disabledReason?: string;
}

export interface TradeRow {
  id: number; opened_at: string; edge: string; root: string; micro: string; contract: string; contract_id: number;
  side: Side; qty: number; entry_price: number; stop_price: number; entry_order_id: number | null; stop_order_id: number | null;
  cl_ord_id: string; signal_id: number | null; status: "open" | "closed" | "unknown"; exit_price: number | null;
  exit_order_id: number | null; closed_at: string | null; exit_reason: string | null; pnl_usd: number | null;
  fees_usd: number | null; risk_usd: number; point_value: number; rolled_from: number | null; note: string | null;
}

// ---- type normalisation at the raw-SQL boundary --------------------------------------------------
const BIGINT_COLS = ["entry_order_id", "stop_order_id", "exit_order_id"];
const DATE_COLS = ["opened_at", "closed_at", "received_at", "bar", "executed_at"];
export function normaliseRow<T extends object>(row: T): T {
  const out: Record<string, unknown> = { ...(row as Record<string, unknown>) };
  for (const k of BIGINT_COLS) if (typeof out[k] === "bigint") out[k] = Number(out[k]);
  for (const k of DATE_COLS) if (out[k] instanceof Date) out[k] = (out[k] as Date).toISOString();
  return out as T;
}
export async function rawRows<T extends object>(sql: string, ...params: unknown[]): Promise<T[]> {
  const rows = await prisma.$queryRawUnsafe<T[]>(sql, ...params);
  return rows.map(normaliseRow);
}

// ---- config / state ------------------------------------------------------------------------------
async function cfg(key: string): Promise<string | null> {
  const row = await prisma.agentConfig.findUnique({ where: { key } }).catch(() => null);
  return row?.value ?? null;
}
async function setKey(key: string, value: string): Promise<void> {
  await prisma.agentConfig.upsert({ where: { key }, update: { value }, create: { key, value } });
}
function num(v: string | null, fallback: number): number {
  const n = v == null ? NaN : parseFloat(v);
  return Number.isFinite(n) ? n : fallback;
}

export async function deskLimits(): Promise<DeskLimits> {
  const [basis, risk] = await Promise.all([cfg("futures_desk_sizing_basis"), cfg("futures_desk_risk_pct")]);
  return { ...DEFAULT_LIMITS, sizingBasisUsd: num(basis, DEFAULT_LIMITS.sizingBasisUsd), riskPct: Math.min(6, Math.max(0.25, num(risk, DEFAULT_LIMITS.riskPct))) };
}

export async function deskEnabled(): Promise<boolean> {
  return (await cfg("futures_desk_enabled")) === "true";
}

export async function loadState(): Promise<DeskState> {
  const raw = await cfg(STATE_KEY);
  if (!raw) return { alerts: {} };
  try { const s = JSON.parse(raw); return { alerts: {}, ...s }; } catch { return { alerts: {} }; }
}
async function saveState(s: DeskState): Promise<void> {
  await setKey(STATE_KEY, JSON.stringify(s));
}
/** Field-scoped write: load the freshest row, patch, save. */
async function patchState(patch: (s: DeskState) => void): Promise<void> {
  const s = await loadState(); patch(s); await saveState(s);
}
async function alertOnce(s: DeskState, key: string, text: string, everyMs = 60 * 60_000): Promise<void> {
  const last = s.alerts[key];
  if (last && Date.now() - Date.parse(last) < everyMs) return;
  await sendNotification(text, LANE).catch(() => {});
  s.alerts[key] = new Date().toISOString();
}

// ---- tables --------------------------------------------------------------------------------------
let tablesReady = false;
export async function ensureDeskTables(): Promise<void> {
  if (tablesReady) return;
  await prisma.$executeRawUnsafe(`CREATE TABLE IF NOT EXISTS futures_desk_signals (
    id serial PRIMARY KEY, received_at timestamptz DEFAULT now(), dedupe_key text UNIQUE, edge text, root text, action text,
    side text, price double precision, stop double precision, bar timestamptz, timeframe text, note text,
    status text, reason text, executed_at timestamptz, trade_id integer)`);
  await prisma.$executeRawUnsafe(`CREATE TABLE IF NOT EXISTS futures_desk_trades (
    id serial PRIMARY KEY, opened_at timestamptz DEFAULT now(), edge text, root text, micro text, contract text, contract_id integer,
    side text, qty integer, entry_price double precision, stop_price double precision, entry_order_id bigint, stop_order_id bigint,
    cl_ord_id text, signal_id integer, status text DEFAULT 'open', exit_price double precision, exit_order_id bigint,
    closed_at timestamptz, exit_reason text, pnl_usd double precision, fees_usd double precision, risk_usd double precision,
    point_value double precision, rolled_from integer, note text)`);
  tablesReady = true;
}

export async function openTrades(): Promise<TradeRow[]> {
  await ensureDeskTables();
  return rawRows<TradeRow>(`SELECT * FROM futures_desk_trades WHERE status = 'open' ORDER BY id`);
}
export async function ledgerRows(limit = 60): Promise<TradeRow[]> {
  await ensureDeskTables();
  return rawRows<TradeRow>(`SELECT * FROM futures_desk_trades ORDER BY id DESC LIMIT $1::int`, limit);
}
/** Entries opened today (ET), from the ledger — rolls are not entries. */
async function entriesToday(): Promise<number> {
  const day = etDayKey(new Date());
  const rows = await prisma.$queryRawUnsafe<{ n: bigint | number }[]>(
    `SELECT count(*) AS n FROM futures_desk_trades WHERE rolled_from IS NULL AND (opened_at AT TIME ZONE 'America/New_York')::date = $1::date`, day);
  return Number(rows[0]?.n ?? 0);
}

async function recordSignal(a: AlertPayload, status: string, reason: string): Promise<{ id: number; duplicate: boolean }> {
  await ensureDeskTables();
  const key = dedupeKey(a);
  const rows = await prisma.$queryRawUnsafe<{ id: number }[]>(
    `INSERT INTO futures_desk_signals (dedupe_key, edge, root, action, side, price, stop, bar, timeframe, note, status, reason)
     VALUES ($1,$2,$3,$4,$5,$6::float8,$7::float8,$8::timestamptz,$9,$10,$11,$12) ON CONFLICT (dedupe_key) DO NOTHING RETURNING id`,
    key, a.edge, a.root, a.action, a.side, a.price, a.stop, a.bar, a.timeframe, a.note, status, reason);
  if (rows.length) return { id: rows[0].id, duplicate: false };
  const existing = await prisma.$queryRawUnsafe<{ id: number }[]>(`SELECT id FROM futures_desk_signals WHERE dedupe_key = $1`, key);
  return { id: existing[0]?.id ?? 0, duplicate: true };
}
async function markSignal(id: number, status: string, reason: string, tradeId: number | null = null): Promise<void> {
  await prisma.$executeRawUnsafe(`UPDATE futures_desk_signals SET status = $2::text, reason = $3::text, executed_at = CASE WHEN $2::text IN ('executed','refused','error','expired') THEN now() ELSE executed_at END, trade_id = COALESCE($4::int, trade_id) WHERE id = $1`, id, status, reason.slice(0, 400), tradeId);
}

// ---- locks (compare-and-set on an AgentConfig row) --------------------------------------------------
async function acquireLock(key: string, ttlMs: number): Promise<string | null> {
  const token = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const now = Date.now();
  try {
    const row = await prisma.agentConfig.findUnique({ where: { key } });
    if (!row) { try { await prisma.agentConfig.create({ data: { key, value: `${token}@${now}` } }); return token; } catch { return null; } }
    const at = Number(row.value.split("@")[1] || 0);
    if (row.value && now - at < ttlMs) return null;
    const r = await prisma.agentConfig.updateMany({ where: { key, value: row.value }, data: { value: `${token}@${now}` } });
    return r.count === 1 ? token : null;
  } catch { return null; }
}
async function releaseLock(key: string, token: string): Promise<void> {
  try { const row = await prisma.agentConfig.findUnique({ where: { key } }); if (row?.value?.startsWith(token)) await setKey(key, ""); } catch { /* TTL */ }
}

// ---- alerts in ---------------------------------------------------------------------------------------
export type AlertOutcome = { status: string; reason: string; signalId: number; tradeId?: number };

/** The webhook's one call. Dedupes, then either executes now, queues for the reopen, or refuses.
 *  An exception never strands a signal in `received`: exits re-queue (a lost exit rides to the
 *  stop), entries are marked error. */
export async function handleAlert(a: AlertPayload): Promise<AlertOutcome> {
  const rec = await recordSignal(a, "received", "");
  if (rec.duplicate) return { status: "duplicate", reason: "same rule, market, action and bar already received", signalId: rec.id };
  // Exits queue too: a daily bar closes at 17:00 ET, inside the break, and a liquidation then is refused.
  if (!cmeOpen(new Date())) { await markSignal(rec.id, "queued", "CME closed — sent at the reopen by the guardian"); return { status: "queued", reason: "CME closed", signalId: rec.id }; }
  try {
    return a.action === "exit" ? await exitByRule(rec.id, a) : await enterFromSignal(rec.id, a);
  } catch (e) {
    const msg = String(e).slice(0, 200);
    if (a.action === "exit") { await markSignal(rec.id, "queued", `exit threw (${msg}) — the guardian retries`).catch(() => {}); return { status: "queued", reason: msg, signalId: rec.id }; }
    await markSignal(rec.id, "error", msg).catch(() => {});
    await sendNotification(`⚠️ FUTURES DESK ${a.root} ${a.edge}: entry threw — ${msg}. Check the account for an order with clOrdId fd-${rec.id}.`, LANE).catch(() => {});
    return { status: "error", reason: msg, signalId: rec.id };
  }
}

async function contextNow(s: DeskState): Promise<DeskContext> {
  const [open, n, enabled] = await Promise.all([openTrades(), entriesToday(), deskEnabled()]);
  const day = etDayKey(new Date());
  return {
    enabled: enabled && !s.disabledReason,
    openRoots: open.map((t) => t.root),
    entriesToday: n,
    dayPnlUsd: s.equity != null && s.dayStartEquity != null && s.dayKey === day ? s.equity - s.dayStartEquity : 0,
    equityUsd: s.equity ?? 0,
    equityHighUsd: s.equityHigh ?? 0,
    guardianFreshMs: s.guardianAt ? Date.now() - Date.parse(s.guardianAt) : null,
  };
}

/** Exactly one working stop, or no position. Returns the working stop id, or null when the
 *  position had to be closed because it could not be protected. */
async function ensureProtected(p: { contractId: number; contract: string; side: Side; qty: number; stopPx: number; stopOrderId: number | null; clOrdId: string; why: string }): Promise<number | null> {
  if (p.stopOrderId) { const o = await orderItem(p.stopOrderId); if (o && isWorking(o)) return p.stopOrderId; }
  const closeAction = p.side === "long" ? "Sell" : "Buy";
  const working = (await deskOrders()).filter((o) => o.contractId === p.contractId && isWorking(o) && o.orderType === "Stop" && o.action === closeAction);
  if (working.length) return working[0].id;
  try { return await placeStop({ contractId: p.contractId, action: closeAction, qty: p.qty, stopPrice: p.stopPx, clOrdId: `${p.clOrdId}-p${Date.now().toString(36)}` }); }
  catch (e) {
    const r = await liquidate(p.contractId).catch((err) => ({ orderId: null, failure: String(err) }));
    await sendNotification(`🛑 FUTURES DESK ${p.contract}: the stop could not be placed (${String(e).slice(0, 100)}) — ${p.why} — position CLOSED at market${r.failure ? ` (close refused: ${r.failure} — CHECK THE ACCOUNT)` : ""}.`, LANE).catch(() => {});
    return null;
  }
}

export async function enterFromSignal(signalId: number, a: AlertPayload): Promise<AlertOutcome> {
  const lock = await acquireLock(ENTRY_LOCK_KEY, ENTRY_LOCK_TTL_MS);
  if (!lock) { await markSignal(signalId, "queued", "another entry in flight — retried by the guardian"); return { status: "queued", reason: "entry lock busy", signalId }; }
  try {
    const [state, limits] = await Promise.all([loadState(), deskLimits()]);
    const refusal = entryRefusal(a, await contextNow(state), limits);
    if (refusal) { await markSignal(signalId, "refused", refusal); return { status: "refused", reason: refusal, signalId }; }
    const size = sizeEntry(a, limits);
    if (!size.ok) { await markSignal(signalId, "refused", size.reason); return { status: "refused", reason: size.reason, signalId }; }
    const contract = await deskContract(size.micro);
    if (!contract) { await markSignal(signalId, "error", `no ${size.micro} contract on Tradovate`); return { status: "error", reason: "contract", signalId }; }
    const stopDist = size.stopPoints;
    const action = a.side === "long" ? "Buy" : "Sell";
    const clOrdId = `fd-${signalId}`;

    // NEVER send the same signal twice: an order with this clOrdId (a previous attempt that threw
    // after the POST) is adopted instead of placed again.
    let orderId = 0, stopOrderId: number | null = null;
    const prior = await findOrderByClOrdId(clOrdId).catch(() => null);
    if (prior) orderId = prior.id;
    else {
      const provisional = roundToTick(a.stop!, contract.tickSize);   // re-anchored to the fill below
      try {
        const r = await placeEntryWithStop({ contractId: contract.id, action, qty: size.contracts, stopPrice: provisional, clOrdId });
        if (r.failure && !r.orderId) throw new Error(r.failure);
        orderId = r.orderId; stopOrderId = r.stopOrderId;
      } catch (e) {
        const found = await findOrderByClOrdId(clOrdId).catch(() => null);
        if (!found) {
          const msg = String(e).slice(0, 200);
          await markSignal(signalId, "error", msg);
          await sendNotification(`⚠️ FUTURES DESK ${a.root} ${a.edge}: entry refused by Tradovate — ${msg}`, LANE).catch(() => {});
          return { status: "error", reason: msg, signalId };
        }
        orderId = found.id;
      }
    }

    // Confirm the fill before recording a position. Market orders on the demo fill in ~1s.
    let fill = { qty: 0, price: 0 };
    for (let i = 0; i < 8 && fill.qty < size.contracts; i++) {
      await new Promise((r) => setTimeout(r, 750));
      fill = avgFill(await fillsForOrder(orderId));
      if (fill.qty === 0) { const o = await orderItem(orderId); if (o && (o.ordStatus === "Rejected" || o.ordStatus === "Canceled")) break; }
    }
    if (fill.qty === 0) {
      const o = await orderItem(orderId);
      if (o && isWorking(o)) await cancelDeskOrder(orderId).catch(() => {});
      const why = `entry ${orderId} did not fill (${o?.ordStatus ?? "unknown"})`;
      await markSignal(signalId, "refused", why);
      return { status: "refused", reason: why, signalId };
    }
    // A partial fill stops here: the remainder must not keep filling after the row is written.
    if (fill.qty < size.contracts) { const o = await orderItem(orderId); if (o && isWorking(o)) await cancelDeskOrder(orderId).catch(() => {}); }

    // Re-anchor the stop to the ACTUAL fill: the chart may be on a different month (basis) and the
    // fill may differ from the signal close. Risk is defined from where we got in.
    const stopPx = roundToTick(a.side === "long" ? fill.price - stopDist : fill.price + stopDist, contract.tickSize);
    if (stopOrderId) { try { await modifyStop(stopOrderId, fill.qty, stopPx); } catch { /* verified below */ } }
    const stopId = await ensureProtected({ contractId: contract.id, contract: contract.name, side: a.side, qty: fill.qty, stopPx, stopOrderId, clOrdId, why: "entry" });
    const spec = MICRO_FOR_ROOT[a.root];
    const riskUsd = fill.qty * size.riskPerContractUsd;
    const rows = await prisma.$queryRawUnsafe<{ id: number }[]>(
      `INSERT INTO futures_desk_trades (edge, root, micro, contract, contract_id, side, qty, entry_price, stop_price, entry_order_id, stop_order_id, cl_ord_id, signal_id, status, risk_usd, point_value, note, exit_reason)
       VALUES ($1,$2,$3,$4,$5::int,$6,$7::int,$8::float8,$9::float8,$10::bigint,$11::bigint,$12,$13::int,'open',$14::float8,$15::float8,$16,$17::text) RETURNING id`,
      a.edge, a.root, size.micro, contract.name, contract.id, a.side, fill.qty, fill.price, stopPx, orderId, stopId, clOrdId, signalId,
      riskUsd, spec.pointValue, fill.qty < size.contracts ? `partial fill ${fill.qty}/${size.contracts}` : a.note, stopId == null ? "unprotected" : null);
    const tradeId = rows[0].id;
    if (stopId == null) {
      // ensureProtected closed it; the guardian settles the round trip from the fills.
      await markSignal(signalId, "error", `filled ${fill.qty}× ${contract.name} but could not be protected — closed`, tradeId);
      return { status: "error", reason: "unprotected — closed", signalId, tradeId };
    }
    await markSignal(signalId, "executed", `${fill.qty}× ${contract.name} @ ${fill.price}`, tradeId);
    await sendNotification(`🟢 FUTURES DESK opened ${a.side.toUpperCase()} ${fill.qty}× ${contract.name} @ ${fill.price} · stop ${stopPx} · risk $${riskUsd.toFixed(0)} · ${a.edge}`, LANE).catch(() => {});
    return { status: "executed", reason: "", signalId, tradeId };
  } finally {
    await releaseLock(ENTRY_LOCK_KEY, lock);
  }
}

/** The rule's own exit (RSI ≥ 50, channel exit). */
async function exitByRule(signalId: number, a: AlertPayload): Promise<AlertOutcome> {
  const open = (await openTrades()).filter((t) => t.root === a.root && t.edge === a.edge);
  if (!open.length) { await markSignal(signalId, "refused", `no open ${a.edge} position in ${a.root}`); return { status: "refused", reason: "nothing to exit", signalId }; }
  const failed: string[] = [];
  for (const t of open) { const r = await closeTrade(t, "rule"); if (!r.ok) failed.push(`${t.contract}: ${r.failure}`); }
  if (failed.length) { await markSignal(signalId, "queued", `close refused (${failed.join("; ")}) — the guardian retries`); return { status: "queued", reason: failed.join("; "), signalId, tradeId: open[0].id }; }
  await markSignal(signalId, "executed", `closed ${open.length} position(s)`, open[0].id);
  return { status: "executed", reason: "", signalId, tradeId: open[0].id };
}

/** Cancel the stop FIRST (a late stop fill after the liquidation would open a reverse position),
 *  verify it is gone, then close at market. If the close is refused or throws, put the stop back. */
async function closeTrade(t: TradeRow, reason: string): Promise<{ ok: boolean; failure: string | null }> {
  let cancelled = false;
  if (t.stop_order_id) {
    const o = await orderItem(t.stop_order_id);
    if (o && isWorking(o)) {
      try { await cancelDeskOrder(t.stop_order_id); } catch (e) { return { ok: false, failure: `stop cancel failed: ${String(e).slice(0, 120)}` }; }
      const after = await orderItem(t.stop_order_id);
      if (after && isWorking(after)) return { ok: false, failure: "stop still working after cancel" };
      cancelled = true;
    }
  }
  let r: { orderId: number | null; failure: string | null };
  try { r = await liquidate(t.contract_id); } catch (e) { r = { orderId: null, failure: String(e).slice(0, 160) }; }
  if (r.failure || !r.orderId) {
    const why = r.failure ?? "no order id";
    if (cancelled) {
      const id = await ensureProtected({ contractId: t.contract_id, contract: t.contract, side: t.side, qty: t.qty, stopPx: t.stop_price, stopOrderId: null, clOrdId: t.cl_ord_id, why: `close (${reason}) refused` });
      if (id) await prisma.$executeRawUnsafe(`UPDATE futures_desk_trades SET stop_order_id = $2::bigint WHERE id = $1`, t.id, id);
      else await prisma.$executeRawUnsafe(`UPDATE futures_desk_trades SET exit_reason = 'unprotected' WHERE id = $1`, t.id);
    }
    await sendNotification(`⚠️ FUTURES DESK ${t.contract}: close (${reason}) refused — ${why}`, LANE).catch(() => {});
    return { ok: false, failure: why };
  }
  await prisma.$executeRawUnsafe(`UPDATE futures_desk_trades SET exit_reason = $2::text, exit_order_id = $3::bigint WHERE id = $1`, t.id, reason, r.orderId);
  return { ok: true, failure: null };
}

// ---- the guardian ----------------------------------------------------------------------------------
export interface GuardReport { ok: boolean; equity: number; open: number; settled: number; notes: string[] }

/** One guardian at a time: two overlapping runs would both see "no stop" and place two. */
export async function deskGuard(): Promise<GuardReport> {
  const lock = await acquireLock(GUARD_LOCK_KEY, GUARD_LOCK_TTL_MS);
  if (!lock) return { ok: true, equity: 0, open: 0, settled: 0, notes: ["another guardian run is in progress"] };
  try { return await guardBody(); } finally { await releaseLock(GUARD_LOCK_KEY, lock); }
}

async function guardBody(): Promise<GuardReport> {
  const notes: string[] = [];
  const state = await loadState();
  const limits = await deskLimits();
  const day = etDayKey(new Date());
  let bal: Awaited<ReturnType<typeof deskBalance>>;
  try { bal = await deskBalance(); }
  catch (e) { await patchState((s) => { s.lastError = `broker: ${String(e).slice(0, 160)}`; }); return { ok: false, equity: state.equity ?? 0, open: 0, settled: 0, notes: [String(e).slice(0, 160)] }; }
  const equity = bal.netLiq || bal.balance;
  if (state.dayKey !== day) { state.dayKey = day; state.dayStartEquity = equity; }
  state.equity = equity;
  state.equityHigh = Math.max(state.equityHigh ?? 0, equity);
  if (!state.disabledReason && state.equityHigh > 0 && equity <= state.equityHigh * (1 - limits.drawdownDisablePct / 100)) {
    state.disabledReason = `equity $${equity.toFixed(0)} is ${limits.drawdownDisablePct}% off its high $${state.equityHigh.toFixed(0)}`;
    await sendNotification(`🛑 FUTURES DESK disabled: ${state.disabledReason}. Re-enable from /futures after review.`, LANE).catch(() => {});
  }
  // Guardian-owned scalars are saved NOW, before any broker work; the stamp is patched in at the
  // end on a fresh read, so nothing another writer did meanwhile is overwritten.
  await saveState(state);

  const [positions, orders, open] = await Promise.all([deskPositions(), deskOrders(), openTrades()]);
  let settled = 0;
  for (const t of open) {
    const pos = positions.find((p) => p.contractId === t.contract_id);
    if (!pos) { if (await settle(t, orders)) settled++; continue; }
    // Still open: exactly one working stop, or the position is closed.
    const stopId = await ensureProtected({ contractId: t.contract_id, contract: t.contract, side: t.side, qty: Math.abs(pos.netPos), stopPx: t.stop_price, stopOrderId: t.stop_order_id, clOrdId: t.cl_ord_id, why: "guardian re-protect" });
    if (stopId == null) { await prisma.$executeRawUnsafe(`UPDATE futures_desk_trades SET exit_reason = 'unprotected' WHERE id = $1`, t.id); notes.push(`${t.contract}: unprotectable — closed`); continue; }
    if (stopId !== t.stop_order_id) { await prisma.$executeRawUnsafe(`UPDATE futures_desk_trades SET stop_order_id = $2::bigint WHERE id = $1`, t.id, stopId); notes.push(`${t.contract}: stop re-linked #${stopId}`); }
    const live = { ...t, stop_order_id: stopId };
    // Time stop.
    const spec = edgeByKey(t.edge);
    if (spec?.maxHoldDays && Date.now() - Date.parse(t.opened_at) > spec.maxHoldDays * 86_400_000 && cmeOpen(new Date())) {
      const r = await closeTrade(live, "time"); notes.push(`${t.contract}: ${spec.maxHoldDays}-day time stop${r.ok ? "" : ` FAILED (${r.failure})`}`); continue;
    }
    // Roll before expiry / first notice: close the old month and re-open the new one at the same stop distance.
    const exp = await contractExpiry(t.contract_id);
    if (exp && Date.parse(exp) - Date.now() < (rollGuardDays(t.micro) - 1) * 86_400_000 && cmeOpen(new Date())) {
      await rollTrade(live, notes);
    }
  }
  // Positions the desk does not own — reported, never touched.
  const fresh = await loadState();
  for (const p of positions) if (!open.some((t) => t.contract_id === p.contractId)) await alertOnce(fresh, `foreign-${p.contractId}`, `⚠️ FUTURES DESK: the demo holds contract #${p.contractId} (${p.netPos > 0 ? "long" : "short"} ${Math.abs(p.netPos)}) that the desk did not open. Left alone.`);

  // Queued alerts (CME break, lock contention, refused closes) — send at the reopen, expire when stale.
  if (cmeOpen(new Date())) {
    const queued = await rawRows<{ id: number; edge: string; root: string; action: string; side: Side; price: number; stop: number | null; bar: string; timeframe: string; note: string | null; received_at: string }>(
      `SELECT * FROM futures_desk_signals WHERE status = 'queued' ORDER BY id`);
    for (const q of queued) {
      if (Date.now() - Date.parse(q.received_at) > QUEUE_MAX_AGE_MS) { await markSignal(q.id, "expired", "queued for more than 12h"); continue; }
      const a: AlertPayload = { edge: q.edge as AlertPayload["edge"], root: q.root, action: q.action as "entry" | "exit", side: q.side, price: q.price, stop: q.stop, bar: q.bar, timeframe: q.timeframe, note: q.note ?? "" };
      try {
        const out = a.action === "exit" ? await exitByRule(q.id, a) : await enterFromSignal(q.id, a);
        notes.push(`queued #${q.id} → ${out.status}${out.reason ? ` (${out.reason})` : ""}`);
      } catch (e) {
        const msg = String(e).slice(0, 160);
        await markSignal(q.id, a.action === "exit" ? "queued" : "error", `threw: ${msg}`).catch(() => {});
        notes.push(`queued #${q.id} threw: ${msg}`);
      }
    }
  }
  await patchState((s) => { s.guardianAt = new Date().toISOString(); s.lastError = undefined; s.alerts = { ...s.alerts, ...fresh.alerts }; });
  return { ok: true, equity, open: open.length - settled, settled, notes };
}

/** The broker is flat in this contract: cancel any stop that survived, find the exit fill, book the round trip. */
async function settle(t: TradeRow, orders: DxOrder[]): Promise<boolean> {
  // A stop left working on a flat contract opens a reverse position on the next touch. Always first.
  if (t.stop_order_id) { const so = await orderItem(t.stop_order_id); if (so && isWorking(so)) await cancelDeskOrder(t.stop_order_id).catch(() => {}); }
  const candidates = [t.exit_order_id, t.stop_order_id].filter((x): x is number => !!x);
  let fill = { qty: 0, price: 0 }; let via = "";
  for (const id of candidates) { const f = avgFill(await fillsForOrder(id)); if (f.qty > 0) { fill = f; via = id === t.stop_order_id ? "stop" : (t.exit_reason ?? "close"); break; } }
  if (fill.qty === 0) {
    // Closed some other way (manually in the Tradovate app, or a close we did not record). Only orders AFTER our entry count.
    const opp = orders.filter((o) => o.contractId === t.contract_id && o.id > (t.entry_order_id ?? 0) && o.action === (t.side === "long" ? "Sell" : "Buy") && (o.ordStatus === "Filled" || o.ordStatus === "Completed"));
    for (const o of opp) { const f = avgFill(await fillsForOrder(o.id)); if (f.qty > 0) { fill = f; via = "external"; break; } }
  }
  if (fill.qty === 0) {
    await prisma.$executeRawUnsafe(`UPDATE futures_desk_trades SET status = 'unknown', closed_at = now(), exit_reason = COALESCE(exit_reason, 'unknown'), note = 'broker flat but no exit fill found' WHERE id = $1 AND status = 'open'`, t.id);
    await sendNotification(`⚠️ FUTURES DESK ${t.contract}: broker is flat but no exit fill was found — marked unknown, P&L not booked.`, LANE).catch(() => {});
    return true;
  }
  const pnl = tradePnlUsd(t.side, t.entry_price, fill.price, t.qty, t.point_value);
  const fees = 2 * t.qty * FEE_PER_SIDE_MICRO;
  await prisma.$executeRawUnsafe(`UPDATE futures_desk_trades SET status = 'closed', exit_price = $2::float8, closed_at = now(), exit_reason = $3::text, pnl_usd = $4::float8, fees_usd = $5::float8 WHERE id = $1 AND status = 'open'`, t.id, fill.price, via, pnl, fees);
  const r = t.risk_usd > 0 ? (pnl / t.risk_usd).toFixed(2) : "?";
  await sendNotification(`${pnl >= 0 ? "🟢" : "🔴"} FUTURES DESK ${t.contract} closed (${via}) @ ${fill.price} · ${pnl >= 0 ? "+" : "−"}$${Math.abs(pnl).toFixed(0)} (${r}R, after modeled fees) · ${t.edge}`, LANE).catch(() => {});
  return true;
}

async function rollTrade(t: TradeRow, notes: string[]): Promise<void> {
  forgetContract(t.micro);
  const next = await deskContract(t.micro);
  if (!next || next.id === t.contract_id) { notes.push(`${t.contract}: expiry near but no later month resolved`); return; }
  const stopDist = Math.abs(t.entry_price - t.stop_price);
  const closed = await closeTrade(t, "roll");
  if (!closed.ok) { notes.push(`${t.contract}: roll close refused (${closed.failure})`); return; }
  // Re-open the same size in the new month; the stop keeps its distance from the NEW fill.
  const action = t.side === "long" ? "Buy" : "Sell";
  const clOrdId = `${t.cl_ord_id}-roll${next.id}`;
  let orderId = 0, stopOrderId: number | null = null;
  const prior = await findOrderByClOrdId(clOrdId).catch(() => null);
  if (prior) orderId = prior.id;
  else {
    try {
      const provisional = roundToTick(t.side === "long" ? t.entry_price - stopDist : t.entry_price + stopDist, next.tickSize);
      const r = await placeEntryWithStop({ contractId: next.id, action, qty: t.qty, stopPrice: provisional, clOrdId });
      if (!r.orderId) throw new Error(r.failure ?? "no orderId");
      orderId = r.orderId; stopOrderId = r.stopOrderId;
    } catch (e) {
      const found = await findOrderByClOrdId(clOrdId).catch(() => null);
      if (!found) { await sendNotification(`🚨 FUTURES DESK roll ${t.contract} → ${next.name} FAILED to re-open: ${String(e).slice(0, 140)}. Position is CLOSED, not rolled.`, LANE).catch(() => {}); return; }
      orderId = found.id;
    }
  }
  let fill = { qty: 0, price: 0 };
  for (let i = 0; i < 8 && fill.qty === 0; i++) { await new Promise((r) => setTimeout(r, 750)); fill = avgFill(await fillsForOrder(orderId)); }
  if (fill.qty === 0) { const o = await orderItem(orderId); if (o && isWorking(o)) await cancelDeskOrder(orderId).catch(() => {}); await sendNotification(`🚨 FUTURES DESK roll into ${next.name}: entry ${orderId} not filled (${o?.ordStatus ?? "?"}). Position is CLOSED, not rolled.`, LANE).catch(() => {}); return; }
  const stopPx = roundToTick(t.side === "long" ? fill.price - stopDist : fill.price + stopDist, next.tickSize);
  if (stopOrderId) { try { await modifyStop(stopOrderId, fill.qty, stopPx); } catch { /* verified below */ } }
  const stopId = await ensureProtected({ contractId: next.id, contract: next.name, side: t.side, qty: fill.qty, stopPx, stopOrderId, clOrdId, why: "roll" });
  // The new leg keeps the ORIGINAL opened_at so the time stop does not restart on a roll.
  await prisma.$executeRawUnsafe(
    `INSERT INTO futures_desk_trades (opened_at, edge, root, micro, contract, contract_id, side, qty, entry_price, stop_price, entry_order_id, stop_order_id, cl_ord_id, signal_id, status, risk_usd, point_value, rolled_from, note, exit_reason)
     VALUES ($1::timestamptz,$2,$3,$4,$5,$6::int,$7,$8::int,$9::float8,$10::float8,$11::bigint,$12::bigint,$13,$14::int,'open',$15::float8,$16::float8,$17::int,$18,$19::text)`,
    t.opened_at, t.edge, t.root, t.micro, next.name, next.id, t.side, fill.qty, fill.price, stopPx, orderId, stopId, clOrdId, t.signal_id, t.risk_usd, t.point_value, t.id,
    `rolled from ${t.contract}`, stopId == null ? "unprotected" : null);
  notes.push(`${t.contract} → ${next.name} rolled${stopId == null ? " — UNPROTECTABLE, closed" : ""}`);
  await sendNotification(`🔁 FUTURES DESK rolled ${t.contract} → ${next.name}: ${fill.qty}× @ ${fill.price}, stop ${stopPx}.`, LANE).catch(() => {});
}

export async function setDeskEnabled(enabled: boolean, who: string): Promise<void> {
  await setKey("futures_desk_enabled", enabled ? "true" : "false");
  // Enabling after a drawdown disable is a fresh start: the high is re-based to today's equity, or
  // the guardian would disable it again on its next run.
  await patchState((s) => { if (enabled) { s.disabledReason = undefined; s.equityHigh = s.equity ?? 0; } });
  await sendNotification(`${enabled ? "▶️" : "⏸"} FUTURES DESK ${enabled ? "ENABLED" : "DISABLED"} by ${who}.`, LANE).catch(() => {});
}

export { EDGES };
