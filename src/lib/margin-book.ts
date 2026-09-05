// THE BOOK RECONCILER — the one primitive the guardian and the executor's close path both
// use to make a pair+side's protection match its ACTUAL remaining exposure.
//
// Kraken attaches stops to a pair and side (not to a position), nets closes FIFO, can
// partially fill a market close (market-price protection), and its attached close[] stop
// is NOT reduce-only. So "what we sent" is never the truth; "what is resting against what
// is open" is. The planner is PURE: given the book's remaining bot volume, the level its
// stop should rest at, and the stops we hold on that pair+side, it returns the minimal set
// of actions that leaves EXACTLY ONE full-volume reduce-only stop at that level (or
// better) and nothing else of ours resting there. Applying the plan is place-first,
// cancel-after; a failed cancel is reported, never hidden, and the next run re-plans.
//
// Invariant after a successful apply: one fixed stop, vol ≈ remaining exposure (±1%),
// level at least the target (long: ≥, short: ≤), no other stop of ours on the pair+side.
// If exposure is zero: no stop of ours on the pair+side at all.
import { LIVE_STOP_RATCHET_MIN_FRAC } from "@/lib/margin-live-risk";

export interface BookStop { txid: string; ordertype: string; side: string; price: number; vol: number; volExec: number; opentm: number }
export interface BookState { side: "long" | "short"; vol: number; targetLevel: number; px: number; priceDecimals: number; lotDecimals: number }
export interface ReconcilePlan {
  place: { level: string; vol: string } | null;   // a new reduce-only stop to place FIRST
  cancel: string[];                                // then cancel these (everything else of ours)
  keeper: string | null;                           // the stop that already satisfies the invariant
  covered: boolean;                                // true when, after the plan, cover is complete
  reason: string;
  blocked: string | null;                          // a reason NOT to act this run (unknown state)
}

const remaining = (o: BookStop) => Math.max(0, (o.vol ?? 0) - (o.volExec ?? 0));

/** Is `level` at least as protective as `target` for this side, within the ratchet threshold
 *  (a resting stop a hair below the target is not worth an order pair)? */
function atLeastAsGood(side: "long" | "short", level: number, target: number, px = 0): boolean {
  const tol = px > 0 ? px * LIVE_STOP_RATCHET_MIN_FRAC : 0;
  return side === "long" ? level >= target - tol : level <= target + tol;
}

/** Rounded, on the safe side of the market by ≥0.05%. Returns the string to submit, or null. */
export function safeStopString(side: "long" | "short", target: number, px: number, decimals: number): string | null {
  if (!(px > 0) || !Number.isFinite(target) || !(target > 0)) return null;
  const s = target.toFixed(Math.max(0, decimals));
  const r = parseFloat(s);
  const gap = side === "long" ? px - r : r - px;
  return gap >= px * LIVE_STOP_RATCHET_MIN_FRAC ? s : null;
}

export function planReconcile(book: BookState, ours: BookStop[]): ReconcilePlan {
  const none: ReconcilePlan = { place: null, cancel: [], keeper: null, covered: false, reason: "", blocked: null };
  const closeSide = book.side === "long" ? "sell" : "buy";
  const mine = ours.filter((o) => o.side === closeSide && o.ordertype.includes("stop"));
  const fixed = mine.filter((o) => o.ordertype === "stop-loss");
  const trailing = mine.filter((o) => o.ordertype !== "stop-loss");

  // Exposure gone: nothing of ours may rest here (a resting non-reduce-only stop OPENS).
  if (!(book.vol > 0)) {
    return { ...none, cancel: mine.map((o) => o.txid), covered: true, reason: mine.length ? "flat: sweep all stops" : "flat" };
  }
  // A fixed stop whose trigger we cannot read is an UNKNOWN, not a zero — do not act.
  if (fixed.some((o) => !(o.price > 0))) return { ...none, blocked: "a resting stop has no readable trigger price" };
  if (!(book.px > 0)) return { ...none, blocked: "no price" };

  // A trailing stop is Kraken-managed; we never second-guess its level. If trailing cover
  // alone is complete, leave the book alone (a fixed stop beside a non-reduce-only trailing
  // one could fire first and strand it). If it is short, cover ONLY the shortfall.
  const trailingVol = trailing.reduce((s, o) => s + remaining(o), 0);
  if (trailing.length) {
    const short = book.vol - trailingVol;
    const fixedVol = fixed.reduce((s, o) => s + remaining(o), 0);
    if (short <= book.vol * 0.01) return { ...none, cancel: fixed.map((o) => o.txid), keeper: null, covered: true, reason: "trailing covers the book" };
    if (fixedVol >= short * 0.99 && fixedVol <= short * 1.01) return { ...none, covered: true, reason: "trailing + fixed cover the book" };
    const level = safeStopString(book.side, book.targetLevel, book.px, book.priceDecimals);
    if (!level) return { ...none, blocked: "no safe level for the trailing shortfall" };
    return { ...none, place: { level, vol: short.toFixed(book.lotDecimals) }, cancel: fixed.map((o) => o.txid), covered: true, reason: "cover the trailing shortfall" };
  }

  // Fixed stops only. A keeper is one stop whose remaining volume matches the book (±1%)
  // and whose level is at least the target.
  const volOk = (o: BookStop) => remaining(o) >= book.vol * 0.99 && remaining(o) <= book.vol * 1.01;
  const good = fixed.filter((o) => volOk(o) && atLeastAsGood(book.side, o.price, book.targetLevel, book.px));
  if (good.length) {
    // Best-priced, tie → newest. Everything else goes (duplicates, partials, oversized).
    const keeper = [...good].sort((a, b) => (book.side === "long" ? b.price - a.price : a.price - b.price) || b.opentm - a.opentm)[0];
    return { ...none, keeper: keeper.txid, cancel: fixed.filter((o) => o.txid !== keeper.txid).map((o) => o.txid), covered: true, reason: fixed.length > 1 ? "dedupe to the keeper" : "already covered" };
  }
  // No keeper: place one exact, reduce-only stop at the target (or the best resting level
  // if that is better — never loosen), then remove everything else.
  const bestResting = fixed.length ? fixed.reduce((b, o) => (book.side === "long" ? Math.max(b, o.price) : Math.min(b, o.price)), fixed[0].price) : null;
  const level = bestResting != null && atLeastAsGood(book.side, bestResting, book.targetLevel, book.px) ? bestResting : book.targetLevel;
  const levelStr = safeStopString(book.side, level, book.px, book.priceDecimals);
  if (!levelStr) {
    // Cannot place at the target without firing on acceptance: the market has already moved
    // past it. The caller decides (a breach); do not strip whatever cover exists.
    return { ...none, blocked: "target is at or through the market" };
  }
  return { ...none, place: { level: levelStr, vol: book.vol.toFixed(book.lotDecimals) }, cancel: fixed.map((o) => o.txid), covered: true, reason: fixed.length ? "replace stops with one exact stop" : "naked: place stop" };
}

export interface ReconcileIO {
  placeStop: (level: string, vol: string) => Promise<string | undefined>;   // returns txid
  cancel: (txid: string) => Promise<void>;
}
export interface ReconcileOutcome { placed: string | null; cancelled: string[]; failedCancels: string[]; placeFailed: string | null; covered: boolean }

/**
 * Apply a plan: place first (so cover never drops), then cancel the rest with one retry.
 * A failed placement leaves everything as it was. Failed cancels are returned, never hidden.
 * The caller re-plans next run; nothing here assumes its own success.
 */
export async function applyReconcile(plan: ReconcilePlan, io: ReconcileIO): Promise<ReconcileOutcome> {
  const out: ReconcileOutcome = { placed: null, cancelled: [], failedCancels: [], placeFailed: null, covered: false };
  if (plan.blocked) return out;
  if (plan.place) {
    try {
      out.placed = (await io.placeStop(plan.place.level, plan.place.vol)) ?? "placed";
    } catch (e) {
      out.placeFailed = String(e).slice(0, 160);
      return out;   // do not cancel anything: the old cover is all there is
    }
  }
  for (const txid of plan.cancel) {
    try { await io.cancel(txid); out.cancelled.push(txid); }
    catch { try { await io.cancel(txid); out.cancelled.push(txid); } catch { out.failedCancels.push(txid); } }
  }
  out.covered = plan.covered && out.placeFailed == null;
  return out;
}
