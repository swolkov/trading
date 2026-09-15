// THE LIVE LEDGER READ (Sep 15 2026) — pure functions over the durable intents the executor wrote.
// Round trips pair a filled `open` with the `close` that names it; the divergence verdict is the
// gate for the second slot: the last ten trips must carry no `unknown` intent, every stamped broker
// review fee must sit inside the reserve, and fills must land within 5% of the limit we sent.
// A fill price is read from the broker order when it decoded one (fail-soft `averagePrice`); with
// none on file the limit stands in and the row says so (`fillSource: "limit"`).
import type { OptionsIntentRecord } from "./options-live-executor";

export const OPTIONS_LEDGER_RULES = { divergenceWindow: 10, maxFillDivergenceFrac: 0.05 };
export interface RoundTrip { open: OptionsIntentRecord; closes: OptionsIntentRecord[]; openQuantity: number; closedQuantity: number; closed: boolean }
/** Contracts an intent actually filled: the whole intent when the order filled; what the broker reported (never less than the
 *  monotonic evidence) when it was cancelled with fills; nothing otherwise. */
export function filledQuantityOf(r: OptionsIntentRecord): number {
  if (!r.order) return 0;
  if (r.order.state === "filled") return r.intent?.quantity ?? r.order.filledQuantity;
  if (["cancelled", "rejected"].includes(r.order.state)) return Math.min(r.intent?.quantity ?? 0, Math.max(r.order.filledQuantity, r.maxFilledQuantity ?? 0));
  return 0;
}
const settledWithFills = (r: OptionsIntentRecord) => r.state === "settled" && filledQuantityOf(r) > 0;
/** Settled opens with fills, each with EVERY settled close that names it (a 2-lot may close in two partials); closed only once the
 *  closes' filled quantities add up to the open's. Oldest first. */
export function roundTrips(intents: OptionsIntentRecord[]): RoundTrip[] {
  const closes = intents.filter((r) => r.action === "close" && settledWithFills(r));
  return intents.filter((r) => r.action === "open" && settledWithFills(r))
    .sort((a, b) => (a.createdAtMs ?? 0) - (b.createdAtMs ?? 0))
    .map((open) => {
      const mine = closes.filter((c) => c.positionId === open.refId).sort((a, b) => (a.createdAtMs ?? 0) - (b.createdAtMs ?? 0));
      const openQuantity = filledQuantityOf(open), closedQuantity = mine.reduce((n, c) => n + filledQuantityOf(c), 0);
      return { open, closes: mine, openQuantity, closedQuantity, closed: closedQuantity >= openQuantity };
    });
}
export interface DivergenceRow { refId: string; action: "open" | "close"; limit: number; fill: number; fillSource: "broker" | "limit"; divergenceFrac: number; feeUsd: number | null; ok: boolean; note: string }
export interface DivergenceVerdict { green: boolean; closedTrades: number; checked: number; reasons: string[]; rows: DivergenceRow[] }
/** Green only when nothing in the window is unknown, unpriced-over-reserve or filled far from its limit. `feeReserveUsd` is per contract round trip. */
export function divergenceVerdict(trips: RoundTrip[], intents: OptionsIntentRecord[], feeReserveUsd: number | null, rules = OPTIONS_LEDGER_RULES): DivergenceVerdict {
  const reasons: string[] = [], rows: DivergenceRow[] = [];
  const unknown = intents.filter((r) => r.state === "unknown");
  if (unknown.length) reasons.push(`${unknown.length} unknown intent${unknown.length === 1 ? "" : "s"} (${unknown.map((r) => r.refId.slice(0, 8)).join(", ")})`);
  const closed = trips.filter((t) => t.closed);
  for (const t of closed.slice(-rules.divergenceWindow)) {
    for (const rec of [t.open, ...t.closes]) {
      const limit = rec.intent?.limitPrice ?? Number(rec.canonicalOrder?.price ?? NaN), qty = rec.intent?.quantity ?? 1;
      const broker = rec.order?.averagePrice;
      const fill = typeof broker === "number" && Number.isFinite(broker) && broker > 0 ? broker : limit;
      const fillSource: DivergenceRow["fillSource"] = fill === broker ? "broker" : "limit";
      const divergenceFrac = limit > 0 ? Math.round(Math.abs(fill - limit) / limit * 10000) / 10000 : Number.POSITIVE_INFINITY;
      const feeUsd = rec.review?.estimatedFeeUsd ?? null;
      const notes: string[] = [];
      if (!(divergenceFrac <= rules.maxFillDivergenceFrac)) notes.push(`fill ${fill} vs limit ${limit} diverges ${(divergenceFrac * 100).toFixed(1)}%`);
      if (feeUsd != null && (feeReserveUsd == null || feeUsd > feeReserveUsd * qty)) notes.push(`review fee $${feeUsd} over the $${feeReserveUsd == null ? "unset" : feeReserveUsd * qty} reserve`);
      rows.push({ refId: rec.refId, action: rec.action, limit, fill, fillSource, divergenceFrac, feeUsd, ok: notes.length === 0, note: notes.join("; ") || (fillSource === "limit" ? "no broker fill price on file — limit assumed" : "ok") });
      for (const n of notes) reasons.push(`${rec.action} ${rec.refId.slice(0, 8)}: ${n}`);
    }
  }
  return { green: reasons.length === 0, closedTrades: closed.length, checked: Math.min(closed.length, rules.divergenceWindow), reasons, rows };
}
