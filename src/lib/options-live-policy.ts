// Live policy is separate from the paper model: broker identities, fresh quotes and an
// explicit dollar authorization are mandatory. This module never connects to a broker.
import { createHash } from "node:crypto";
import type { StructureKind } from "@/lib/options-structures";

export const OPTIONS_LIVE_ACCOUNT = "685528705";
export const LIVE_SNAPSHOT_MAX_AGE_MS = 15_000;
export const LIVE_GUARDIAN_MAX_AGE_MS = 60_000;
export interface OptionsLivePolicy {
  armed: boolean;
  maxLossUsd: number | null; // No default. Includes the complete fee reserve.
  feeBudgetUsd: number | null; // Explicit reserve for the whole round trip.
  guardianHealthyAtMs: number | null;
}
export interface LiveContract {
  optionId: string; underlying: string; kind: "call" | "put"; strike: number;
  expiry: string; multiplier: number; bid: number; ask: number; quoteAtMs: number;
}
export interface LivePositionLeg { optionId: string; side: "long" | "short"; quantity: number }
export interface LivePosition { id: string; legs: LivePositionLeg[] }
export interface OwnedOptionsPosition extends LivePosition { accountNumber: string; openingRefId: string }
export type OrderState = "pending" | "open" | "partially_filled" | "filled" | "cancelled" | "rejected";
export interface NormalizedOptionsOrder {
  id: string; accountNumber: string; refId: string; requestFingerprint: string;
  state: OrderState; filledQuantity: number;
}
export interface OptionsBrokerSnapshot {
  accountNumber: string; active: boolean; agenticAllowed: boolean;
  optionLevel: "option_level_3"; marginType: "limited_margin";
  asOfMs: number; complete: boolean; buyingPowerUsd: number;
  regularSession: { opensAtMs: number; closesAtMs: number } | null;
  positions: LivePosition[];
  // Includes ALL active orders, plus historical orders matching the requested ref_id.
  orders: NormalizedOptionsOrder[];
  contracts: LiveContract[];
}
export interface OptionsLiveIntent {
  refId: string; action: "open" | "close"; kind: StructureKind;
  positionId?: string; quantity: number; limitPrice: number;
  legs: { optionId: string; side: "buy" | "sell" }[];
}
export interface OptionOrderParams {
  account_number: string;
  legs: { option_id: string; side: "buy" | "sell"; position_effect: "open" | "close"; ratio_quantity: number }[];
  quantity: string; direction: "debit" | "credit"; type: "limit"; price: string;
  time_in_force: "gfd"; market_hours: "regular_hours";
}
export interface PreparedOptionsOrder {
  params: OptionOrderParams; fingerprint: string; theoreticalMaxLossUsd: number;
}
const positive = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n) && n > 0;
const nonnegative = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n) && n >= 0;
const fresh = (at: number | null, now: number, maxAge: number) => at != null && Number.isFinite(at) && at <= now && now - at <= maxAge;
const fail = (reason: string): never => { throw new Error(`Options live refused: ${reason}`); };

export function optionsRequestFingerprint(params: OptionOrderParams): string {
  return createHash("sha256").update(JSON.stringify(params)).digest("hex");
}
export function validateOptionsSnapshot(snapshot: OptionsBrokerSnapshot, now: number): void {
  if (snapshot.accountNumber !== OPTIONS_LIVE_ACCOUNT || !snapshot.active || !snapshot.agenticAllowed
    || snapshot.optionLevel !== "option_level_3" || snapshot.marginType !== "limited_margin") fail("account identity or permissions do not match the authorized Agentic account");
  if (!snapshot.complete || !fresh(snapshot.asOfMs, now, LIVE_SNAPSHOT_MAX_AGE_MS)) fail("incomplete or stale broker snapshot");
  if (!nonnegative(snapshot.buyingPowerUsd)) fail("unreadable buying power");
}

export function prepareOptionsOrder(intent: OptionsLiveIntent, policy: OptionsLivePolicy,
  snapshot: OptionsBrokerSnapshot, owned: OwnedOptionsPosition | null, now: number): PreparedOptionsOrder {
  validateOptionsSnapshot(snapshot, now);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(intent.refId)) fail("ref_id must be a UUID");
  if (!["open", "close"].includes(intent.action)) fail("unknown action");
  if (!Number.isSafeInteger(intent.quantity) || intent.quantity < 1) fail("quantity must be a positive integer");
  if (!positive(intent.limitPrice) || Math.abs(intent.limitPrice * 100 - Math.round(intent.limitPrice * 100)) > 1e-7) fail("limit must be a positive cent-denominated price");
  if (!positive(policy.feeBudgetUsd)) fail("explicit positive round-trip fee budget required");
  const session = snapshot.regularSession;
  if (!session || !Number.isFinite(session.opensAtMs) || !Number.isFinite(session.closesAtMs)
    || now < session.opensAtMs || now >= session.closesAtMs) fail("outside a verified regular trading session");
  const active = snapshot.orders.filter((o) => !["filled", "cancelled", "rejected"].includes(o.state));
  if (active.length) fail("outstanding broker orders must resolve first");
  if (intent.action === "open") {
    if (!policy.armed) fail("live entries are disarmed");
    if (!positive(policy.maxLossUsd)) fail("explicit positive maximum loss required");
    if (!fresh(policy.guardianHealthyAtMs, now, LIVE_GUARDIAN_MAX_AGE_MS)) fail("live guardian is not healthy");
    if (snapshot.positions.length) fail("one-position account limit");
  }
  if (intent.legs.length < 1 || intent.legs.length > 2 || new Set(intent.legs.map((l) => l.optionId)).size !== intent.legs.length) fail("only a long option or a two-leg vertical is allowed");
  const contracts = intent.legs.map((leg) => {
    if (!["buy", "sell"].includes(leg.side)) fail("invalid leg side");
    const matches = snapshot.contracts.filter((c) => c.optionId === leg.optionId);
    if (matches.length !== 1) fail("contract metadata missing or ambiguous");
    const c = matches[0];
    if (!c.underlying || !["call", "put"].includes(c.kind) || c.multiplier !== 100 || !positive(c.strike)
      || !/^\d{4}-\d{2}-\d{2}$/.test(c.expiry) || !Number.isFinite(Date.parse(c.expiry))
      || (intent.action === "open" ? Date.parse(c.expiry) <= now : c.expiry < new Date(now).toISOString().slice(0, 10))) fail("unsupported, adjusted, expired or invalid contract");
    if (!fresh(c.quoteAtMs, now, LIVE_SNAPSHOT_MAX_AGE_MS) || !nonnegative(c.bid) || !positive(c.ask) || c.ask < c.bid) fail("missing, stale or crossed quote");
    return c;
  });
  // Close only the complete, explicitly owned structure; never sell an unowned long or
  // buy back a manual short just because it shares a ticker.
  if (intent.action === "close") {
    const actual = snapshot.positions.filter((p) => p.id === intent.positionId);
    if (!owned || owned.accountNumber !== OPTIONS_LIVE_ACCOUNT || owned.id !== intent.positionId || actual.length !== 1
      || owned.legs.length !== intent.legs.length || actual[0].legs.length !== intent.legs.length) fail("closing position ownership is unverified");
    for (const leg of intent.legs) {
      const side = leg.side === "sell" ? "long" : "short";
      if (!owned!.legs.some((l) => l.optionId === leg.optionId && l.side === side && l.quantity === intent.quantity)
        || !actual[0].legs.some((l) => l.optionId === leg.optionId && l.side === side && l.quantity === intent.quantity)) fail("close must exactly match owned remaining legs and quantity");
    }
  }
  const entrySides = intent.legs.map((l) => intent.action === "open" ? l.side : l.side === "buy" ? "sell" : "buy");
  let width = 0;
  let entryDirection: "debit" | "credit" = "debit";
  if (contracts.length === 1) {
    if (entrySides[0] !== "buy" || intent.kind !== `long_${contracts[0].kind}`) fail("naked short or invalid single-leg kind");
  } else {
    const [a, b] = contracts;
    if (a.kind !== b.kind || a.expiry !== b.expiry || a.underlying !== b.underlying || a.strike === b.strike
      || entrySides.filter((s) => s === "buy").length !== 1) fail("legs must form a same-expiry, same-underlying 1:1 vertical");
    const long = contracts[entrySides.indexOf("buy")], short = contracts[entrySides.indexOf("sell")];
    entryDirection = (a.kind === "call" ? long.strike < short.strike : long.strike > short.strike) ? "debit" : "credit";
    if (intent.kind !== `${a.kind}_${entryDirection}`) fail("structure kind does not match its strikes and sides");
    width = Math.abs(a.strike - b.strike);
    if (intent.limitPrice > width || (intent.action === "open" && intent.limitPrice === width)) fail("vertical entry limit must be below its width; a close may equal the width");
  }
  const direction = intent.action === "open" ? entryDirection : entryDirection === "debit" ? "credit" : "debit";
  const theoreticalMaxLossUsd = intent.action === "close" ? 0
    : (entryDirection === "debit" ? intent.limitPrice : width - intent.limitPrice) * 100 * intent.quantity;
  if (intent.action === "open" && (theoreticalMaxLossUsd + policy.feeBudgetUsd! > policy.maxLossUsd!
    || theoreticalMaxLossUsd + policy.feeBudgetUsd! > snapshot.buyingPowerUsd)) fail("maximum loss plus fee reserve exceeds the authorized budget or buying power");
  const params: OptionOrderParams = {
    account_number: OPTIONS_LIVE_ACCOUNT,
    legs: intent.legs.map((l) => ({ option_id: l.optionId, side: l.side, position_effect: intent.action, ratio_quantity: 1 })),
    quantity: String(intent.quantity), direction, type: "limit", price: intent.limitPrice.toFixed(2),
    time_in_force: "gfd", market_hours: "regular_hours",
  };
  return { params, fingerprint: optionsRequestFingerprint(params), theoreticalMaxLossUsd };
}
