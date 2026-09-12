// FUTURES DESK — the I/O half: the alert inbox, the ledger, entries on the Tradovate DEMO account
// and the guardian that manages what is open. Rules and sizing are in futures-desk-rules.ts (pure).
//
// ISOLATION: raw-SQL tables (never prisma-managed, so a schema push cannot drop them), config
// keys prefixed `futures_desk_`, state in one AgentConfig JSON row, and no import from any
// margin-*, kraken-*, prop-* or options-* module. Broker calls go through tradovate-desk.ts,
// which pins the demo account.
import { prisma } from "@/lib/db";
import { sendNotification } from "@/lib/notifications";
import {
  DEFAULT_LIMITS, EDGES, FEE_PER_SIDE_MICRO, MICRO_FOR_ROOT, cmeOpen, dedupeKey, edgeByKey, entryRefusal, etDayKey,
  roundToTick, sizeEntry, tradePnlUsd, type AlertPayload, type DeskContext, type DeskLimits, type Side,
} from "@/lib/futures-desk-rules";
import {
  avgFill, cancelDeskOrder, contractExpiry, deskBalance, deskContract, deskOrders, deskPositions, fillsForOrder,
  findOrderByClOrdId, forgetContract, isWorking, liquidate, orderItem, placeEntryWithStop, placeStop, rollGuardDays, type DxOrder,
} from "@/lib/tradovate-desk";

const STATE_KEY = "futures_desk_state";
const LOCK_KEY = "futures_desk_entry_lock";
const LOCK_TTL_MS = 120_000;
const QUEUE_MAX_AGE_MS = 12 * 60 * 60_000;
const LANE = "futures_demo" as const;

export interface DeskState {
  guardianAt?: string;
  equity?: number;
  equityHigh?: number;
  dayKey?: string;
  dayStartEquity?: number;
  entries: Record<string, number>;
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
  if (!raw) return { entries: {}, alerts: {} };
  try { const s = JSON.parse(raw); return { entries: {}, alerts: {}, ...s }; } catch { return { entries: {}, alerts: {} }; }
}
async function saveState(s: DeskState): Promise<void> {
  const keys = Object.keys(s.entries).sort();
  for (const k of keys.slice(0, Math.max(0, keys.length - 14))) delete s.entries[k];
  await setKey(STATE_KEY, JSON.stringify(s));
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
  return prisma.$queryRawUnsafe<TradeRow[]>(`SELECT * FROM futures_desk_trades WHERE status = 'open' ORDER BY id`);
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
  await prisma.$executeRawUnsafe(`UPDATE futures_desk_signals SET status = $2::text, reason = $3::text, executed_at = CASE WHEN $2::text IN ('executed','refused','error','expired') THEN now() ELSE executed_at END, trade_id = COALESCE($4::int, trade_id) WHERE id = $1`, id, status, reason, tradeId);
}

// ---- entry lock (compare-and-set) ----------------------------------------------------------------
async function acquireLock(): Promise<string | null> {
  const token = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const now = Date.now();
  try {
    const row = await prisma.agentConfig.findUnique({ where: { key: LOCK_KEY } });
    if (!row) { try { await prisma.agentConfig.create({ data: { key: LOCK_KEY, value: `${token}@${now}` } }); return token; } catch { return null; } }
    const at = Number(row.value.split("@")[1] || 0);
    if (row.value && now - at < LOCK_TTL_MS) return null;
    const r = await prisma.agentConfig.updateMany({ where: { key: LOCK_KEY, value: row.value }, data: { value: `${token}@${now}` } });
    return r.count === 1 ? token : null;
  } catch { return null; }
}
async function releaseLock(token: string): Promise<void> {
  try { const row = await prisma.agentConfig.findUnique({ where: { key: LOCK_KEY } }); if (row?.value?.startsWith(token)) await setKey(LOCK_KEY, ""); } catch { /* TTL */ }
}

// ---- alerts in ---------------------------------------------------------------------------------------
export type AlertOutcome = { status: string; reason: string; signalId: number; tradeId?: number };

/** The webhook's one call. Dedupes, then either executes now, queues for the reopen, or refuses. */
export async function handleAlert(a: AlertPayload): Promise<AlertOutcome> {
  const rec = await recordSignal(a, "received", "");
  if (rec.duplicate) return { status: "duplicate", reason: "same rule, market, action and bar already received", signalId: rec.id };
  // Exits queue too: a daily bar closes at 17:00 ET, inside the break, and a liquidation then is refused.
  if (!cmeOpen(new Date())) { await markSignal(rec.id, "queued", "CME closed — sent at the reopen by the guardian"); return { status: "queued", reason: "CME closed", signalId: rec.id }; }
  if (a.action === "exit") return exitByRule(rec.id, a);
  return enterFromSignal(rec.id, a);
}

async function contextNow(s: DeskState): Promise<DeskContext> {
  const open = await openTrades();
  const day = etDayKey(new Date());
  return {
    enabled: await deskEnabled() && !s.disabledReason,
    openRoots: open.map((t) => t.root),
    entriesToday: s.entries[day] ?? 0,
    dayPnlUsd: s.equity != null && s.dayStartEquity != null && s.dayKey === day ? s.equity - s.dayStartEquity : 0,
    equityUsd: s.equity ?? 0,
    equityHighUsd: s.equityHigh ?? 0,
    guardianFreshMs: s.guardianAt ? Date.now() - Date.parse(s.guardianAt) : null,
  };
}

export async function enterFromSignal(signalId: number, a: AlertPayload): Promise<AlertOutcome> {
  const lock = await acquireLock();
  if (!lock) { await markSignal(signalId, "queued", "another entry in flight — retried by the guardian"); return { status: "queued", reason: "entry lock busy", signalId }; }
  try {
    const [state, limits] = await Promise.all([loadState(), deskLimits()]);
    const refusal = entryRefusal(a, await contextNow(state), limits);
    if (refusal) { await markSignal(signalId, "refused", refusal); return { status: "refused", reason: refusal, signalId }; }
    const size = sizeEntry(a, limits);
    if (!size.ok) { await markSignal(signalId, "refused", size.reason); return { status: "refused", reason: size.reason, signalId }; }
    const contract = await deskContract(size.micro);
    if (!contract) { await markSignal(signalId, "error", `no ${size.micro} contract on Tradovate`); return { status: "error", reason: "contract", signalId }; }
    const stopPx = roundToTick(a.stop!, contract.tickSize);
    const action = a.side === "long" ? "Buy" : "Sell";
    const clOrdId = `fd-${signalId}`;

    // Count the entry BEFORE the request: a timeout must not become a second order on retry.
    const day = etDayKey(new Date());
    state.entries[day] = (state.entries[day] ?? 0) + 1;
    await saveState(state);

    let orderId = 0, stopOrderId: number | null = null;
    try {
      const r = await placeEntryWithStop({ contractId: contract.id, action, qty: size.contracts, stopPrice: stopPx, clOrdId });
      if (r.failure && !r.orderId) throw new Error(r.failure);
      orderId = r.orderId; stopOrderId = r.stopOrderId;
    } catch (e) {
      const found = await findOrderByClOrdId(clOrdId).catch(() => null);
      if (!found) {
        state.entries[day] = Math.max(0, (state.entries[day] ?? 1) - 1); await saveState(state);
        const msg = String(e).slice(0, 200);
        await markSignal(signalId, "error", msg);
        await sendNotification(`⚠️ FUTURES DESK ${a.root} ${a.edge}: entry refused by Tradovate — ${msg}`, LANE).catch(() => {});
        return { status: "error", reason: msg, signalId };
      }
      orderId = found.id;
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
      state.entries[day] = Math.max(0, (state.entries[day] ?? 1) - 1); await saveState(state);
      const why = `entry ${orderId} did not fill (${o?.ordStatus ?? "unknown"})`;
      await markSignal(signalId, "refused", why);
      return { status: "refused", reason: why, signalId };
    }
    // The OSO bracket is the stop; find it if the response did not name it.
    if (!stopOrderId) {
      const working = (await deskOrders()).filter((o) => o.contractId === contract.id && isWorking(o) && o.action !== action);
      stopOrderId = working[0]?.id ?? null;
    }
    const spec = MICRO_FOR_ROOT[a.root];
    const rows = await prisma.$queryRawUnsafe<{ id: number }[]>(
      `INSERT INTO futures_desk_trades (edge, root, micro, contract, contract_id, side, qty, entry_price, stop_price, entry_order_id, stop_order_id, cl_ord_id, signal_id, status, risk_usd, point_value, note)
       VALUES ($1,$2,$3,$4,$5::int,$6,$7::int,$8::float8,$9::float8,$10::bigint,$11::bigint,$12,$13::int,'open',$14::float8,$15::float8,$16) RETURNING id`,
      a.edge, a.root, size.micro, contract.name, contract.id, a.side, fill.qty, fill.price, stopPx, orderId, stopOrderId, clOrdId, signalId,
      size.riskUsd, spec.pointValue, fill.qty < size.contracts ? `partial fill ${fill.qty}/${size.contracts}` : a.note);
    const tradeId = rows[0].id;
    await markSignal(signalId, "executed", `${fill.qty}× ${contract.name} @ ${fill.price}`, tradeId);
    if (!stopOrderId) {
      try { stopOrderId = await placeStop({ contractId: contract.id, action: action === "Buy" ? "Sell" : "Buy", qty: fill.qty, stopPrice: stopPx, clOrdId: `${clOrdId}-s` }); await prisma.$executeRawUnsafe(`UPDATE futures_desk_trades SET stop_order_id = $2::bigint WHERE id = $1`, tradeId, stopOrderId); }
      catch (e) { await sendNotification(`🚨 FUTURES DESK ${contract.name}: filled but NO STOP is working (${String(e).slice(0, 120)}) — the guardian retries in ≤5 min.`, LANE).catch(() => {}); }
    }
    await sendNotification(`🟢 FUTURES DESK opened ${a.side.toUpperCase()} ${fill.qty}× ${contract.name} @ ${fill.price} · stop ${stopPx} · risk $${size.riskUsd.toFixed(0)} · ${a.edge}`, LANE).catch(() => {});
    return { status: "executed", reason: "", signalId, tradeId };
  } finally {
    await releaseLock(lock);
  }
}

/** The rule's own exit (RSI ≥ 50, channel exit). Cancel the stop FIRST, then close at market. */
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
 *  then close at market. A refused close leaves the row untouched so the caller can retry; the
 *  position is still protected only if the cancel had not gone through, so re-protect when it had. */
async function closeTrade(t: TradeRow, reason: string): Promise<{ ok: boolean; failure: string | null }> {
  let cancelled = false;
  if (t.stop_order_id) { const o = await orderItem(t.stop_order_id); if (o && isWorking(o)) { await cancelDeskOrder(t.stop_order_id).catch(() => {}); cancelled = true; } }
  const r = await liquidate(t.contract_id);
  if (r.failure || !r.orderId) {
    const why = r.failure ?? "no order id";
    await sendNotification(`⚠️ FUTURES DESK ${t.contract}: close (${reason}) refused — ${why}${cancelled ? " — stop was cancelled; re-placing it" : ""}`, LANE).catch(() => {});
    if (cancelled) {
      try { const id = await placeStop({ contractId: t.contract_id, action: t.side === "long" ? "Sell" : "Buy", qty: t.qty, stopPrice: t.stop_price, clOrdId: `${t.cl_ord_id}-c${Date.now().toString(36)}` }); await prisma.$executeRawUnsafe(`UPDATE futures_desk_trades SET stop_order_id = $2::bigint WHERE id = $1`, t.id, id); }
      catch { /* the guardian re-protects within 5 minutes */ }
    }
    return { ok: false, failure: why };
  }
  await prisma.$executeRawUnsafe(`UPDATE futures_desk_trades SET exit_reason = $2::text, exit_order_id = $3::bigint WHERE id = $1`, t.id, reason, r.orderId);
  return { ok: true, failure: null };
}

// ---- the guardian ----------------------------------------------------------------------------------
export interface GuardReport { ok: boolean; equity: number; open: number; settled: number; notes: string[] }

export async function deskGuard(): Promise<GuardReport> {
  const notes: string[] = [];
  const state = await loadState();
  const limits = await deskLimits();
  const day = etDayKey(new Date());
  let bal: Awaited<ReturnType<typeof deskBalance>>;
  try { bal = await deskBalance(); }
  catch (e) { state.lastError = `broker: ${String(e).slice(0, 160)}`; await saveState(state); return { ok: false, equity: state.equity ?? 0, open: 0, settled: 0, notes: [state.lastError] }; }
  const equity = bal.netLiq || bal.balance;
  if (state.dayKey !== day) { state.dayKey = day; state.dayStartEquity = equity; }
  state.equity = equity;
  state.equityHigh = Math.max(state.equityHigh ?? 0, equity);
  if (!state.disabledReason && state.equityHigh > 0 && equity <= state.equityHigh * (1 - limits.drawdownDisablePct / 100)) {
    state.disabledReason = `equity $${equity.toFixed(0)} is ${limits.drawdownDisablePct}% off its high $${state.equityHigh.toFixed(0)}`;
    await sendNotification(`🛑 FUTURES DESK disabled: ${state.disabledReason}. Re-enable from /futures after review.`, LANE).catch(() => {});
  }

  const [positions, orders, open] = await Promise.all([deskPositions(), deskOrders(), openTrades()]);
  let settled = 0;
  for (const t of open) {
    const pos = positions.find((p) => p.contractId === t.contract_id);
    if (!pos) { if (await settle(t, orders)) settled++; continue; }
    // Still open: a working stop is non-negotiable. Check the recorded stop BY ID first — a second
    // stop placed because a list was day-scoped would outlive the position and open a reverse one.
    const stop = t.stop_order_id ? (orders.find((o) => o.id === t.stop_order_id) ?? await orderItem(t.stop_order_id)) : null;
    if (!stop || !isWorking(stop)) {
      const other = orders.find((o) => o.contractId === t.contract_id && isWorking(o) && o.orderType === "Stop");
      if (other) { await prisma.$executeRawUnsafe(`UPDATE futures_desk_trades SET stop_order_id = $2::bigint WHERE id = $1`, t.id, other.id); }
      else {
        try {
          const id = await placeStop({ contractId: t.contract_id, action: t.side === "long" ? "Sell" : "Buy", qty: Math.abs(pos.netPos), stopPrice: t.stop_price, clOrdId: `${t.cl_ord_id}-r${Date.now().toString(36)}` });
          await prisma.$executeRawUnsafe(`UPDATE futures_desk_trades SET stop_order_id = $2::bigint WHERE id = $1`, t.id, id);
          notes.push(`${t.contract}: re-protected at ${t.stop_price}`);
          await sendNotification(`🛡 FUTURES DESK ${t.contract}: stop was missing — re-placed at ${t.stop_price}.`, LANE).catch(() => {});
        } catch (e) { await alertOnce(state, `naked-${t.id}`, `🚨 FUTURES DESK ${t.contract} is NAKED and the stop could not be placed: ${String(e).slice(0, 120)}`, 15 * 60_000); }
      }
    }
    // Time stop.
    const spec = edgeByKey(t.edge);
    if (spec?.maxHoldDays && Date.now() - Date.parse(t.opened_at) > spec.maxHoldDays * 86_400_000 && cmeOpen(new Date())) {
      const r = await closeTrade(t, "time"); notes.push(`${t.contract}: ${spec.maxHoldDays}-day time stop${r.ok ? "" : ` FAILED (${r.failure})`}`); continue;
    }
    // Roll before expiry / first notice: close the old month and re-open the new one at the same stop distance.
    const exp = await contractExpiry(t.contract_id);
    if (exp && Date.parse(exp) - Date.now() < (rollGuardDays(t.micro) - 1) * 86_400_000 && cmeOpen(new Date())) {
      await rollTrade(t, notes);
    }
  }
  // Positions the desk does not own — reported, never touched.
  for (const p of positions) if (!open.some((t) => t.contract_id === p.contractId)) await alertOnce(state, `foreign-${p.contractId}`, `⚠️ FUTURES DESK: the demo holds contract #${p.contractId} (${p.netPos > 0 ? "long" : "short"} ${Math.abs(p.netPos)}) that the desk did not open. Left alone.`);

  // Queued alerts (CME break, lock contention) — send at the reopen, expire when stale.
  if (cmeOpen(new Date())) {
    const queued = await prisma.$queryRawUnsafe<{ id: number; edge: string; root: string; action: string; side: Side; price: number; stop: number | null; bar: string; timeframe: string; note: string; received_at: string }[]>(
      `SELECT * FROM futures_desk_signals WHERE status = 'queued' ORDER BY id`);
    for (const q of queued) {
      if (Date.now() - Date.parse(q.received_at) > QUEUE_MAX_AGE_MS) { await markSignal(q.id, "expired", "queued for more than 12h"); continue; }
      const a: AlertPayload = { edge: q.edge as AlertPayload["edge"], root: q.root, action: q.action as "entry" | "exit", side: q.side, price: q.price, stop: q.stop, bar: new Date(q.bar).toISOString(), timeframe: q.timeframe, note: q.note ?? "" };
      const out = a.action === "exit" ? await exitByRule(q.id, a) : await enterFromSignal(q.id, a);
      notes.push(`queued #${q.id} → ${out.status}${out.reason ? ` (${out.reason})` : ""}`);
    }
  }
  state.guardianAt = new Date().toISOString();
  state.lastError = undefined;
  await saveState(state);
  return { ok: true, equity, open: open.length - settled, settled, notes };
}

/** The broker is flat in this contract: find the exit fill and book the round trip. */
async function settle(t: TradeRow, orders: DxOrder[]): Promise<boolean> {
  const candidates = [t.exit_order_id, t.stop_order_id].filter((x): x is number => !!x);
  let fill = { qty: 0, price: 0 }; let via = "";
  for (const id of candidates) { const f = avgFill(await fillsForOrder(id)); if (f.qty > 0) { fill = f; via = id === t.stop_order_id ? "stop" : (t.exit_reason ?? "close"); break; } }
  if (fill.qty === 0) {
    // Closed some other way (manually in the Tradovate app, or a bracket we did not record). Look for an opposite-side fill in this contract after the entry.
    const opp = orders.filter((o) => o.contractId === t.contract_id && o.action === (t.side === "long" ? "Sell" : "Buy") && (o.ordStatus === "Filled" || o.ordStatus === "Completed"));
    for (const o of opp) { const f = avgFill(await fillsForOrder(o.id)); if (f.qty > 0) { fill = f; via = "external"; break; } }
  }
  if (fill.qty === 0) {
    await prisma.$executeRawUnsafe(`UPDATE futures_desk_trades SET status = 'unknown', closed_at = now(), exit_reason = COALESCE(exit_reason, 'unknown'), note = 'broker flat but no exit fill found' WHERE id = $1 AND status = 'open'`, t.id);
    await sendNotification(`⚠️ FUTURES DESK ${t.contract}: broker is flat but no exit fill was found — marked unknown, P&L not booked.`, LANE).catch(() => {});
    return true;
  }
  const pnl = tradePnlUsd(t.side, t.entry_price, fill.price, t.qty, t.point_value);
  const fees = 2 * t.qty * FEE_PER_SIDE_MICRO;
  if (t.stop_order_id && via !== "stop") { const so = orders.find((o) => o.id === t.stop_order_id); if (so && isWorking(so)) await cancelDeskOrder(t.stop_order_id).catch(() => {}); }
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
  try {
    // Price the stop off the old entry as a placeholder; re-anchored below once the fill is known.
    const provisional = roundToTick(t.side === "long" ? t.entry_price - stopDist : t.entry_price + stopDist, next.tickSize);
    const r = await placeEntryWithStop({ contractId: next.id, action, qty: t.qty, stopPrice: provisional, clOrdId });
    if (!r.orderId) throw new Error(r.failure ?? "no orderId");
    orderId = r.orderId; stopOrderId = r.stopOrderId;
  } catch (e) {
    await sendNotification(`🚨 FUTURES DESK roll ${t.contract} → ${next.name} FAILED to re-open: ${String(e).slice(0, 140)}. Position is CLOSED, not rolled.`, LANE).catch(() => {});
    return;
  }
  let fill = { qty: 0, price: 0 };
  for (let i = 0; i < 8 && fill.qty === 0; i++) { await new Promise((r) => setTimeout(r, 750)); fill = avgFill(await fillsForOrder(orderId)); }
  if (fill.qty === 0) { await sendNotification(`🚨 FUTURES DESK roll into ${next.name}: entry ${orderId} not filled. Check the account.`, LANE).catch(() => {}); return; }
  const stopPx = roundToTick(t.side === "long" ? fill.price - stopDist : fill.price + stopDist, next.tickSize);
  if (stopOrderId) { await cancelDeskOrder(stopOrderId).catch(() => {}); }
  try { stopOrderId = await placeStop({ contractId: next.id, action: action === "Buy" ? "Sell" : "Buy", qty: fill.qty, stopPrice: stopPx, clOrdId: `${clOrdId}-s` }); }
  catch (e) { await sendNotification(`🚨 FUTURES DESK ${next.name}: rolled but the re-anchored stop failed (${String(e).slice(0, 100)}) — guardian retries.`, LANE).catch(() => {}); stopOrderId = null; }
  await prisma.$executeRawUnsafe(
    `INSERT INTO futures_desk_trades (edge, root, micro, contract, contract_id, side, qty, entry_price, stop_price, entry_order_id, stop_order_id, cl_ord_id, signal_id, status, risk_usd, point_value, rolled_from, note)
     VALUES ($1,$2,$3,$4,$5::int,$6,$7::int,$8::float8,$9::float8,$10::bigint,$11::bigint,$12,$13::int,'open',$14::float8,$15::float8,$16::int,$17)`,
    t.edge, t.root, t.micro, next.name, next.id, t.side, fill.qty, fill.price, stopPx, orderId, stopOrderId, clOrdId, t.signal_id, t.risk_usd, t.point_value, t.id, `rolled from ${t.contract}`);
  notes.push(`${t.contract} → ${next.name} rolled`);
  await sendNotification(`🔁 FUTURES DESK rolled ${t.contract} → ${next.name}: ${fill.qty}× @ ${fill.price}, stop ${stopPx}.`, LANE).catch(() => {});
}

export async function setDeskEnabled(enabled: boolean, who: string): Promise<void> {
  await setKey("futures_desk_enabled", enabled ? "true" : "false");
  const s = await loadState();
  if (enabled) s.disabledReason = undefined;
  await saveState(s);
  await sendNotification(`${enabled ? "▶️" : "⏸"} FUTURES DESK ${enabled ? "ENABLED" : "DISABLED"} by ${who}.`, LANE).catch(() => {});
}

export { EDGES };
