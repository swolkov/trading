// Execution core only. No production OAuth bridge, scheduler or permissive response
// decoder is installed here. Broker I/O and durable storage must be supplied explicitly.
import {
  OPTIONS_LIVE_ACCOUNT, LIVE_SNAPSHOT_MAX_AGE_MS, prepareOptionsOrder, validateOptionsSnapshot,
  type OptionsLiveIntent, type OptionsLivePolicy, type OptionsBrokerSnapshot,
  type OwnedOptionsPosition, type NormalizedOptionsOrder, type PreparedOptionsOrder,
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
}
export interface OptionsIntentRecord {
  refId: string; accountNumber: string; action: "open" | "close"; positionId?: string;
  fingerprint: string; state: "submitting" | "unknown" | "accepted" | "settled";
  order?: NormalizedOptionsOrder;
  maxFilledQuantity?: number; // Monotonic evidence; a later zero cannot erase a fill.
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
  snapshot: OptionsBrokerSnapshot, action: "open" | "close", now: number): void {
  if (!object(raw) || raw.approved !== true || raw.accountNumber !== OPTIONS_LIVE_ACCOUNT
    || raw.requestFingerprint !== prepared.fingerprint || !amount(raw.asOfMs) || raw.asOfMs > now
    || now - raw.asOfMs > LIVE_SNAPSHOT_MAX_AGE_MS || !amount(raw.maxLossUsd)
    || !amount(raw.estimatedFeeUsd) || !amount(raw.buyingPowerRequiredUsd)) throw new Error("review response schema or order identity is unverified");
  if (raw.estimatedFeeUsd > policy.feeBudgetUsd! || raw.buyingPowerRequiredUsd > snapshot.buyingPowerUsd) throw new Error("broker review exceeds fee reserve or available buying power");
  if (action === "open" && (raw.maxLossUsd < prepared.theoreticalMaxLossUsd
    || raw.maxLossUsd + policy.feeBudgetUsd! > policy.maxLossUsd!)) throw new Error("broker-reviewed maximum loss is incompatible with the authorized budget");
}
async function reconcileLocked(record: OptionsIntentRecord, deps: OptionsExecutorDependencies): Promise<OptionsExecutionResult> {
  const snapshot = await deps.broker.snapshot([], record.refId);
  validateOptionsSnapshot(snapshot, deps.now());
  const matches = snapshot.orders.filter((o) => o.refId === record.refId);
  if (matches.length !== 1) {
    await deps.store.putIntent({ ...record, state: "unknown" });
    return { status: "unknown", refId: record.refId, reason: "exact ref_id lookup returned zero or multiple orders; no resubmission" };
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
      checkReview(review, freshPrepared, policy, snapshot, intent.action, deps.now());
      const record: OptionsIntentRecord = { refId: intent.refId, accountNumber: OPTIONS_LIVE_ACCOUNT,
        action: intent.action, positionId: intent.positionId, fingerprint: prepared.fingerprint, state: "submitting" };
      // Durable reservation BEFORE the broker call. If the process dies here, zero orders
      // on a later lookup is still unknown, never permission to blindly retry.
      await deps.store.putIntent(record);
      mayHaveSubmitted = true;
      let raw: unknown;
      try { raw = await deps.broker.callTool("place_option_order", { ...prepared.params, ref_id: intent.refId }); }
      catch {
        await deps.store.putIntent({ ...record, state: "unknown" }).catch(() => {});
        return { status: "unknown", refId: intent.refId, reason: "submission response lost; reconcile exact ref_id before any further order" };
      }
      const order = matchingOrder(deps.broker.decodeOrder(raw), record);
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
