// THE ROBINHOOD ADAPTER for the options live core (Sep 13 2026). This is the only file that knows
// the broker's response shapes. Everything it hands the core is either decoded strictly from a
// named field or derived from the exact request we sent — never guessed.
//
// Two facts about the broker shape this design rests on (verified against the published tool
// catalog, docs/ROBINHOOD-DIRECT-READINESS-2026-09-12.md):
//   1. place_option_order ACCEPTS ref_id but neither the placement response nor get_option_orders
//      returns or filters on it. So the ref_id ↔ order binding is made HERE: on a placement response
//      by the ref_id we just sent; on a later lookup by the durable intent's saved broker order id;
//      and only for a LOST placement response by an exact-legs match among orders that Robinhood
//      itself labels placed_agent="agentic" inside the intent's time window. Nothing else on this
//      account places agentic orders (the collector and research sessions are read-only), and the
//      store allows ONE unsettled intent at a time, so a single such order is ours; two are
//      ambiguous and stay "unknown" (the core refuses to trade until a human resolves it).
//   2. The review response's fee and buying-power fields are read by name; if the fee cannot be
//      found the review is unverified and the order is NOT placed — fees are inside the $100 cap.
import {
  OPTIONS_LIVE_ACCOUNT, optionsRequestFingerprint,
  type LiveContract, type LivePosition, type OptionOrderParams, type OptionsBrokerSnapshot,
  type OrderState, type OwnedOptionsPosition,
} from "./options-live-policy";
import type { NeverPlacedProof, OptionsIntentRecord, OptionsLiveBroker, OptionsOrderReview } from "./options-live-executor";
import { unwrapRobinhoodRead } from "./options-direct-collector";

const record = (x: unknown): x is Record<string, unknown> => !!x && typeof x === "object" && !Array.isArray(x);
const num = (x: unknown): number | null => {
  if (typeof x === "number") return Number.isFinite(x) ? x : null;
  if (typeof x === "string" && x.trim() !== "" && Number.isFinite(Number(x))) return Number(x);
  if (record(x) && (typeof x.amount === "string" || typeof x.amount === "number")) return num(x.amount);
  return null;
};
const str = (x: unknown): string | null => (typeof x === "string" && x ? x : null);

// ---- regular session --------------------------------------------------------------------------
// NYSE regular hours in ET. Weekends, full holidays and the two 13:00 early closes of 2026. The
// policy refuses any order outside this window, so a wrong entry here refuses, never trades.
export const NYSE_HOLIDAYS_2026 = ["2026-01-01", "2026-01-19", "2026-02-16", "2026-04-03", "2026-05-25", "2026-06-19", "2026-07-03", "2026-09-07", "2026-11-26", "2026-12-25"];
export const NYSE_EARLY_CLOSES_2026: Record<string, string> = { "2026-11-27": "13:00", "2026-12-24": "13:00" };
function etParts(ms: number): { date: string; weekday: number; offsetMin: number } {
  const f = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit", weekday: "short", timeZoneName: "shortOffset" });
  const p = Object.fromEntries(f.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  const m = /GMT([+-]\d+)(?::(\d+))?/.exec(p.timeZoneName ?? "");
  const offsetMin = m ? Number(m[1]) * 60 + (Number(m[1]) < 0 ? -1 : 1) * Number(m[2] ?? 0) : -300;
  const weekday = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(p.weekday ?? "");
  return { date: `${p.year}-${p.month}-${p.day}`, weekday, offsetMin };
}
export function regularSessionFor(nowMs: number): { opensAtMs: number; closesAtMs: number } | null {
  const { date, weekday, offsetMin } = etParts(nowMs);
  if (weekday === 0 || weekday === 6 || NYSE_HOLIDAYS_2026.includes(date)) return null;
  const at = (hhmm: string) => { const [h, m] = hhmm.split(":").map(Number); return Date.parse(`${date}T${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:00Z`) - offsetMin * 60_000; };
  return { opensAtMs: at("09:30"), closesAtMs: at(NYSE_EARLY_CLOSES_2026[date] ?? "16:00") };
}

// ---- broker rows → normalized ------------------------------------------------------------------
export function mapOrderState(state: unknown): OrderState | null {
  switch (state) {
    case "queued": case "confirmed": case "unconfirmed": case "pending_cancelled": return "open";
    case "partially_filled": return "partially_filled";
    case "filled": return "filled";
    case "cancelled": case "voided": return "cancelled";
    case "rejected": case "failed": return "rejected";
    default: return null;
  }
}
/** The broker names a leg's contract as an id, a URL ending in the id, or nested under `instrument`. */
export function optionIdOf(leg: Record<string, unknown>): string | null {
  const raw = leg.option_id ?? leg.option ?? leg.instrument_id ?? (record(leg.instrument) ? leg.instrument.id : undefined);
  const s = str(raw);
  if (!s) return null;
  const id = s.includes("/") ? s.replace(/\/+$/, "").split("/").pop() ?? "" : s;
  return /^[0-9a-f-]{36}$/i.test(id) ? id : null;
}
export interface BrokerOrder {
  id: string; state: OrderState; rawState: string; filledQuantity: number; quantity: number | null;
  price: number | null; direction: string | null; placedAgent: string | null; createdAtMs: number | null;
  /** Average fill per contract (`average_net_premium_paid`, else `average_price`), absolute; null when the row has neither. Ledger only. */
  averagePrice: number | null;
  legs: { optionId: string; side: string; positionEffect: string; ratio: number }[] | null;
}
export function decodeBrokerOrder(row: unknown): BrokerOrder | null {
  if (!record(row)) return null;
  const id = str(row.id), state = mapOrderState(row.state), filled = num(row.processed_quantity);
  if (!id || !state || filled == null || !Number.isSafeInteger(filled) || filled < 0) return null;
  let legs: BrokerOrder["legs"] = null;
  if (Array.isArray(row.legs)) {
    const decoded = row.legs.map((l) => record(l) ? { optionId: optionIdOf(l), side: str(l.side), positionEffect: str(l.position_effect), ratio: num(l.ratio_quantity) ?? 1 } : null);
    legs = decoded.every((l): l is { optionId: string; side: string; positionEffect: string; ratio: number } => !!l && !!l.optionId && !!l.side && !!l.positionEffect) ? decoded : null;
  }
  const created = Date.parse(str(row.created_at) ?? "");
  const avg = num(row.average_net_premium_paid) ?? num(row.average_price);
  return { id, state, rawState: String(row.state), filledQuantity: filled, quantity: num(row.quantity), price: num(row.price), direction: str(row.direction),
    placedAgent: str(row.placed_agent), createdAtMs: Number.isFinite(created) ? created : null, averagePrice: avg == null || !(Math.abs(avg) > 0) ? null : Math.abs(avg), legs };
}
/** Exact request identity on the broker's own row: same legs (id, side, effect, ratio), quantity, price and direction. */
export function orderMatchesCanonical(order: BrokerOrder, params: OptionOrderParams): boolean {
  if (!order.legs || order.legs.length !== params.legs.length) return false;
  if (order.quantity == null || order.quantity !== Number(params.quantity)) return false;
  if (order.price == null || Math.abs(order.price - Number(params.price)) > 0.005) return false;
  if (order.direction != null && order.direction !== params.direction) return false;
  const key = (l: { optionId: string; side: string; positionEffect: string; ratio: number }) => `${l.optionId}|${l.side}|${l.positionEffect}|${l.ratio}`;
  const want = params.legs.map((l) => key({ optionId: l.option_id, side: l.side, positionEffect: l.position_effect, ratio: l.ratio_quantity })).sort();
  return JSON.stringify(order.legs.map(key).sort()) === JSON.stringify(want);
}
export interface BrokerLeg { optionId: string; side: "long" | "short"; quantity: number }
/** Group the broker's per-contract positions into the structures we own; the rest stand alone as foreign. */
export function groupPositions(legs: BrokerLeg[], owned: OwnedOptionsPosition[]): LivePosition[] {
  const pool = legs.map((l) => ({ ...l }));
  const out: LivePosition[] = [];
  for (const o of owned) {
    const picked: number[] = [];
    for (const leg of o.legs) {
      const i = pool.findIndex((p, idx) => !picked.includes(idx) && p.optionId === leg.optionId && p.side === leg.side && p.quantity === leg.quantity);
      if (i < 0) { picked.length = 0; break; }
      picked.push(i);
    }
    if (picked.length === o.legs.length && o.legs.length > 0) {
      out.push({ id: o.id, legs: picked.map((i) => ({ optionId: pool[i].optionId, side: pool[i].side, quantity: pool[i].quantity })) });
      for (const i of [...picked].sort((a, b) => b - a)) pool.splice(i, 1);
    }
  }
  for (const p of pool) out.push({ id: `${p.optionId}:${p.side}`, legs: [{ optionId: p.optionId, side: p.side, quantity: p.quantity }] });
  return out;
}

// ---- review / placement decoders -----------------------------------------------------------------
function findNumber(payload: unknown, keys: string[], depth = 0): number | null {
  if (depth > 6 || !record(payload)) return null;
  for (const k of keys) if (k in payload) { const v = num(payload[k]); if (v != null) return v; }
  for (const v of Object.values(payload)) {
    if (record(v)) { const r = findNumber(v, keys, depth + 1); if (r != null) return r; }
    else if (Array.isArray(v)) for (const item of v) { const r = findNumber(item, keys, depth + 1); if (r != null) return r; }
  }
  return null;
}
function collectChecks(payload: unknown, depth = 0, out: Record<string, unknown>[] = []): Record<string, unknown>[] {
  if (depth > 6 || !record(payload)) return out;
  for (const [k, v] of Object.entries(payload)) {
    if (/alert|check|warning|error/i.test(k) && Array.isArray(v)) for (const item of v) if (record(item)) out.push(item);
    if (record(v)) collectChecks(v, depth + 1, out);
  }
  return out;
}
export const FEE_KEYS = ["estimated_total_fees", "total_fees", "estimated_fees", "fees", "fee", "regulatory_fees", "total_fee"];
export const BUYING_POWER_KEYS = ["buying_power_required", "estimated_buying_power_required", "required_buying_power", "collateral", "estimated_cost", "cost"];
export const MAX_LOSS_KEYS = ["max_loss", "maximum_loss", "max_potential_loss", "maximum_potential_loss"];
/** Decode a review. A missing fee makes it unapproved — the core then refuses to place. */
export function decodeReviewPayload(payload: Record<string, unknown>, ctx: { params: OptionOrderParams; theoreticalMaxLossUsd: number; nowMs: number }): OptionsOrderReview & { missing: string[]; blocking: string[] } {
  const missing: string[] = [];
  const checks = collectChecks(payload);
  const blocking = checks.filter((c) => c.blocking === true || c.can_place === false || ["blocking", "error", "reject", "rejected", "block"].includes(String(c.severity ?? c.level ?? c.type ?? "").toLowerCase()))
    .map((c) => String(c.message ?? c.detail ?? c.title ?? c.code ?? "blocking alert"));
  if (payload.can_place === false || payload.approved === false) blocking.push("broker review not approved");
  const fee = findNumber(payload, FEE_KEYS);
  if (fee == null) missing.push("fees");
  const bp = findNumber(payload, BUYING_POWER_KEYS);
  const quantity = Number(ctx.params.quantity), price = Number(ctx.params.price);
  const derivedBp = ctx.params.direction === "debit" ? price * 100 * quantity : ctx.theoreticalMaxLossUsd;
  const maxLoss = findNumber(payload, MAX_LOSS_KEYS);
  return {
    approved: blocking.length === 0 && missing.length === 0,
    accountNumber: OPTIONS_LIVE_ACCOUNT,
    requestFingerprint: optionsRequestFingerprint(ctx.params),
    asOfMs: ctx.nowMs,
    maxLossUsd: maxLoss ?? ctx.theoreticalMaxLossUsd,          // the broker's figure when given; else the policy's own arithmetic
    estimatedFeeUsd: fee ?? Number.NaN,                          // NaN fails the core's amount() check → refused
    buyingPowerRequiredUsd: bp ?? derivedBp,
    missing, blocking,
  };
}
export function decodeOrderPayload(payload: Record<string, unknown>, bind: { refId: string; fingerprint: string }): (BrokerOrder & { refId: string; accountNumber: string; requestFingerprint: string }) | null {
  const row = record(payload.order) ? payload.order : record(payload.data) ? (record(payload.data.order) ? payload.data.order : payload.data) : payload;
  const order = decodeBrokerOrder(row);
  if (!order) return null;
  const account = str(record(row) ? row.account_number : null) ?? OPTIONS_LIVE_ACCOUNT;
  return { ...order, refId: bind.refId, accountNumber: account, requestFingerprint: bind.fingerprint };
}

// ---- underlying quote / earnings decoders (Sep 15 2026) ------------------------------------------
/** get_equity_quotes → data.results[].quote {symbol, last_trade_price, adjusted_previous_close, previous_close, venue_last_trade_time} (shape on file from Sep 10). */
export interface UnderlyingQuote { symbol: string; last: number; previousClose: number; atMs: number }
export function decodeUnderlyingQuote(payload: Record<string, unknown>, symbol: string): UnderlyingQuote | null {
  const data = record(payload.data) ? payload.data : payload;
  if (!Array.isArray(data.results)) return null;
  const row = data.results.find((r) => record(r) && record(r.quote) && r.quote.symbol === symbol);
  if (!record(row) || !record(row.quote)) return null;
  const q = row.quote, last = num(q.last_trade_price), prev = num(q.adjusted_previous_close) ?? num(q.previous_close), at = Date.parse(str(q.venue_last_trade_time) ?? "");
  if (last == null || !(last > 0) || prev == null || !(prev > 0) || !Number.isFinite(at)) return null;
  return { symbol, last, previousClose: prev, atMs: at };
}
/** get_earnings_results {symbol} → data.results[] of {symbol, year, quarter, eps:{estimate, actual}, report:{date, timing, verified}},
 *  up to 8 quarters ascending (captured live Sep 15 2026). An unresolvable symbol comes back with results:[] and the symbol in
 *  `not_found`. Next earnings = the earliest report.date on or after today; a tentative (verified:false) date still counts.
 *  Empty, not found, no upcoming date, or any other shape THROWS — the runner turns a throw into a refusal (fail closed). */
export interface EarningsLookup { symbol: string; earningsAt: string; timing: "am" | "pm" | null; verified: boolean; via: string }
const dayOf = (x: unknown): string | null => { const d = (str(x) ?? "").slice(0, 10); return /^\d{4}-\d{2}-\d{2}$/.test(d) && Number.isFinite(Date.parse(d)) ? d : null; };
const timingOf = (x: unknown): "am" | "pm" | null => (x === "am" || x === "pm" ? x : null);
export function decodeEarningsResults(payload: Record<string, unknown>, symbol: string, fromDay: string): EarningsLookup {
  const via = "get_earnings_results";
  const data = record(payload.data) ? payload.data : payload;
  if (Array.isArray(data.not_found) && data.not_found.includes(symbol)) throw new Error(`${via}: ${symbol} not found at the broker`);
  if (!Array.isArray(data.results)) throw new Error(`${via}: unrecognized response shape (${Object.keys(data).slice(0, 12).join(",") || "empty"})`);
  if (!data.results.length) throw new Error(`${via}: no earnings rows for ${symbol}`);
  const upcoming: { day: string; timing: "am" | "pm" | null; verified: boolean }[] = [];
  for (const row of data.results) {
    if (!record(row) || !record(row.report)) throw new Error(`${via}: a row without a report object`);
    if (str(row.symbol) !== symbol) throw new Error(`${via}: row for ${str(row.symbol) ?? "?"} answering a ${symbol} request`);
    const day = dayOf(row.report.date);
    if (!day) throw new Error(`${via}: a ${symbol} row carries no readable report.date (${Object.keys(row.report).join(",")})`);
    if (day < fromDay && (!record(row.eps) || row.eps.actual == null)) throw new Error(`${symbol}: an unreported quarter dated ${day} is overdue`);   // the date moved and the broker has not caught up
    if (day >= fromDay) upcoming.push({ day, timing: timingOf(row.report.timing), verified: row.report.verified === true });
  }
  const next = upcoming.sort((a, b) => a.day.localeCompare(b.day))[0];
  if (!next) throw new Error(`${via}: no upcoming report date for ${symbol} — the next quarter is unscheduled`);
  return { symbol, earningsAt: next.day, timing: next.timing, verified: next.verified, via };
}

// ---- the adapter --------------------------------------------------------------------------------
export interface LiveBrokerClient { call(name: string, args: Record<string, unknown>): Promise<unknown> }
export interface LiveBrokerIO {
  verified: boolean;
  now(): number;
  lookupIntent(refId: string): Promise<OptionsIntentRecord | null>;
  ownedPositions(): Promise<OwnedOptionsPosition[]>;
  log(line: string): void;
}
async function pages(client: LiveBrokerClient, name: string, key: string, args: Record<string, unknown>): Promise<Record<string, unknown>[]> {
  const rows: Record<string, unknown>[] = [], seen = new Set<string>();
  let cursor: string | undefined;
  for (let page = 0; page < 25; page++) {
    const response = unwrapRobinhoodRead(await client.call(name, { ...args, ...(cursor ? { cursor } : {}) }));
    const data = record(response.data) ? response.data : response;
    const list = data[key];
    if (!Array.isArray(list) || !list.every(record)) throw new Error(`Invalid ${key} page`);
    rows.push(...(list as Record<string, unknown>[]));
    const next = data.next ?? response.next;
    if (next == null) return rows;
    const c = typeof next === "string" ? new URL(next).searchParams.get("cursor") : null;
    if (!c || seen.has(c)) throw new Error("Missing or repeated pagination cursor");
    seen.add(c); cursor = c;
  }
  throw new Error("Pagination did not finish");
}
export class RobinhoodLiveBroker implements OptionsLiveBroker {
  readonly responseSchemasVerified: boolean;
  private lastReview: { params: OptionOrderParams | null; theoreticalMaxLossUsd: number } = { params: null, theoreticalMaxLossUsd: Number.NaN };
  private lastPlacement: { refId: string; fingerprint: string } | null = null;
  private contractMeta = new Map<string, { underlying: string; kind: "call" | "put" }>();
  constructor(private readonly client: LiveBrokerClient, private readonly io: LiveBrokerIO) { this.responseSchemasVerified = io.verified; }

  /** The caller states the structure's theoretical max loss (the policy's own arithmetic) before the review pass. */
  noteTheoreticalMaxLoss(usd: number): void { this.lastReview.theoreticalMaxLossUsd = usd; }

  async callTool(name: "review_option_order" | "place_option_order", params: Record<string, unknown>): Promise<unknown> {
    if (name === "review_option_order") {
      const p = params as unknown as OptionOrderParams;
      this.lastReview = { params: p, theoreticalMaxLossUsd: this.lastReview.theoreticalMaxLossUsd };
      // Review-only extras so the broker includes fees and collateral; never sent to placement.
      const meta = this.contractMeta.get(p.legs[0]?.option_id ?? "");
      const extras = meta ? { chain_symbol: meta.underlying, underlying_type: "equity" } : {};
      this.io.log(`review ${p.direction} ${p.quantity}x ${p.legs.map((l) => `${l.side}:${l.option_id.slice(0, 8)}`).join("+")} @ ${p.price}`);
      return this.client.call(name, { ...params, ...extras });
    }
    const { ref_id, ...rest } = params;
    const refId = str(ref_id);
    if (!refId) throw new Error("placement without ref_id refused");
    this.lastPlacement = { refId, fingerprint: optionsRequestFingerprint(rest as unknown as OptionOrderParams) };
    this.io.log(`PLACE ${refId} ${JSON.stringify(rest)}`);
    return this.client.call(name, params);
  }
  decodeReview(raw: unknown): unknown {
    if (!this.lastReview.params) throw new Error("review decoded before a review was sent");
    const payload = unwrapRobinhoodRead(raw);
    const review = decodeReviewPayload(payload, { params: this.lastReview.params, theoreticalMaxLossUsd: this.lastReview.theoreticalMaxLossUsd, nowMs: this.io.now() });
    this.io.log(`review decoded: approved=${review.approved} fee=${review.estimatedFeeUsd} bp=${review.buyingPowerRequiredUsd} maxLoss=${review.maxLossUsd}${review.missing.length ? ` MISSING ${review.missing.join(",")}` : ""}${review.blocking.length ? ` BLOCKING ${review.blocking.join("; ")}` : ""}`);
    return review;
  }
  decodeOrder(raw: unknown): unknown {
    if (!this.lastPlacement) throw new Error("order decoded before a placement was sent");
    const order = decodeOrderPayload(unwrapRobinhoodRead(raw), this.lastPlacement);
    this.io.log(`placement decoded: ${order ? `${order.id} ${order.rawState} filled=${order.filledQuantity}` : "UNRECOGNIZED"}`);
    return order;
  }
  async cancel(orderId: string): Promise<void> {
    this.io.log(`CANCEL ${orderId}`);
    await this.client.call("cancel_option_order", { account_number: OPTIONS_LIVE_ACCOUNT, order_id: orderId });
  }
  /** PROOF THAT AN ENTRY NEVER BECAME AN ORDER (Sep 23 2026). Read from the broker's RAW order list, not the decoded one, so a
   *  row this adapter cannot parse still counts against the proof. Proven only when, from two minutes before the reservation
   *  onward, every order Robinhood lists was placed by hand ("user") on other contracts — no agentic, unlabelled or unreadable
   *  row, nothing on the reservation's contracts — and no open position sits on those contracts. Anything else is not proof. */
  async proveNeverPlaced(rec: OptionsIntentRecord): Promise<NeverPlacedProof> {
    const since = (rec.createdAtMs ?? Number.NaN) - 120_000;
    const legIds = new Set((rec.canonicalOrder?.legs ?? []).map((l) => l.option_id));
    if (!Number.isFinite(since) || !legIds.size) return { proven: false, why: "the reservation has no time or no legs" };
    const rows = await pages(this.client, "get_option_orders", "orders", { account_number: OPTIONS_LIVE_ACCOUNT });
    let inWindow = 0;
    for (const r of rows) {
      const created = Date.parse(str(r.created_at) ?? "");
      if (!Number.isFinite(created)) return { proven: false, why: "an order row has no readable time" };
      if (created < since) continue;
      inWindow++;
      if (r.placed_agent !== "user") return { proven: false, why: `an order placed by "${str(r.placed_agent) ?? "unlabelled"}" exists since the reservation (${str(r.state) ?? "?"})` };
      const legs = Array.isArray(r.legs) ? r.legs : null;
      if (!legs || legs.some((l) => !record(l) || !optionIdOf(l))) return { proven: false, why: "an order row since the reservation has unreadable legs" };
      if (legs.some((l) => legIds.has(optionIdOf(l as Record<string, unknown>)!))) return { proven: false, why: "a hand-placed order since the reservation touches its contracts" };
    }
    const positions = await pages(this.client, "get_option_positions", "positions", { account_number: OPTIONS_LIVE_ACCOUNT, nonzero: true });
    for (const p of positions) {
      const id = str(p.option_id);
      if (!id) return { proven: false, why: "a position row has no contract id" };
      if (legIds.has(id)) return { proven: false, why: "a position is open on the reservation's contracts" };
    }
    return { proven: true, evidence: `Robinhood lists no desk order since ${new Date(since).toISOString().slice(11, 16)}Z (${rows.length} orders read, ${inWindow} since then, all by hand on other contracts) and no position on its contracts` };
  }
  /** Every broker order (decoded), for the guardian's stale-order sweep and fill ingest. */
  async orders(): Promise<BrokerOrder[]> {
    return (await pages(this.client, "get_option_orders", "orders", { account_number: OPTIONS_LIVE_ACCOUNT })).map(decodeBrokerOrder).filter((o): o is BrokerOrder => !!o);
  }
  async contracts(optionIds: string[]): Promise<LiveContract[]> {
    const ids = [...new Set(optionIds)];
    const out: LiveContract[] = [];
    for (let i = 0; i < ids.length; i += 20) {
      const batch = ids.slice(i, i + 20);
      const instruments = await pages(this.client, "get_option_instruments", "instruments", { ids: batch.join(","), state: "active" });
      const quotesAt = this.io.now();
      const quoted = unwrapRobinhoodRead(await this.client.call("get_option_quotes", { instrument_ids: batch }));
      const results = record(quoted.data) && Array.isArray(quoted.data.results) ? quoted.data.results : Array.isArray(quoted.results) ? quoted.results : [];
      const quotes = new Map<string, Record<string, unknown>>();
      for (const item of results) if (record(item) && record(item.quote) && str(item.quote.instrument_id)) quotes.set(str(item.quote.instrument_id)!, item.quote);
      for (const ins of instruments) {
        const id = str(ins.id); const q = id ? quotes.get(id) : undefined;
        const kind = ins.type === "call" || ins.type === "put" ? ins.type : null;
        const underlying = str(ins.chain_symbol), strike = num(ins.strike_price), expiry = str(ins.expiration_date), mult = num(ins.trade_value_multiplier);
        if (!id || !q || !kind || !underlying || strike == null || !expiry || mult == null || ins.tradability !== "tradable") continue;   // missing → policy refuses ("metadata missing")
        const bid = num(q.bid_price), ask = num(q.ask_price);
        if (bid == null || ask == null) continue;
        this.contractMeta.set(id, { underlying, kind });
        out.push({ optionId: id, underlying, kind, strike, expiry, multiplier: mult, bid, ask, quoteAtMs: quotesAt });
      }
    }
    return out;
  }
  /** Underlying last/previous close for the shock check and the ex-dividend rule. Fail-soft: null (logged) — callers skip the rule, never trade blind on a guess. */
  async underlyingQuote(symbol: string): Promise<UnderlyingQuote | null> {
    try {
      const q = decodeUnderlyingQuote(unwrapRobinhoodRead(await this.client.call("get_equity_quotes", { symbols: [symbol] })), symbol);
      if (!q) this.io.log(`quote ${symbol}: unreadable response — rule skipped`);
      return q;
    } catch (e) { this.io.log(`quote ${symbol}: failed — ${String(e).slice(0, 160)}`); return null; }
  }
  /** Next earnings date for one name, straight from the broker (`get_earnings_results {symbol}`). THROWS on any failure; the entry path refuses on a throw. */
  async nextEarnings(symbol: string): Promise<EarningsLookup> {
    const fromDay = new Date(this.io.now()).toISOString().slice(0, 10);
    const raw = unwrapRobinhoodRead(await this.client.call("get_earnings_results", { symbol }));
    const shape = (x: unknown, d = 0): string[] => (record(x) && d < 3 ? Object.entries(x).flatMap(([k, v]) => [k, ...shape(Array.isArray(v) ? v[0] : v, d + 1).map((s) => `${k}.${s}`)]) : []);
    try { return decodeEarningsResults(raw, symbol, fromDay); }
    catch (e) { this.io.log(`earnings ${symbol} via get_earnings_results shape: ${shape(raw).slice(0, 40).join(" ")}`); throw e; }
  }
  async snapshot(optionIds: string[], refId: string): Promise<OptionsBrokerSnapshot> {
    const accounts = unwrapRobinhoodRead(await this.client.call("get_accounts", {}));
    const list = record(accounts.data) && Array.isArray(accounts.data.accounts) ? accounts.data.accounts : [];
    const a = list.filter((x) => record(x) && x.account_number === OPTIONS_LIVE_ACCOUNT);
    const acct = a.length === 1 && record(a[0]) ? a[0] : null;
    const portfolio = unwrapRobinhoodRead(await this.client.call("get_portfolio", { account_number: OPTIONS_LIVE_ACCOUNT }));
    const p = record(portfolio.data) ? portfolio.data : portfolio;
    const bp = record(p.buying_power) ? num(p.buying_power.buying_power) : num(p.buying_power);
    const rawLegs = await pages(this.client, "get_option_positions", "positions", { account_number: OPTIONS_LIVE_ACCOUNT, nonzero: true });
    const legs: BrokerLeg[] = [];
    for (const r of rawLegs) {
      const optionId = str(r.option_id), side = r.type === "long" || r.type === "short" ? r.type : null, quantity = num(r.quantity);
      if (!optionId || !side || quantity == null) throw new Error("unreadable broker position");
      legs.push({ optionId, side, quantity });
    }
    const owned = await this.io.ownedPositions();
    const positions = groupPositions(legs, owned);
    const brokerOrders = await this.orders();
    const intent = await this.io.lookupIntent(refId);
    const bound = new Set<string>();
    if (intent?.order?.id) { if (brokerOrders.some((o) => o.id === intent.order!.id)) bound.add(intent.order.id); }
    else if (intent?.canonicalOrder) {
      const since = (intent.createdAtMs ?? 0) - 120_000;
      for (const o of brokerOrders) if (o.placedAgent === "agentic" && (o.createdAtMs ?? 0) >= since && orderMatchesCanonical(o, intent.canonicalOrder)) bound.add(o.id);
    }
    const orders = brokerOrders
      .filter((o) => bound.has(o.id) || !["filled", "cancelled", "rejected"].includes(o.state))
      .map((o) => ({ id: o.id, accountNumber: OPTIONS_LIVE_ACCOUNT, refId: bound.has(o.id) ? refId : "", requestFingerprint: bound.has(o.id) ? intent!.fingerprint : "", state: o.state, filledQuantity: o.filledQuantity, averagePrice: o.averagePrice }));
    const wanted = [...new Set([...optionIds, ...legs.map((l) => l.optionId), ...(intent?.intent?.legs.map((l) => l.optionId) ?? [])])];
    const contracts = wanted.length ? await this.contracts(wanted) : [];
    const now = this.io.now();
    return {
      accountNumber: str(acct?.account_number) ?? "",
      active: acct?.state === "active" && acct?.deactivated === false && acct?.permanently_deactivated === false,
      agenticAllowed: acct?.agentic_allowed === true,
      optionLevel: (str(acct?.option_level) ?? "unknown") as "option_level_3",
      marginType: (str(acct?.type) ?? "unknown") as "limited_margin",
      asOfMs: now, complete: true, buyingPowerUsd: bp ?? Number.NaN,
      regularSession: regularSessionFor(now),
      positions, orders, contracts,
    };
  }
}
