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
  EDGES, budgetFor, edgeByKey, entryRefusal, etDayKey, etShortDate, feePerSide, gradeFor, rollDue, rollPreview, roundToTick, sizeEntry, tradePnlUsd,
  type AlertPayload, type DeskContext, type DeskLimits, type Side, type Stage,
} from "@/lib/futures-desk-rules";
import { ddTier, deskContextOf, riskStateOf } from "@/lib/futures-desk-risk";
import { EVENT_POLICY_KEY, cmeHolidayRefusal, cmeOpenForDesk, deskEventPolicy, eventContextOf } from "@/lib/futures-desk-calendar";
import { dailyReviewDue, isoWeekKey, weeklyReviewDue } from "@/lib/futures-desk-review";
import { runDailyReview, runWeeklyReview } from "@/lib/futures-desk-review-jobs";
import { entrySlipPts, excursionJobDue, insertTrade, pnlAfterSlip, sessionOf, slipModelUsd, slipPtsPerSide, toR, updateExcursions, watchCapReached, watchCard } from "@/lib/futures-desk-journal";
import { EXECUTION_ERRORS_DISABLE_AT, EXECUTION_ERRORS_REASON, anomalyRefusal, detectAnomaly, executionErrorsToday, feedStale, hostForMode, parseAnomaly, preTradeChecklist } from "@/lib/futures-desk-safety";
import { MIN_SCORE_KEY, REGIME_KEY, SCORE_PROMOTED_KEY, minScoreRefusal, parseMinScore, parseRegime, pineContextOf, regimeStamp } from "@/lib/futures-desk-score";
import { refreshRegime, scoreSignal } from "@/lib/futures-desk-score-jobs";
import {
  ANOMALY_KEY, ENTRY_LOCK_KEY, ENTRY_LOCK_TTL_MS, FEED_SEEN_KEY, GUARD_LOCK_KEY, GUARD_LOCK_TTL_MS, LANE, acquireLock, alertOnce, cfg, deskEnabled, deskLimits, entriesToday,
  executionErrorEvents, expireOldWatches, ledgerChangesSince, loadState, lockHeld, markSignal, openTrades, patchState, rawRows, recordSignal, releaseLock, saveState, setKey, stampSignal,
  watchesToday, type DeskState, type TradeRow,
} from "@/lib/futures-desk-store";
import {
  DESK_MODE, avgFill, cancelDeskOrder, contractExpiry, deskBalance, deskContract, deskOrders, deskPositions, fillsForOrder,
  findOrderByClOrdId, forgetContract, isWorking, liquidate, modifyStop, orderItem, placeEntryWithStop, placeStop, rollGuardDays,
  workingCloseOrders, type DxOrder,
} from "@/lib/tradovate-desk";

// The store (config keys, state, tables, inbox, ledger reads, locks) lives in futures-desk-store.ts;
// re-exported here so the page, the routes and the tests keep one import.
export { deskEnabled, deskLimits, ensureDeskTables, ledgerRows, loadState, normaliseRow, openTrades, rawRows, type DeskState, type TradeRow } from "@/lib/futures-desk-store";

const QUEUE_MAX_AGE_MS = 12 * 60 * 60_000;

// ---- alerts in ---------------------------------------------------------------------------------------
export type AlertOutcome = { status: string; reason: string; signalId: number; tradeId?: number };

/** The webhook's one call. Dedupes, then either executes now, queues for the reopen, or refuses.
 *  An exception never strands a signal in `received`: exits re-queue (a lost exit rides to the
 *  stop), entries are marked error. */
export async function handleAlert(raw: AlertPayload): Promise<AlertOutcome> {
  const rec = await recordSignal(raw, "received", "");
  if (rec.duplicate) return { status: "duplicate", reason: "same rule, market, action and bar already received", signalId: rec.id };
  // E7: every entry and watch is scored and regime-stamped at receipt — refused ones too — so the weekly review can
  // measure the score against outcomes. A scoring failure leaves the row unscored; it never blocks the alert.
  const a = (await scoreSignal(rec.id, raw, (await deskLimits()).sizingBasisUsd)).alert;
  // A watch never executes, so it never queues either: it is sized on paper and logged, CME open or not.
  if (a.action === "watch") { try { return await watchSignal(rec.id, a); } catch (e) { const msg = String(e).slice(0, 200); await markSignal(rec.id, "error", msg).catch(() => {}); return { status: "error", reason: msg, signalId: rec.id }; } }
  // Exits queue too: a daily bar closes at 17:00 ET, inside the break, and a liquidation then is refused.
  // A closed-all-day CME holiday queues everything as well (an early-close evening is open for exits).
  if (!cmeOpenForDesk(new Date())) { await markSignal(rec.id, "queued", "CME closed — sent at the reopen by the guardian"); return { status: "queued", reason: "CME closed", signalId: rec.id }; }
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

/** Pine v2 `watch`: the rule is close to firing. The row gets a dry-run sizing card as its reason and
 *  is capped at three per root per ET day (the 60m rule can hover under its channel for hours). */
async function watchSignal(signalId: number, a: AlertPayload): Promise<AlertOutcome> {
  if (watchCapReached(await watchesToday(a.root, signalId))) { await markSignal(signalId, "watch", "watch cap reached"); return { status: "watch", reason: "watch cap reached", signalId }; }
  const now = new Date();
  const [state, limits, promoted, policyRaw] = await Promise.all([loadState(), deskLimits(), cfg(SCORE_PROMOTED_KEY), cfg(EVENT_POLICY_KEY)]);
  const grade = gradeFor(a, promoted === "true");
  // The dry run is sized the way an entry would be: the drawdown tier × the event window (0.5 while reduced).
  const budgetMult = ddTier(state.equity ?? 0, state.equityHigh ?? 0).mult * eventContextOf(policyRaw, now.getTime(), deskEventPolicy(now)).budgetMult;
  const card = watchCard(a, limits, { grade, stage: limits.stage, budgetMult, stageDArmed: false });
  await stampSignal(signalId, { grade });
  await markSignal(signalId, "watch", card);
  return { status: "watch", reason: card, signalId };
}

/** The entry container from the guardian's own numbers (≤ 20 min old by the freshness gate) and the
 *  event policy it last wrote (E3). The row is the freshness proof; the MODE is the stricter of the row's
 *  and the policy recomputed now (pure), so a pause window that opened since the last guardian run still
 *  refuses. A reduced window halves the budget on top of the tier's multiplier; paused, stale or missing
 *  refuses in `entryRefusal`; a CME holiday refuses entries only. The raw row rides back for the checklist. */
async function contextNow(s: DeskState, limits: DeskLimits, a: AlertPayload, budgetUsd: number, tierMult: number): Promise<{ ctx: DeskContext | { refusal: string }; policyRaw: string | null }> {
  const now = new Date();
  const [open, n, enabled, policyRaw] = await Promise.all([openTrades(), entriesToday(), deskEnabled(), cfg(EVENT_POLICY_KEY)]);
  const event = eventContextOf(policyRaw, now.getTime(), deskEventPolicy(now));
  const budgetMult = tierMult * event.budgetMult;
  const ctx = deskContextOf({ enabled, state: s, open, entriesToday: n, limits, alert: a, newRiskUsd: budgetUsd * budgetMult, now, dayKey: etDayKey(now), event, budgetMult, cmeHoliday: cmeHolidayRefusal(now) });
  return { ctx, policyRaw };
}

/** Exactly one working stop, or no position. Returns the working stop id, or null when the
 *  position had to be closed because it could not be protected.
 *  Order of preference: the remembered id (polled briefly — an OSO bracket is not visible the
 *  same instant the entry fills) → any working close-side order on the contract (a stop whose
 *  response was lost, or the bracket under a different id) → place one → if THAT fails, re-list
 *  once more (the response may have been lost) → only then close. */
async function ensureProtected(p: { contractId: number; contract: string; side: Side; qty: number; stopPx: number; stopOrderId: number | null; clOrdId: string; why: string }): Promise<number | null> {
  const closeAction = p.side === "long" ? "Sell" : "Buy";
  if (p.stopOrderId) {
    for (let i = 0; i < 4; i++) {
      const o = await orderItem(p.stopOrderId);
      if (o && isWorking(o)) return p.stopOrderId;
      if (o && (o.ordStatus === "Rejected" || o.ordStatus === "Canceled" || o.ordStatus === "Filled")) break;
      await new Promise((r) => setTimeout(r, 750));
    }
  }
  const working = await workingCloseOrders(p.contractId, closeAction);
  if (working.length) return working[0].id;
  try { return await placeStop({ contractId: p.contractId, action: closeAction, qty: p.qty, stopPrice: p.stopPx, clOrdId: `${p.clOrdId}-p${Date.now().toString(36)}` }); }
  catch (e) {
    const again = await workingCloseOrders(p.contractId, closeAction).catch(() => []);
    if (again.length) return again[0].id;   // the POST went through; only the response was lost
    const r = await liquidate(p.contractId).catch((err) => ({ orderId: null, failure: String(err) }));
    await sendNotification(`🛑 FUTURES DESK ${p.contract}: the stop could not be placed (${String(e).slice(0, 100)}) — ${p.why} — position CLOSED at market${r.failure ? ` (close refused: ${r.failure} — CHECK THE ACCOUNT)` : ""}.`, LANE).catch(() => {});
    return null;
  }
}

/** A flat contract must have NO working close-side orders — not just the one we remembered. A stop
 *  whose placement response was lost is still a real stop. */
async function sweepStops(contractId: number, side: Side): Promise<number> {
  const closeAction = side === "long" ? "Sell" : "Buy";
  const working = await workingCloseOrders(contractId, closeAction).catch(() => []);
  for (const o of working) await cancelDeskOrder(o.id).catch(() => {});
  return working.length;
}

/** The one write for a protection outcome: the working stop id, or — when none could be placed —
 *  `unprotected` as both the exit reason and the error class (the position was closed at market). */
async function recordProtection(tradeId: number, stopId: number | null, note: string | null = null): Promise<void> {
  await prisma.$executeRawUnsafe(
    `UPDATE futures_desk_trades SET stop_order_id = $2::bigint, exit_reason = CASE WHEN $2::bigint IS NULL THEN 'unprotected' ELSE exit_reason END,
     error_class = CASE WHEN $2::bigint IS NULL THEN 'unprotected' ELSE error_class END, note = COALESCE($3::text, note) WHERE id = $1`, tradeId, stopId, note);
}

export async function enterFromSignal(signalId: number, a: AlertPayload): Promise<AlertOutcome> {
  const lock = await acquireLock(ENTRY_LOCK_KEY, ENTRY_LOCK_TTL_MS);
  if (!lock) { await markSignal(signalId, "queued", "another entry in flight — retried by the guardian"); return { status: "queued", reason: "entry lock busy", signalId }; }
  try {
    const [state, limits, promotedRaw, minScoreRaw, regimeRaw] = await Promise.all([loadState(), deskLimits(), cfg(SCORE_PROMOTED_KEY), cfg(MIN_SCORE_KEY), cfg(REGIME_KEY)]);
    const promoted = promotedRaw === "true";   // strict: anything but the literal "true" is "not promoted" (Normal grade, no minimum)
    const grade = gradeFor(a, promoted);
    const regime = regimeStamp(parseRegime(regimeRaw), a.root);
    const tier = ddTier(state.equity ?? 0, state.equityHigh ?? 0);
    const { ctx, policyRaw } = await contextNow(state, limits, a, budgetFor(grade, limits), tier.mult);   // worst case: the whole budget × tier × event
    const [eventMode, budgetMult] = "refusal" in ctx ? [null, tier.mult] : [ctx.eventMode, ctx.budgetMult];
    await stampSignal(signalId, { grade, eventMode });   // stamped before the verdict, so a refused row still says what it met
    // The minimum score (E7) is consulted ONLY once the score is promoted; before that it is a stamp and this is null.
    const refusal = "refusal" in ctx ? ctx.refusal : entryRefusal(a, ctx, limits) ?? anomalyRefusal(await cfg(ANOMALY_KEY)) ?? minScoreRefusal(a.score, parseMinScore(minScoreRaw), promoted);
    if (refusal) { await markSignal(signalId, "refused", refusal); return { status: "refused", reason: refusal, signalId }; }
    const stageDArmed = limits.stage === "D" && (await cfg("futures_desk_stage_d_armed")) === "true";
    const size = sizeEntry(a, limits, { grade, stage: limits.stage, budgetMult, stageDArmed });
    if (!size.ok) { await markSignal(signalId, "refused", size.reason); return { status: "refused", reason: size.reason, signalId }; }
    const contract = await deskContract(size.micro);
    if (!contract) { await markSignal(signalId, "error", `no ${size.micro} contract on Tradovate`); return { status: "error", reason: "contract", signalId }; }
    // The enforced pre-trade checklist, stored whole on the signal row; the first failure is the refusal.
    const [expiry, feedSeenAt] = await Promise.all([contractExpiry(contract.id), cfg(FEED_SEEN_KEY)]);
    const check = preTradeChecklist(a, { brokerHost: hostForMode(DESK_MODE), expiryIso: expiry, guardDays: rollGuardDays(size.micro), openRoots: "refusal" in ctx ? [] : ctx.openRoots, eventPolicyRaw: policyRaw, feedSeenAt, now: new Date() }, contract, size, limits);
    await stampSignal(signalId, { checklistJson: JSON.stringify(check) });
    if (!check.ok) { await markSignal(signalId, "refused", check.failures[0]); return { status: "refused", reason: check.failures[0], signalId }; }
    const stopDist = size.stopPoints;
    const action = a.side === "long" ? "Buy" : "Sell";
    const clOrdId = `fd-${signalId}`;

    // NEVER send the same signal twice: an order with this clOrdId (a previous attempt that threw
    // after the POST) is adopted instead of placed again.
    let orderId = 0, stopOrderId: number | null = null;
    const prior = await findOrderByClOrdId(clOrdId).catch(() => null);
    if (prior) orderId = prior.id;
    else {
      // The bracket exists only for the crash window until it is re-anchored to the fill. It is placed
      // deliberately FAR (the chart's stop, one more stop-distance away): the chart may be on another
      // month, and a provisional level at or above the fill would trigger as a phantom stop-out.
      const provisional = roundToTick(a.side === "long" ? a.stop! - stopDist : a.stop! + stopDist, contract.tickSize);
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
      if (o && (o.ordStatus === "Filled" || o.ordStatus === "Completed")) {
        // Filled, but the fill reads failed: a position exists that this run cannot describe. Never
        // "refused" — that would leave a real position with no ledger row. The guardian reports it.
        const why = `entry ${orderId} is ${o.ordStatus} but its fills could not be read — position exists, not recorded`;
        await markSignal(signalId, "error", why);
        await sendNotification(`🚨 FUTURES DESK ${contract.name}: ${why}. Check the account.`, LANE).catch(() => {});
        return { status: "error", reason: why, signalId };
      }
      if (o && isWorking(o)) await cancelDeskOrder(orderId).catch(() => {});
      const why = `entry ${orderId} did not fill (${o?.ordStatus ?? "unknown"})`;
      await markSignal(signalId, "refused", why);
      return { status: "refused", reason: why, signalId };
    }
    // A partial fill stops here: the remainder must not keep filling after the row is written.
    if (fill.qty < size.contracts) { const o = await orderItem(orderId); if (o && isWorking(o)) await cancelDeskOrder(orderId).catch(() => {}); }

    // The ledger row exists the moment the fill is confirmed — BEFORE protection work that can throw —
    // so the guardian manages this position whatever happens next.
    const stopPx = roundToTick(a.side === "long" ? fill.price - stopDist : fill.price + stopDist, contract.tickSize);
    const riskUsd = fill.qty * size.riskPerContractUsd;
    const partial = fill.qty < size.contracts;
    const tradeId = await insertTrade({
      edge: a.edge, root: a.root, micro: size.micro, contract: contract.name, contractId: contract.id, side: a.side, qty: fill.qty, entryPrice: fill.price, stopPrice: stopPx,
      entryOrderId: orderId, stopOrderId, clOrdId, signalId, riskUsd, pointValue: size.pointValue, rolledFrom: null, note: partial ? `partial fill ${fill.qty}/${size.contracts}` : a.note,
      contractMonth: contract.name.slice(-2), stage: limits.stage, signalPrice: a.price, entrySlipPts: entrySlipPts(a.side, a.price, fill.price), stopPoints: stopDist, atrAtEntry: a.atr ?? null,
      session: sessionOf(new Date()), regime, eventMode, grade: size.grade, errorClass: partial ? "partial_fill" : null, slipModelPts: slipPtsPerSide(a.root), slipModelUsd: slipModelUsd(a.root, fill.qty, size.pointValue),
    });

    // Re-anchor the stop to the ACTUAL fill: the chart may be on a different month (basis) and the
    // fill may differ from the signal close. Risk is defined from where we got in.
    let anchored = false;
    if (stopOrderId) { try { await modifyStop(stopOrderId, fill.qty, stopPx); anchored = true; } catch { /* verified below */ } }
    const stopId = await ensureProtected({ contractId: contract.id, contract: contract.name, side: a.side, qty: fill.qty, stopPx, stopOrderId, clOrdId, why: "entry" });
    await recordProtection(tradeId, stopId, stopId != null && stopId === stopOrderId && !anchored ? "stop at the provisional (chart) level — modify failed" : null);
    if (stopId == null) {
      // ensureProtected closed it; the guardian settles the round trip from the fills.
      await markSignal(signalId, "error", `filled ${fill.qty}× ${contract.name} but could not be protected — closed`, tradeId, "unprotected");
      return { status: "error", reason: "unprotected — closed", signalId, tradeId };
    }
    await markSignal(signalId, "executed", `${fill.qty}× ${contract.name} @ ${fill.price}`, tradeId);
    await sendNotification(`🟢 FUTURES DESK opened ${a.side.toUpperCase()} ${fill.qty}× ${contract.name} @ ${fill.price} · stop ${stopPx} · risk $${riskUsd.toFixed(0)} · ${a.edge} · ${size.grade} · stage ${size.stage}`, LANE).catch(() => {});
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
    // A thrown liquidation may still have gone through: never rest a stop on a flat contract.
    const stillOpen = await deskPositions().then((ps) => ps.some((p) => p.contractId === t.contract_id)).catch(() => true);
    await prisma.$executeRawUnsafe(`UPDATE futures_desk_trades SET error_class = COALESCE(error_class, 'close_refused') WHERE id = $1`, t.id);   // never overwrites partial_fill / unprotected
    if (cancelled && stillOpen) {
      const id = await ensureProtected({ contractId: t.contract_id, contract: t.contract, side: t.side, qty: t.qty, stopPx: t.stop_price, stopOrderId: null, clOrdId: t.cl_ord_id, why: `close (${reason}) refused` });
      await recordProtection(t.id, id);
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
  const prev = { equity: state.equity, at: state.guardianAt };   // last run's numbers, for the equity-jump check
  let bal: Awaited<ReturnType<typeof deskBalance>>;
  try { bal = await deskBalance(); }
  catch (e) { await patchState((s) => { s.lastError = `broker: ${String(e).slice(0, 160)}`; }); return { ok: false, equity: state.equity ?? 0, open: 0, settled: 0, notes: [String(e).slice(0, 160)] }; }
  const equity = bal.netLiq || bal.balance;
  if (state.dayKey !== day || state.dayStartBalance == null) state.dayStartBalance = bal.balance;   // `== null` covers the deploy day
  if (state.dayKey !== day) { state.dayKey = day; state.dayStartEquity = equity; }
  state.equity = equity; state.balance = bal.balance;
  state.equityHigh = Math.max(state.equityHigh ?? 0, equity);
  if (!state.disabledReason && state.equityHigh > 0 && equity <= state.equityHigh * (1 - limits.drawdownDisablePct / 100)) {
    state.disabledReason = `equity $${equity.toFixed(0)} is ${limits.drawdownDisablePct}% off its high $${state.equityHigh.toFixed(0)}`;
    await sendNotification(`🛑 FUTURES DESK disabled: ${state.disabledReason}. Re-enable from /futures after review.`, LANE).catch(() => {});
  }
  // Guardian-owned scalars are saved NOW, before any broker work; the stamp is patched in at the
  // end on a fresh read, so nothing another writer did meanwhile is overwritten.
  await saveState(state);

  const [positions, orders, open] = await Promise.all([deskPositions(), deskOrders(), openTrades()]);
  await guardSafety(state, { positions, open, equity, prev, day, notes });
  // The risk snapshot for the page and health (display-only; the entry path recomputes from `state`).
  const rs = riskStateOf({ equity, equityHigh: state.equityHigh, balance: bal.balance, dayStartBalance: state.dayStartBalance, open, limits, now: new Date() });
  await setKey("futures_desk_risk_state", JSON.stringify(rs)).catch(() => {});
  // The event policy (E3) — static table only, written every run; an entry needs one under 20 minutes old.
  const policy = deskEventPolicy(new Date());
  await setKey(EVENT_POLICY_KEY, JSON.stringify(policy)).catch(() => notes.push("event policy not saved"));
  if (policy.mode !== "normal") notes.push(`event policy: ${policy.mode} — ${policy.reason}`);
  let settled = 0;
  const expiries: Record<number, string | null> = {};   // open positions NOT rolled this run → roll planning below
  for (const t of open) {
    const pos = positions.find((p) => p.contractId === t.contract_id);
    if (!pos) { if (await settle(t, orders)) settled++; continue; }
    // Still open: exactly one working stop, or the position is closed.
    const stopId = await ensureProtected({ contractId: t.contract_id, contract: t.contract, side: t.side, qty: Math.abs(pos.netPos), stopPx: t.stop_price, stopOrderId: t.stop_order_id, clOrdId: t.cl_ord_id, why: "guardian re-protect" });
    if (stopId == null) { await recordProtection(t.id, null); notes.push(`${t.contract}: unprotectable — closed`); continue; }
    if (stopId !== t.stop_order_id) { await recordProtection(t.id, stopId); notes.push(`${t.contract}: stop re-linked #${stopId}`); }
    const live = { ...t, stop_order_id: stopId };
    // Time stop.
    const spec = edgeByKey(t.edge);
    if (spec?.maxHoldDays && Date.now() - Date.parse(t.opened_at) > spec.maxHoldDays * 86_400_000 && cmeOpenForDesk(new Date())) {
      const r = await closeTrade(live, "time"); notes.push(`${t.contract}: ${spec.maxHoldDays}-day time stop${r.ok ? "" : ` FAILED (${r.failure})`}`); continue;
    }
    // Roll before expiry / first notice: close the old month and re-open the new one at the same stop distance.
    const exp = await contractExpiry(t.contract_id);
    if (rollDue(exp, Date.now(), rollGuardDays(t.micro)) && cmeOpenForDesk(new Date())) { await rollTrade(live, notes); continue; }
    expiries[t.id] = exp;
  }
  const fresh = await loadState();
  if (feedStale(await cfg(FEED_SEEN_KEY), Date.now())) await alertOnce(fresh, "feed-stale", "📡 FUTURES DESK: no TradingView heartbeat in the last 180 CME-open minutes — the feed, the alert or the webhook is down. NO TRADE until it returns (entries are not refused; an arriving alert is proof of the feed).", 6 * 60 * 60_000);
  if (rs.tier === 3) await alertOnce(fresh, `dd-tier3-${day}`, `⚠️ FUTURES DESK drawdown ${rs.dd.toFixed(1)}% from the high — tier 3: budget ×0.25, micros only; investigate before the −10% halt.`, 24 * 60 * 60_000);
  // Roll planning: inside the last 5 days of a month, say when it rolls and into what; one Slack the day before.
  for (const plan of rollPreview(open.filter((t) => expiries[t.id] !== undefined), expiries, new Date(), rollGuardDays)) {
    const next = await deskContract(plan.micro).catch(() => null);   // the cached month is fine for a preview; rollTrade refreshes it
    const t = open.find((x) => x.id === plan.id)!;
    const target = next && next.id !== t.contract_id ? next.name : "next month";   // outside the guard, deskContract still resolves the current month
    const line = `roll plan: ${plan.contract} #${plan.id} → ${target} on ~${etShortDate(plan.rollOn)}`;
    notes.push(line);
    if (plan.daysUntilRoll <= 1) await alertOnce(fresh, `roll-plan-${plan.id}`, `🗓 FUTURES DESK ${line} (expires ${etShortDate(plan.expiry)}; the guardian rolls at the same stop distance during CME hours).`, 24 * 60 * 60_000);
  }
  // Positions the desk does not own — reported, never touched.
  for (const p of positions) if (!open.some((t) => t.contract_id === p.contractId)) await alertOnce(fresh, `foreign-${p.contractId}`, `⚠️ FUTURES DESK: the demo holds contract #${p.contractId} (${p.netPos > 0 ? "long" : "short"} ${Math.abs(p.netPos)}) that the desk did not open. Left alone.`);

  await expireOldWatches().catch(() => {});
  // Queued alerts (CME break, lock contention, refused closes) — send at the reopen, expire when stale.
  // A closed-all-day CME holiday skips the drain (an early-close evening does not).
  if (cmeOpenForDesk(new Date())) {
    const queued = await rawRows<{ id: number; edge: string; root: string; action: string; side: Side; price: number; stop: number | null; bar: string; timeframe: string; note: string | null; received_at: string; score: number | null; score_json: string | null }>(
      `SELECT * FROM futures_desk_signals WHERE status = 'queued' ORDER BY id`);
    for (const q of queued) {
      if (Date.now() - Date.parse(q.received_at) > QUEUE_MAX_AGE_MS) { await markSignal(q.id, "expired", "queued for more than 12h", null, "queue_expired"); continue; }
      const v2 = pineContextOf(q.score_json);   // the Pine v2 stamps ride along from the row so a replayed entry journals its ATR too (never the score object)
      const a: AlertPayload = { ...v2, edge: q.edge as AlertPayload["edge"], root: q.root, action: q.action as "entry" | "exit", side: q.side, price: q.price, stop: q.stop, bar: q.bar, timeframe: q.timeframe, note: q.note ?? "", ...(q.score != null ? { score: q.score } : {}) };
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
  // The guardian stamp and the day's fold key are persisted FIRST; the MFE/MAE fold (delayed Yahoo bars,
  // once per ET day after the 17:00 close) runs after it, so a slow Yahoo can never read as a stale guardian
  // or run twice. Fail-soft: a Yahoo problem is a note and the day's lastError.
  const foldDue = excursionJobDue(fresh.excursionDayKey, new Date());
  // The reviews (E6) follow the same once-per-key discipline: keys stamped with guardianAt, work done after.
  const dailyDue = dailyReviewDue(fresh.reviewDayKey, new Date());
  const weeklyDue = weeklyReviewDue(fresh.weeklyReviewKey, new Date());
  // The regime refresh (E7): the first run of each ET day, Yahoo daily bars per root — a stamp, never a gate.
  const regimeDue = fresh.regimeDayKey !== day;
  await patchState((s) => {
    s.guardianAt = new Date().toISOString(); s.lastError = undefined; if (foldDue) s.excursionDayKey = day;
    if (dailyDue) s.reviewDayKey = day; if (weeklyDue) s.weeklyReviewKey = isoWeekKey(new Date()); if (regimeDue) s.regimeDayKey = day;
    // Merge this run's once-only stamps — except `anomaly-*` stamps a clear-anomaly removed meanwhile (the DB copy is the truth for those).
    for (const [k, v] of Object.entries(fresh.alerts)) if (!(k.startsWith("anomaly-") && !(k in s.alerts))) s.alerts[k] = v;
  });
  if (foldDue) {
    let excursionError: string | undefined;
    try { notes.push(...(await updateExcursions())); } catch (e) { excursionError = `excursions: ${String(e).slice(0, 160)}`; notes.push(excursionError); }
    if (excursionError) await patchState((s) => { s.lastError = excursionError; }).catch(() => notes.push("excursions: lastError not saved"));
  }
  if (regimeDue) { try { notes.push(...(await refreshRegime())); } catch (e) { notes.push(`regime: ${String(e).slice(0, 160)}`); } }
  // Daily after the fold (so today's MFE/MAE are on the rows); weekly on Monday's first run. Both fail-soft.
  if (dailyDue) { try { notes.push(...(await runDailyReview(day, limits))); } catch (e) { notes.push(`daily review: ${String(e).slice(0, 160)}`); } }
  if (weeklyDue) { try { notes.push(...(await runWeeklyReview(limits))); } catch (e) { notes.push(`weekly review: ${String(e).slice(0, 160)}`); } }
  return { ok: true, equity, open: open.length - settled, settled, notes };
}

/** Kill switches (E5), run right after the broker snapshot and before any position work. The guardian
 *  has already saved its scalars, so what changes here is PATCHED onto the row (disabledReason, the
 *  once-only stamps) and the anomaly key is written; never throws — a failed read is a note. */
async function guardSafety(state: DeskState, i: { positions: { contractId: number; netPos: number }[]; open: TradeRow[]; equity: number; prev: { equity?: number; at?: string }; day: string; notes: string[] }): Promise<void> {
  const before = JSON.stringify(state.alerts);
  try {
    // (a) three execution errors beyond the count the desk was last ENABLED at (today) disable it — the baseline is
    // what makes a re-enable a fresh allowance instead of an instant re-trip; a baseline from another day is zero.
    const count = executionErrorsToday(await executionErrorEvents(), i.day);
    const baseline = state.execErrorBaseline?.day === i.day ? state.execErrorBaseline.count : 0;
    if (!state.disabledReason && count >= baseline + EXECUTION_ERRORS_DISABLE_AT) {
      state.disabledReason = EXECUTION_ERRORS_REASON;
      await alertOnce(state, `exec-errors-${i.day}`, `🛑 FUTURES DESK disabled: ${EXECUTION_ERRORS_REASON} (${count} today). Read the inbox and ledger error classes, then re-enable from /futures.`, 24 * 60 * 60_000);
      i.notes.push(`disabled: ${EXECUTION_ERRORS_REASON}`);
    }
    // (b)(c) anomalies pause ENTRIES until a person clears them. A foreign/mismatch read while an entry is in
    // flight is the entry's own fill (its ledger row comes after) — skipped; the next run sees the ledger.
    if (!parseAnomaly(await cfg(ANOMALY_KEY))) {
      const entryInFlight = await lockHeld(ENTRY_LOCK_KEY, ENTRY_LOCK_TTL_MS);
      const fillsSince = i.prev.at ? await ledgerChangesSince(i.prev.at) : 1;   // no previous run → no jump can be judged
      const found = detectAnomaly({ positions: entryInFlight ? [] : i.positions, open: entryInFlight ? [] : i.open, prevEquity: i.prev.equity, equity: i.equity, fillsSince, now: new Date() });
      if (found) {
        await setKey(ANOMALY_KEY, JSON.stringify(found));
        await alertOnce(state, `anomaly-${found.kind}`, `🚨 FUTURES DESK anomaly: ${found.detail}. Entries are PAUSED until cleared from /futures (type CLEAR); closes, rolls and re-protection continue.`, 6 * 60 * 60_000);
        i.notes.push(`anomaly: ${found.detail}`);
      }
    }
  } catch (e) { i.notes.push(`safety checks: ${String(e).slice(0, 120)}`); }
  if (state.disabledReason === EXECUTION_ERRORS_REASON || JSON.stringify(state.alerts) !== before) {
    await patchState((s) => { if (state.disabledReason === EXECUTION_ERRORS_REASON) s.disabledReason = s.disabledReason ?? EXECUTION_ERRORS_REASON; s.alerts = { ...s.alerts, ...state.alerts }; })
      .catch((e) => i.notes.push(`safety state not saved: ${String(e).slice(0, 120)}`));
  }
}

/** The broker is flat in this contract: cancel any stop that survived, find the exit fill, book the round trip. */
async function settle(t: TradeRow, orders: DxOrder[]): Promise<boolean> {
  // A stop left working on a flat contract opens a reverse position on the next touch. Always first,
  // and EVERY close-side order on the contract — a stop whose placement response was lost is still real.
  const swept = await sweepStops(t.contract_id, t.side);
  if (swept > 1) await sendNotification(`⚠️ FUTURES DESK ${t.contract}: ${swept} working stops found on a flat contract — all cancelled.`, LANE).catch(() => {});
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
  const fee = feePerSide(t.micro, t.root);   // a stage-D mini row pays the mini fee
  const pnl = tradePnlUsd(t.side, t.entry_price, fill.price, t.qty, t.point_value, fee);
  const fees = 2 * t.qty * fee;
  // The judged series: the demo's own P&L minus the modeled round-trip slippage (rows from before the
  // model existed have no slip_model_usd and are judged on pnl_usd alone). MFE/MAE in R from what the
  // daily fold has recorded so far; today's fold re-writes them after the close.
  const slip = t.slip_model_usd ?? 0;
  await prisma.$executeRawUnsafe(
    `UPDATE futures_desk_trades SET status = 'closed', exit_price = $2::float8, closed_at = now(), exit_reason = $3::text, pnl_usd = $4::float8, fees_usd = $5::float8,
     pnl_after_slip_usd = $6::float8, bars_held = COALESCE(bars_held, 0), mfe_r = $7::float8, mae_r = $8::float8 WHERE id = $1 AND status = 'open'`,
    t.id, fill.price, via, pnl, fees, pnlAfterSlip(pnl, slip), toR(t.mfe_pts, t.stop_points), toR(t.mae_pts, t.stop_points));
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
      // Far provisional (2× the distance from the OLD month's entry): months differ by the calendar
      // spread, and this bracket exists only until it is re-anchored to the new fill.
      const provisional = roundToTick(t.side === "long" ? t.entry_price - 2 * stopDist : t.entry_price + 2 * stopDist, next.tickSize);
      const r = await placeEntryWithStop({ contractId: next.id, action, qty: t.qty, stopPrice: provisional, clOrdId });
      if (!r.orderId) throw new Error(r.failure ?? "no orderId");
      orderId = r.orderId; stopOrderId = r.stopOrderId;
    } catch (e) {
      const found = await findOrderByClOrdId(clOrdId).catch(() => null);
      if (!found) { await rollFailed(t, `roll ${t.contract} → ${next.name} FAILED to re-open: ${String(e).slice(0, 140)}`); return; }
      orderId = found.id;
    }
  }
  // Same fill discipline as an entry: wait for the whole size, then cancel any remainder still working so
  // nothing keeps filling after the row is written; a partial roll is recorded as one.
  let fill = { qty: 0, price: 0 };
  for (let i = 0; i < 8 && fill.qty < t.qty; i++) { await new Promise((r) => setTimeout(r, 750)); fill = avgFill(await fillsForOrder(orderId)); }
  if (fill.qty === 0) { const o = await orderItem(orderId); if (o && isWorking(o)) await cancelDeskOrder(orderId).catch(() => {}); await rollFailed(t, `roll into ${next.name}: entry ${orderId} not filled (${o?.ordStatus ?? "?"})`); return; }
  const partial = fill.qty < t.qty;
  if (partial) { const o = await orderItem(orderId); if (o && isWorking(o)) await cancelDeskOrder(orderId).catch(() => {}); }
  const stopPx = roundToTick(t.side === "long" ? fill.price - stopDist : fill.price + stopDist, next.tickSize);
  // Ledger row first (the new leg keeps the ORIGINAL opened_at so the time stop does not restart), then protection.
  // The journal stamps travel with the chain; the new leg models its own round trip of slippage.
  const newId = await insertTrade({
    openedAt: t.opened_at, edge: t.edge, root: t.root, micro: t.micro, contract: next.name, contractId: next.id, side: t.side, qty: fill.qty, entryPrice: fill.price, stopPrice: stopPx,
    entryOrderId: orderId, stopOrderId, clOrdId, signalId: t.signal_id, riskUsd: t.risk_usd, pointValue: t.point_value, rolledFrom: t.id, note: `rolled from ${t.contract}${partial ? ` — partial fill ${fill.qty}/${t.qty}` : ""}`,
    contractMonth: next.name.slice(-2), stage: t.stage, signalPrice: t.signal_price, entrySlipPts: t.entry_slip_pts, stopPoints: stopDist, atrAtEntry: t.atr_at_entry,
    session: t.session, regime: t.regime, eventMode: t.event_mode, grade: t.grade, errorClass: partial ? "partial_fill" : null, slipModelPts: slipPtsPerSide(t.root), slipModelUsd: slipModelUsd(t.root, fill.qty, t.point_value),
  });
  if (stopOrderId) { try { await modifyStop(stopOrderId, fill.qty, stopPx); } catch { /* verified below */ } }
  const stopId = await ensureProtected({ contractId: next.id, contract: next.name, side: t.side, qty: fill.qty, stopPx, stopOrderId, clOrdId, why: "roll" });
  await recordProtection(newId, stopId);
  notes.push(`${t.contract} → ${next.name} rolled${stopId == null ? " — UNPROTECTABLE, closed" : ""}`);
  await sendNotification(`🔁 FUTURES DESK rolled ${t.contract} → ${next.name}: ${fill.qty}× @ ${fill.price}, stop ${stopPx}${partial ? ` — PARTIAL (${fill.qty} of ${t.qty})` : ""}.`, LANE).catch(() => {});
}

/** The old month is closed and the new one did not open: the chain ends here, classed `roll_failed`. */
async function rollFailed(t: TradeRow, why: string): Promise<void> {
  await prisma.$executeRawUnsafe(`UPDATE futures_desk_trades SET error_class = 'roll_failed' WHERE id = $1`, t.id).catch(() => {});
  await sendNotification(`🚨 FUTURES DESK ${why}. Position is CLOSED, not rolled.`, LANE).catch(() => {});
}

export async function setDeskEnabled(enabled: boolean, who: string): Promise<void> {
  await setKey("futures_desk_enabled", enabled ? "true" : "false");
  // Enabling after a drawdown disable is a fresh start: the high is re-based to today's equity, or
  // the guardian would disable it again on its next run.
  // The execution-error trip restarts from today's count: three MORE errors, not the three already on the board.
  const day = etDayKey(new Date());
  const count = enabled ? executionErrorsToday(await executionErrorEvents().catch(() => []), day) : 0;
  await patchState((s) => { if (enabled) { s.disabledReason = undefined; s.equityHigh = s.equity ?? 0; s.execErrorBaseline = { day, count }; } });
  await sendNotification(`${enabled ? "▶️" : "⏸"} FUTURES DESK ${enabled ? "ENABLED" : "DISABLED"} by ${who}.`, LANE).catch(() => {});
}

/** A person has looked: the anomaly key is emptied and entries resume on the next alert. */
export async function clearAnomaly(who: string): Promise<void> {
  const open = parseAnomaly(await cfg(ANOMALY_KEY));
  await setKey(ANOMALY_KEY, "");
  await patchState((s) => { for (const k of Object.keys(s.alerts)) if (k.startsWith("anomaly-")) delete s.alerts[k]; });
  await sendNotification(`✅ FUTURES DESK anomaly cleared by ${who}${open ? ` (${open.detail})` : ""} — entries resume.`, LANE).catch(() => {});
}

/** Promote the 0–100 score from a stamp to a size (E7): Strong/A+ budgets unlock and `futures_desk_min_score`
 *  starts refusing. The route has already required a GREEN `scorePromotionVerdict`; this only records and announces. */
export async function promoteScore(who: string): Promise<void> {
  await setKey(SCORE_PROMOTED_KEY, "true");
  await sendNotification(`🎯 FUTURES DESK score PROMOTED by ${who}: Strong (≥ 80) and A+ (≥ 90) budgets unlock; the desk minimum score now refuses.`, LANE).catch(() => {});
}

/** Advance the sizing stage (A→B→C) — the route checks readiness first; this only records and announces. */
export async function setDeskStage(to: Stage, who: string): Promise<void> {
  await setKey("futures_desk_stage", to);
  await sendNotification(`⬆️ FUTURES DESK stage → ${to} by ${who}.`, LANE).catch(() => {});
}

export { EDGES };
