// THE LIVE LEDGER READ (Sep 15 2026) — pure functions over the durable intents the executor wrote.
// Round trips pair a filled `open` with the `close` that names it; the divergence verdict is the
// gate for the second slot: the last ten trips must carry no `unknown` intent, every stamped broker
// review fee must sit inside the reserve, and fills must land within 5% of the limit we sent.
// A fill price is read from the broker order when it decoded one (fail-soft `averagePrice`); with
// none on file the limit stands in and the row says so (`fillSource: "limit"`).
import type { OptionsIntentRecord } from "./options-live-executor";

export const OPTIONS_LEDGER_RULES = { divergenceWindow: 10, maxFillDivergenceFrac: 0.05 };
export interface RoundTrip { open: OptionsIntentRecord; close: OptionsIntentRecord | null; closed: boolean }
const filled = (r: OptionsIntentRecord) => r.state === "settled" && r.order?.state === "filled";
/** Filled, settled opens paired with the filled close whose positionId is the open's refId. Oldest first. */
export function roundTrips(intents: OptionsIntentRecord[]): RoundTrip[] {
  const closes = intents.filter((r) => r.action === "close" && filled(r));
  return intents.filter((r) => r.action === "open" && filled(r))
    .sort((a, b) => (a.createdAtMs ?? 0) - (b.createdAtMs ?? 0))
    .map((open) => { const close = closes.find((c) => c.positionId === open.refId) ?? null; return { open, close, closed: close != null }; });
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
    for (const rec of [t.open, t.close!]) {
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
