// Execution core only. No production OAuth bridge, scheduler or permissive response
// decoder is installed here. Broker I/O and durable storage must be supplied explicitly.
import {
  OPTIONS_LIVE_ACCOUNT, LIVE_SNAPSHOT_MAX_AGE_MS, prepareOptionsOrder, validateOptionsSnapshot,
  type OptionsLiveIntent, type OptionsLivePolicy, type OptionsBrokerSnapshot,
  type OwnedOptionsPosition, type NormalizedOptionsOrder, type PreparedOptionsOrder, type OptionOrderParams,
} from "@/lib/options-live-policy";

export interface OptionsOrderReview {
  approved: boolean; accountNumber: string; requestFingerprint: string; asOfMs: number;
  maxLossUsd: number; estimatedFeeUsd: number; buyingPowerRequiredUsd: number;
}
export interface OptionsLiveBroker {
  // Must remain false until captured real responses have been schema-validated. A truthy
  // assertion alone does not create the missing production adapter or authorization.
  responseSchemasVerified: boolean;
  callTool(name: "review_option_order" | "place_option_order", params: Record<string, unknown>): Promise<unknown>;
  snapshot(optionIds: string[], refId: string): Promise<OptionsBrokerSnapshot>;
  decodeReview(raw: unknown): unknown;
  decodeOrder(raw: unknown): unknown;
  /** Positive proof, from the broker's own full order list and positions, that an entry reservation never became an order.
   *  Optional: without it an unmatched reservation stays "unknown" for a human, as before. */
  proveNeverPlaced?(record: OptionsIntentRecord): Promise<NeverPlacedProof>;
}
export type NeverPlacedProof = { proven: true; evidence: string } | { proven: false; why: string };
/** How long an entry reservation must sit unmatched before the broker's silence counts as proof. Robinhood lists a new order
 *  within seconds; ten minutes is a wide margin, and at most two guard ticks (a page each) go by before it settles. */
export const NEVER_PLACED_GRACE_MS = 10 * 60_000;
export interface OptionsIntentRecord {
  refId: string; accountNumber: string; action: "open" | "close"; positionId?: string;
  fingerprint: string; state: "submitting" | "unknown" | "accepted" | "settled";
  order?: NormalizedOptionsOrder;
  canonicalOrder?: OptionOrderParams;
  intent?: OptionsLiveIntent;
  createdAtMs?: number;       // When the reservation was written — the adapter's lost-response recovery window starts here.
  maxFilledQuantity?: number; // Monotonic evidence; a later zero cannot erase a fill.
  /** The broker's own review figures, stamped after checkReview passed. On the record, not the intent: recovery identity is untouched. */
  review?: { estimatedFeeUsd: number; maxLossUsd: number; buyingPowerRequiredUsd: number };
  /** What the runner knew about the setup (thesis, range, grade) — written by the runner after acceptance; the intent stays canonical. */
  candidate?: Record<string, unknown>;
  /** The broker's own words when placement answered with an error (masked, ≤200 chars). Evidence for a human; never a settlement by itself. */
  placementError?: string;
  /** Set when the reservation was settled because the broker proved it never became an order (see settleNeverPlaced). */
  autoSettled?: { atMs: number; evidence: string };
}
export interface OptionsLiveStore {
  // Exclusive ACROSS PROCESSES, held through review/submission/persistence. Must not
  // expire while the callback can still place an order. Production implementation absent.
  withAccountLock<T>(account: string, work: () => Promise<T>): Promise<T>;
  getIntent(refId: string): Promise<OptionsIntentRecord | null>;
  putIntent(record: OptionsIntentRecord): Promise<void>;
  unsettledIntents(account: string): Promise<OptionsIntentRecord[]>;
  ownedPosition(positionId: string): Promise<OwnedOptionsPosition | null>;
}
export interface OptionsExecutorDependencies {
  broker: OptionsLiveBroker; store: OptionsLiveStore;
  policy(): Promise<OptionsLivePolicy>;
  now(): number;
}
export interface OptionsExecutionResult {
  status: "refused" | "accepted" | "unknown" | "settled";
  refId: string; reason?: string; orderId?: string;
  /** "settled" because the broker proved the reservation never became an order — the runner pages this once. */
  autoSettled?: boolean;
  /** "unknown" only because the grace window has not passed yet — the runner logs it instead of paging. */
  awaitingProof?: boolean;
}
const object = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);
const amount = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x) && x >= 0;
const states = ["pending", "open", "partially_filled", "filled", "cancelled", "rejected"];

function matchingOrder(raw: unknown, record: OptionsIntentRecord): NormalizedOptionsOrder | null {
  if (!object(raw) || typeof raw.id !== "string" || !raw.id || raw.accountNumber !== OPTIONS_LIVE_ACCOUNT
    || raw.refId !== record.refId || raw.requestFingerprint !== record.fingerprint
    || (record.order != null && raw.id !== record.order.id)
    || !states.includes(String(raw.state)) || !Number.isSafeInteger(raw.filledQuantity) || !amount(raw.filledQuantity)) return null;
  return raw as unknown as NormalizedOptionsOrder;
}
function checkReview(raw: unknown, prepared: PreparedOptionsOrder, policy: OptionsLivePolicy,
  snapshot: OptionsBrokerSnapshot, action: "open" | "close", now: number): OptionsIntentRecord["review"] {
  if (!object(raw) || raw.approved !== true || raw.accountNumber !== OPTIONS_LIVE_ACCOUNT
    || raw.requestFingerprint !== prepared.fingerprint || !amount(raw.asOfMs) || raw.asOfMs > now
    || now - raw.asOfMs > LIVE_SNAPSHOT_MAX_AGE_MS || !amount(raw.maxLossUsd)
    || !amount(raw.estimatedFeeUsd) || !amount(raw.buyingPowerRequiredUsd)) throw new Error("review response schema or order identity is unverified");
  const feeReserve = policy.feeBudgetUsd! * Number(prepared.params.quantity);   // per contract round trip, as in the policy
  if (raw.estimatedFeeUsd > feeReserve || raw.buyingPowerRequiredUsd > snapshot.buyingPowerUsd) throw new Error("broker review exceeds fee reserve or available buying power");
  if (action === "open" && (raw.maxLossUsd < prepared.theoreticalMaxLossUsd
    || raw.maxLossUsd + feeReserve > policy.maxLossUsd!)) throw new Error("broker-reviewed maximum loss is incompatible with the authorized budget");
  return { estimatedFeeUsd: raw.estimatedFeeUsd, maxLossUsd: raw.maxLossUsd, buyingPowerRequiredUsd: raw.buyingPowerRequiredUsd };
}
/** An ENTRY reservation that never got a broker order id, never saw a fill, and is older than the grace window may be
 *  settled — but only on the broker's positive proof that no order exists. Closes are never settled this way: a close that
 *  may have happened changes what the guardian manages, so it stays with a human. null = not eligible, leave it unknown. */
async function neverPlaced(record: OptionsIntentRecord, deps: OptionsExecutorDependencies): Promise<(NeverPlacedProof & { waiting?: boolean }) | null> {
  if (record.action !== "open" || record.order || (record.maxFilledQuantity ?? 0) > 0 || !record.canonicalOrder || !deps.broker.proveNeverPlaced) return null;
  const created = record.createdAtMs;
  if (typeof created !== "number" || !Number.isFinite(created)) return null;
  const age = deps.now() - created;
  if (age < NEVER_PLACED_GRACE_MS) return { proven: false, why: `no order at the broker yet; settles on its own after ${Math.ceil((NEVER_PLACED_GRACE_MS - age) / 60_000)} more min if none appears`, waiting: true };
  try { return await deps.broker.proveNeverPlaced(record); }
  catch (e) { return { proven: false, why: `could not prove it never reached the broker: ${String(e).slice(0, 160)}` }; }
}
async function reconcileLocked(record: OptionsIntentRecord, deps: OptionsExecutorDependencies): Promise<OptionsExecutionResult> {
  const snapshot = await deps.broker.snapshot([], record.refId);
  validateOptionsSnapshot(snapshot, deps.now());
  const matches = snapshot.orders.filter((o) => o.refId === record.refId);
  if (matches.length !== 1) {
    const proof = matches.length === 0 ? await neverPlaced(record, deps) : null;
    if (proof?.proven) {
      await deps.store.putIntent({ ...record, state: "settled", autoSettled: { atMs: deps.now(), evidence: proof.evidence } });
      return { status: "settled", refId: record.refId, autoSettled: true,
        reason: `never reached the broker — ${proof.evidence}${record.placementError ? `. Robinhood said: ${record.placementError}` : ""}` };
    }
    await deps.store.putIntent({ ...record, state: "unknown" });
    return { status: "unknown", refId: record.refId, awaitingProof: proof?.waiting === true,
      reason: `exact ref_id lookup returned zero or multiple orders; no resubmission${proof ? ` (${proof.why})` : ""}${record.placementError ? `. Robinhood said: ${record.placementError}` : ""}` };
  }
  const order = matchingOrder(matches[0], record);
  const observedFills = Math.max(record.maxFilledQuantity ?? 0, record.order?.filledQuantity ?? 0);
  if (!order || order.filledQuantity < observedFills) {
    // Retain the known broker ID and maximum fill evidence. An inconsistent cancellation
    // or reused ref_id must never erase exposure or free capacity for another entry.
    await deps.store.putIntent({ ...record, state: "unknown", maxFilledQuantity: observedFills });
    return { status: "unknown", refId: record.refId, reason: !order
      ? "broker order identity or shape does not match the saved intent"
      : "broker fill count regressed; previously observed fills remain unresolved" };
  }
  // A cancellation with fills still owns exposure. Only a confirmed no-fill rejection or
  // cancellation can release the reservation here. Filled-position lifecycle is the guardian's.
  const settled = ["cancelled", "rejected"].includes(order.state) && order.filledQuantity === 0;
  await deps.store.putIntent({ ...record, state: settled ? "settled" : "accepted", order, maxFilledQuantity: Math.max(observedFills, order.filledQuantity) });
  return { status: settled ? "settled" : "accepted", refId: record.refId, orderId: order.id };
}

export async function reconcileOptionsIntent(refId: string, deps: OptionsExecutorDependencies): Promise<OptionsExecutionResult> {
  if (!deps.broker.responseSchemasVerified) return { status: "refused", refId, reason: "production response adapter is not verified" };
  try {
    return await deps.store.withAccountLock(OPTIONS_LIVE_ACCOUNT, async () => {
      const record = await deps.store.getIntent(refId);
      if (!record || record.accountNumber !== OPTIONS_LIVE_ACCOUNT) return { status: "refused", refId, reason: "no owned durable intent" };
      if (record.state === "settled") return { status: "settled", refId, orderId: record.order?.id };
      return reconcileLocked(record, deps);
    });
  } catch (e) { return { status: "unknown", refId, reason: `reconciliation unavailable: ${String(e)}` }; }
}

export async function executeOptionsIntent(intent: OptionsLiveIntent, deps: OptionsExecutorDependencies): Promise<OptionsExecutionResult> {
  if (!deps.broker.responseSchemasVerified) return { status: "refused", refId: intent.refId, reason: "production response adapter is not verified" };
  let mayHaveSubmitted = false;
  try {
    return await deps.store.withAccountLock(OPTIONS_LIVE_ACCOUNT, async () => {
      const previous = await deps.store.getIntent(intent.refId);
      if (previous) {
        // A saved ref_id is never sent again, including after terminal broker rejection.
        // Changed user payload is irrelevant to recovery: recover the original saved order.
        if (previous.accountNumber !== OPTIONS_LIVE_ACCOUNT) throw new Error("ref_id belongs to another account");
        if (previous.state === "settled") return { status: "settled", refId: intent.refId, orderId: previous.order?.id };
        mayHaveSubmitted = true;
        return reconcileLocked(previous, deps);
      }
      const pending = await deps.store.unsettledIntents(OPTIONS_LIVE_ACCOUNT);
      if (pending.some((r) => intent.action === "open" || r.state !== "accepted" || r.action === "close")) throw new Error("an outstanding durable intent must reconcile first");
      const owned = intent.positionId ? await deps.store.ownedPosition(intent.positionId) : null;
      let policy = await deps.policy();
      let snapshot = await deps.broker.snapshot(intent.legs.map((l) => l.optionId), intent.refId);
      // A previously accepted order whose local receipt was lost must not be submitted
      // again even if there is no saved record. Unknown broker identity fails closed.
      if (snapshot.orders.some((o) => o.refId === intent.refId)) throw new Error("broker already has this ref_id without a local intent; reconcile manually");
      const prepared = prepareOptionsOrder(intent, policy, snapshot, owned, deps.now());
      const rawReview = await deps.broker.callTool("review_option_order", { ...prepared.params });
      const review = deps.broker.decodeReview(rawReview);
      checkReview(review, prepared, policy, snapshot, intent.action, deps.now());
      // Disarm or position changes during review must win over the earlier snapshot.
      policy = await deps.policy();
      snapshot = await deps.broker.snapshot(intent.legs.map((l) => l.optionId), intent.refId);
      const currentOwned = intent.positionId ? await deps.store.ownedPosition(intent.positionId) : null;
      const freshPrepared = prepareOptionsOrder(intent, policy, snapshot, currentOwned, deps.now());
      if (freshPrepared.fingerprint !== prepared.fingerprint || snapshot.orders.some((o) => o.refId === intent.refId)) throw new Error("order identity changed during review");
      const reviewed = checkReview(review, freshPrepared, policy, snapshot, intent.action, deps.now());
      const record: OptionsIntentRecord = { refId: intent.refId, accountNumber: OPTIONS_LIVE_ACCOUNT,
        action: intent.action, positionId: intent.positionId, fingerprint: prepared.fingerprint, state: "submitting", canonicalOrder: structuredClone(prepared.params), intent: structuredClone(intent), createdAtMs: deps.now(), review: reviewed };
      // Durable reservation BEFORE the broker call. If the process dies here, zero orders
      // on a later lookup is still unknown, never permission to blindly retry. (An ENTRY may later be
      // settled on the broker's positive proof — neverPlaced — but this ref_id is never sent again.)
      await deps.store.putIntent(record);
      mayHaveSubmitted = true;
      let raw: unknown;
      try { raw = await deps.broker.callTool("place_option_order", { ...prepared.params, ref_id: intent.refId }); }
      catch {
        await deps.store.putIntent({ ...record, state: "unknown" }).catch(() => {});
        return { status: "unknown", refId: intent.refId, reason: "submission response lost; reconcile exact ref_id before any further order" };
      }
      // A placement that answers with an error is still "unknown", never "rejected": the error may have come after the
      // order was created. Keep the broker's words on the record; reconciliation settles it only on the broker's proof.
      let decoded: unknown;
      try { decoded = deps.broker.decodeOrder(raw); }
      catch (e) {
        const why = (e instanceof Error ? e.message : String(e)).slice(0, 300);
        await deps.store.putIntent({ ...record, state: "unknown", placementError: why }).catch(() => {});
        return { status: "unknown", refId: intent.refId, reason: `placement answered with an error (${why}); no retry — it settles on its own if the broker shows no order ${NEVER_PLACED_GRACE_MS / 60_000} min on` };
      }
      const order = matchingOrder(decoded, record);
      if (!order) {
        await deps.store.putIntent({ ...record, state: "unknown" }).catch(() => {});
        return { status: "unknown", refId: intent.refId, reason: "unrecognized placement response; no retry" };
      }
      const settled = ["cancelled", "rejected"].includes(order.state) && order.filledQuantity === 0;
      await deps.store.putIntent({ ...record, state: settled ? "settled" : "accepted", order, maxFilledQuantity: order.filledQuantity });
      return { status: settled ? "settled" : "accepted", refId: intent.refId, orderId: order.id };
    });
  } catch (e) {
    return { status: mayHaveSubmitted ? "unknown" : "refused", refId: intent.refId, reason: String(e) };
  }
}
