// THE OPTIONS LIVE DESK RUNNER (Sep 13 2026) — the only process that may place a Robinhood order.
//
//   node --env-file=.env.local --import tsx scripts/robinhood/live-desk.ts guard   # every 5 min in RTH
//   node --env-file=.env.local --import tsx scripts/robinhood/live-desk.ts entry   # :05/:35 in RTH — guard, then one entry attempt
//   node --env-file=.env.local --import tsx scripts/robinhood/live-desk.ts probe   # review-only: proves the decoders on real responses
//
// Runs on this Mac (the OAuth credential lives here; Vercel never holds it). Every order goes
// through the validated core in src/lib/options-live-executor.ts: review → durable reservation →
// place → reconcile, under the account lock, inside the cap the size ladder sets for the tick
// (src/lib/options-risk-ladder.ts: grade × equity × drawdown tier, under the armed ceiling). This file
// decides WHEN and WHAT; the core decides WHETHER. Nothing here calls the broker's order tools directly.
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { RobinhoodTradeClient, withCredentialLock } from "./client";
import { prisma } from "../../src/lib/db";
import { sendNotification } from "../../src/lib/notifications";
import { OPTIONS_LIVE_ACCOUNT, prepareOptionsOrder, type OptionsLiveIntent, type OptionsLivePolicy } from "../../src/lib/options-live-policy";
import { executeOptionsIntent, reconcileOptionsIntent, type OptionsExecutorDependencies } from "../../src/lib/options-live-executor";
import { PostgresOptionsLiveStore } from "../../src/lib/options-live-store";
import { readOptionsExecutionPolicy } from "../../src/lib/options-live-runtime";
import { RobinhoodLiveBroker, regularSessionFor } from "../../src/lib/options-live-broker";
import { OPTIONS_LIVE_RULES, closeBlockedBy, drawdownHalt, dteOf, entryOrderAction, etDay, exitDecision, invalidationLevel, openNetAsk, ownedRecordAfter, ownershipVerdict, type OwnedPositionRecord } from "../../src/lib/options-live-guardian";
import { OPTIONS_RESEARCH_KEY, OPTIONS_DESK_RULES, contractQualityFailures, isOptionsResearch, noCandidateNote, screenResearchContracts, type OptionsResearch } from "../../src/lib/options-desk-model";
import { OPTIONS_EVENT_RULES, guardianExDivExit, spansEarnings } from "../../src/lib/options-events";
import { chaseCheck, directionOfKind, intradayShock, marketState, marketVeto, vixLevel, type MarketStamp } from "../../src/lib/options-market-state";
import { OPTIONS_MAX_LOSS_KEY, parseOptionsMaxLoss } from "../../src/lib/options-operation";
import { OPTIONS_LADDER_RULES, clusterOf, clusterRisk, ddTier, gradeFor, maxLossFor, reserveRefusal, slotsFor, type DrawdownTier, type OptionsGrade } from "../../src/lib/options-risk-ladder";
import { divergenceVerdict, roundTrips } from "../../src/lib/options-live-ledger";
import { legSpreadPct, type ResearchCandidate } from "../../src/lib/options-desk-model";
import type { StructureKind } from "../../src/lib/options-structures";
import { persistEntryDecision, safeEntryTickCards, type LivePricing, type RefusedCandidate } from "./live-desk-cards";

export type LiveDeskMode = "guard" | "entry" | "probe";
let MODE: LiveDeskMode = "guard";
const ACCOUNT = OPTIONS_LIVE_ACCOUNT;
const STATE_KEY = "options_live_state";
const GUARDIAN_KEY = "options_live_guardian_ok_at";
const HIGH_KEY = "options_live_equity_high";
const PROBE_KEY = "options_live_probe";
const VERIFIED_KEY = "options_live_integration_verified";
const ARMED_KEY = "options_live_armed";
const LOG_KEY = "options_live_log";
const MARKET_VETO_KEY = "options_live_market_veto";   // "false" switches the pre-registered SPY veto off; anything else = on
const PROMOTED_KEY = "options_score_promoted";         // "true" only once the 0–100 score has proven it ranks (D7); unlocks the A+ rung
const SLOTS_KEY = "options_live_slots";                // how many names the desk may hold at once (default 3, hard-capped by the ladder at 4)
const DD_TIER_KEY = "options_live_dd_tier";            // state only: the drawdown tier the last guard tick computed

let lines: string[] = [];
const log = (s: string) => { const line = `${new Date().toISOString()} ${s}`; lines.push(line); console.log(line); };
async function cfg(key: string): Promise<string | null> { return (await prisma.agentConfig.findUnique({ where: { key } }))?.value ?? null; }
async function setCfg(key: string, value: string): Promise<void> { await prisma.agentConfig.upsert({ where: { key }, update: { value }, create: { key, value } }); }
async function page(text: string): Promise<void> { log(`PAGE ${text}`); await sendNotification(text, "options").catch(() => {}); }
async function appendLog(): Promise<void> {
  const prior: string[] = JSON.parse((await cfg(LOG_KEY)) ?? "[]");
  await setCfg(LOG_KEY, JSON.stringify([...prior, ...lines].slice(-200)));
}

// Regular session, with a 5-minute grace after the close so the guardian's last tick still runs.
function sessionNow(now: number): { open: boolean; session: { opensAtMs: number; closesAtMs: number } | null } {
  const session = regularSessionFor(now);
  return { open: !!session && now >= session.opensAtMs && now < session.closesAtMs + 5 * 60_000, session };
}

/** One desk tick. Safe to call repeatedly from a long-lived worker; every run starts with fresh state. */
export async function runLiveDesk(mode: LiveDeskMode): Promise<void> {
  MODE = mode; lines = [];
  const now0 = Date.now();
  const { open, session } = sessionNow(now0);
  if (!open) { console.log(`${new Date(now0).toISOString()} outside the regular session — nothing to do`); return; }
  const pool = new Pool({ connectionString: process.env.DATABASE_URL_UNPOOLED || process.env.DATABASE_URL, ssl: { rejectUnauthorized: false }, max: 2 });
  const store = new PostgresOptionsLiveStore(pool);
  await store.initialize();
  try {
    await withCredentialLock(async () => {
      const client = new RobinhoodTradeClient();
      await client.connect();
      const verified = (await cfg(VERIFIED_KEY)) === "true";
      const broker = new RobinhoodLiveBroker(client, {
        verified, now: () => Date.now(), log,
        lookupIntent: (refId) => (refId ? store.getIntent(refId) : Promise.resolve(null)),   // the guardian's standalone snapshot has no intent
        ownedPositions: () => store.ownedPositions(),
      });
      const deps: OptionsExecutorDependencies = { broker, store, policy: readOptionsExecutionPolicy, now: () => Date.now() };
      const state: Record<string, unknown> = { at: new Date().toISOString(), mode: MODE, verified };
      let clean = true;
      const fail = (what: string, e: unknown) => { clean = false; log(`ERROR ${what}: ${String(e).slice(0, 300)}`); state.lastError = `${what}: ${String(e).slice(0, 200)}`; };

      // ---------- GUARD (every mode) ----------
      // 1) Reconcile every unsettled intent against the broker: fills become ownership, no-fills settle.
      const unsettled = await store.withAccountLock(ACCOUNT, () => store.unsettledIntents(ACCOUNT));
      for (const r of unsettled) {
        if (!verified) { log(`unsettled intent ${r.refId} (${r.state}) — cannot reconcile until the adapter is verified`); clean = false; continue; }
        const res = await reconcileOptionsIntent(r.refId, deps);
        log(`reconcile ${r.refId} ${r.action}: ${res.status}${res.reason ? ` — ${res.reason}` : ""}${res.orderId ? ` order ${res.orderId}` : ""}`);
        if (res.status === "unknown") { clean = false; await page(`🚨 Options intent ${r.refId} is UNKNOWN at the broker (${res.reason}). No new entries until it is resolved by hand.`); continue; }
        const rec = await store.withAccountLock(ACCOUNT, () => store.getIntent(r.refId));
        if (!rec || rec.state !== "accepted" || !rec.order) continue;
        // A filled order, or a cancelled/rejected one that filled part of a 2-lot before the stale sweep, owns exactly what filled.
        const filledQty = rec.order.state === "filled" ? rec.intent?.quantity ?? rec.order.filledQuantity
          : ["cancelled", "rejected"].includes(rec.order.state) ? Math.min(rec.intent?.quantity ?? 0, Math.max(rec.order.filledQuantity, rec.maxFilledQuantity ?? 0)) : 0;
        if (filledQty > 0 && rec.intent && rec.canonicalOrder) {
          await store.withAccountLock(ACCOUNT, async () => {
            if (rec.action === "open") {
              const legs = rec.intent!.legs.map((l) => ({ optionId: l.optionId, side: l.side === "buy" ? "long" as const : "short" as const, quantity: filledQty }));
              const contracts = await broker.contracts(legs.map((l) => l.optionId));
              const strikes = contracts.map((c) => c.strike);
              const width = strikes.length === 2 ? Math.abs(strikes[0] - strikes[1]) : 0;
              const shortLeg = legs.find((l) => l.side === "short");
              const shortStrike = shortLeg ? contracts.find((c) => c.optionId === shortLeg.optionId)?.strike ?? null : null;
              const event = (await research())?.events?.[contracts[0]?.underlying ?? ""];
              // The thesis the runner stashed on the record after acceptance: the range edge the signal cleared becomes the invalidation level.
              const cand = rec.candidate as Partial<CandidateStash> | undefined;
              const signalDirection = cand?.direction === "bullish" || cand?.direction === "bearish" ? cand.direction : undefined;
              const invalidationPx = signalDirection && typeof cand?.rangeLow === "number" && typeof cand?.rangeHigh === "number" ? invalidationLevel(signalDirection, cand.rangeLow, cand.rangeHigh) : null;
              const owned: OwnedPositionRecord = { id: rec.refId, accountNumber: ACCOUNT, openingRefId: rec.refId, legs, kind: rec.intent!.kind, direction: rec.canonicalOrder!.direction,
                entryPrice: Number(rec.canonicalOrder!.price), width, openedAtMs: rec.createdAtMs ?? Date.now(), expiry: contracts[0]?.expiry ?? "", underlying: contracts[0]?.underlying ?? "",
                exDivAt: event?.exDivAt ?? null, ...(event?.exDivSource ? { exDivSource: event.exDivSource } : {}), shortStrike,
                invalidationPx, ...(signalDirection ? { signalDirection } : {}), invalidationTicks: 0 };
              await store.putOwnedPosition(owned);
              await store.putIntent({ ...rec, state: "settled" });
              await page(`✅ Options FILLED: ${owned.kind} ${owned.underlying} ${owned.expiry} × ${filledQty}${filledQty < rec.intent!.quantity ? ` of ${rec.intent!.quantity} (rest ${rec.order!.state})` : ""} at ${owned.entryPrice.toFixed(2)} (order ${rec.order!.id}). The guardian now manages it: stop at half the premium, a trail once it has been worth 1.5× (keeps half the best gain), ${invalidationPx != null ? `out if ${owned.underlying} trades back ${signalDirection === "bullish" ? "below" : "above"} ${invalidationPx} (failed breakout) on two ticks, ` : ""}${filledQty >= 2 ? "one contract banked at 2×, " : ""}out 7 days before expiry.`);
            } else if (rec.action === "close" && rec.positionId) {
              // A close that filled fewer contracts than the position holds leaves a remainder the guardian keeps managing.
              const pos = await store.ownedPosition(rec.positionId) as OwnedPositionRecord | null;
              const held = pos?.legs[0]?.quantity ?? filledQty, rest = held - filledQty;
              if (pos && rest > 0) await store.putOwnedPosition({ ...pos, legs: pos.legs.map((l) => ({ ...l, quantity: l.quantity - filledQty })) });
              else await store.releaseOwnedPosition(rec.positionId);
              await store.putIntent({ ...rec, state: "settled" });
              await page(`✅ Options CLOSED: ${filledQty} of ${held} on position ${rec.positionId} at ${rec.canonicalOrder!.price} (order ${rec.order!.id})${rest > 0 ? ` — ${rest} left under the guardian` : ""}.`);
            }
          });
        } else {
          const act = entryOrderAction(rec, Date.now());
          if (act.cancel) {
            try { await broker.cancel(rec.order.id); log(`${rec.action} ${rec.refId} cancelled: ${act.reason}; next tick settles or ingests its fills`); }
            catch (e) { fail("cancel order", e); }
          }
        }
      }
      // What is still pending after the reconcile pass: a close later in this tick must clear any live entry order first.
      let pending = await store.withAccountLock(ACCOUNT, () => store.unsettledIntents(ACCOUNT));

      // 2) Broker snapshot: account, positions, orders, quotes for our legs.
      // The adapter reads intents and owned positions from the store while building a snapshot, and
      // the store refuses any read outside the account lock — so the snapshot is taken under it.
      // (The core takes its own lock around its snapshots; this is the guardian's standalone read.)
      let snapshot: Awaited<ReturnType<typeof broker.snapshot>> | null = null;
      try { snapshot = await store.withAccountLock(ACCOUNT, () => broker.snapshot([], "")); } catch (e) { fail("broker snapshot", e); }
      const totalValue = await accountValue();
      let tier: DrawdownTier | null = null;
      const owned = await store.withAccountLock(ACCOUNT, () => store.ownedPositions()) as OwnedPositionRecord[];
      state.owned = owned.map((o) => ({ id: o.id, kind: o.kind, underlying: o.underlying, expiry: o.expiry, entryPrice: o.entryPrice }));
      if (snapshot) {
        state.buyingPower = snapshot.buyingPowerUsd; state.brokerPositions = snapshot.positions.length; state.openOrders = snapshot.orders.filter((o) => !["filled", "cancelled", "rejected"].includes(o.state)).length;
        // 3) Manage what we own; release what the broker no longer shows.
        for (const pos of owned) {
          const live = snapshot.positions.find((p) => p.id === pos.id);
          const verdict = ownershipVerdict(pos, snapshot.positions.flatMap((p) => p.legs), !!live);
          // A close in flight explains any difference (its fill is ingested next tick) — neither released nor paged.
          if (verdict.action !== "manage" && pending.some((r) => r.action === "close" && r.positionId === pos.id)) { log(`${pos.underlying} ${pos.kind}: legs do not match the record while a close is in flight — waiting for it to settle`); continue; }
          if (verdict.action === "release") {
            await store.withAccountLock(ACCOUNT, () => store.releaseOwnedPosition(pos.id));
            await page(`⚠️ Options position ${pos.id} (${pos.kind} ${pos.underlying}) is no longer at the broker — expired, assigned or closed by hand. Released from the guardian.`);
            continue;
          }
          if (verdict.action === "keep") {
            // Legs are there at another quantity: paged ONCE and left for a human. Never released.
            log(`${pos.underlying} ${pos.kind}: leg quantities at the broker differ from the record — kept, not managed, not released`);
            if (verdict.page) { await page(verdict.page); await store.withAccountLock(ACCOUNT, () => store.putOwnedPosition({ ...pos, mismatchPagedAtMs: Date.now() })); }
            continue;
          }
          // The underlying's live quote feeds the thesis-invalidation rule and the ex-dividend rule. Fail-soft: no quote, both skipped and said so.
          const needsSpot = pos.invalidationPx != null || (pos.kind === "call_debit" && !!pos.exDivAt);
          const q = needsSpot ? await broker.underlyingQuote(pos.underlying) : null;
          const decision = exitDecision(pos, snapshot.contracts, Date.now(), OPTIONS_LIVE_RULES, q);
          log(`${pos.underlying} ${pos.kind}: ${decision.reason}`);
          // The trail's anchor and the invalidation tick count live on the owned record, so a restart cannot forget either.
          const next = ownedRecordAfter(pos, decision);
          if (next) await store.withAccountLock(ACCOUNT, () => store.putOwnedPosition(next));
          // Ex-dividend assignment rule: a call debit spread with its short call in the money and the ex-date ≤ 2 days out closes at
          // its executable mark.
          if (!decision.exit && pos.kind === "call_debit" && pos.exDivAt) {
            const ex = guardianExDivExit(pos, q, Date.now());
            log(`${pos.underlying} ${pos.kind}: ${ex.reason}`);
            if (ex.exit && decision.markNet != null && decision.markNet > 0) { decision.exit = true; decision.reason = ex.reason; decision.limitPrice = Math.min(decision.markNet, pos.width > 0 ? pos.width : decision.markNet); }
            else if (ex.exit) log(`${pos.underlying} ${pos.kind}: ex-dividend exit wanted but no bid — will retry next tick`);
          }
          if (!decision.exit || decision.limitPrice == null) continue;
          // A partial closes fewer contracts than are held (the policy allows ≤ owned); the fill ingest above reduces the record by what filled.
          const quantity = Math.min(decision.quantity ?? pos.legs[0].quantity, pos.legs[0].quantity);
          const closeIntent: OptionsLiveIntent = { refId: randomUUID(), action: "close", kind: pos.kind, positionId: pos.id, quantity, limitPrice: decision.limitPrice,
            legs: pos.legs.map((l) => ({ optionId: l.optionId, side: l.side === "long" ? "sell" as const : "buy" as const })) };
          // With two slots an entry order may be live while a close is wanted; the policy refuses any order beside an outstanding one, so
          // cancel the entry first. If the cancel confirms on an immediate reconcile the close goes now, otherwise next tick.
          const blocker = closeBlockedBy(pending);
          if (blocker) {
            try { await broker.cancel(blocker.id); log(`close ${pos.id}: cancelled live entry order ${blocker.id} (${blocker.state}) to make way`); } catch (e) { fail("cancel entry for close", e); continue; }
            const open = pending.find((r) => r.order?.id === blocker.id)!;
            const rc = await reconcileOptionsIntent(open.refId, deps);
            log(`close ${pos.id}: entry ${open.refId} after cancel → ${rc.status}${rc.reason ? ` — ${rc.reason}` : ""}`);
            pending = await store.withAccountLock(ACCOUNT, () => store.unsettledIntents(ACCOUNT));
            const after = pending.find((r) => r.refId === open.refId) ?? null;   // settled = no longer pending = cancelled with no fills
            if (rc.status === "unknown" || (after && (!after.order || ["pending", "open", "partially_filled"].includes(after.order.state)))) { log(`close ${pos.id}: entry order not yet confirmed cancelled — close goes next tick`); clean = clean && rc.status !== "unknown"; continue; }
          }
          broker.noteTheoreticalMaxLoss(0);
          const res = await executeOptionsIntent(closeIntent, deps);
          log(`close ${pos.id} × ${quantity}: ${res.status}${res.reason ? ` — ${res.reason}` : ""}`);
          if (res.status === "accepted") await page(`📤 Options CLOSE sent for ${pos.underlying} ${pos.kind} × ${quantity}${quantity < pos.legs[0].quantity ? ` of ${pos.legs[0].quantity}` : ""} at ${decision.limitPrice.toFixed(2)} (${decision.reason}).`);
          else if (res.status !== "refused") { clean = false; await page(`🚨 Options close for ${pos.id} ended ${res.status}: ${res.reason}`); }
        }
        // 4) Drawdown tier on account value: sizing scales down through the tiers; tier 4 disarms entries.
        if (totalValue != null) {
          const high = Number((await cfg(HIGH_KEY)) ?? totalValue) || totalValue;
          tier = ddTier(totalValue, high);
          const dd = drawdownHalt(totalValue, high);
          await setCfg(HIGH_KEY, String(dd.newHigh));
          await setCfg(DD_TIER_KEY, JSON.stringify({ tier: tier.tier, mult: tier.mult, label: tier.label, ddPct: tier.ddPct, ddUsd: tier.ddUsd, haltAtUsd: tier.haltAtUsd, at: new Date().toISOString() }));
          state.totalValue = totalValue; state.equityHigh = dd.newHigh; state.ddTier = { tier: tier.tier, mult: tier.mult, label: tier.label, ddPct: tier.ddPct };
          if (dd.halt && (await cfg(ARMED_KEY)) === "true") { await setCfg(ARMED_KEY, "false"); await page(`🛑 Options desk DISARMED: account value $${totalValue.toFixed(0)} is $${tier.ddUsd.toFixed(0)} (${tier.ddPct}%) under its high $${dd.newHigh.toFixed(0)} — the halt is the larger of $${OPTIONS_LIVE_RULES.drawdownHaltUsd} and ${OPTIONS_LADDER_RULES.ddHaltPct * 100}%. Open positions stay managed.`); }
        }
      }
      if (clean) { await setCfg(GUARDIAN_KEY, new Date().toISOString()); state.guardianOk = true; } else state.guardianOk = false;

      // ---------- PROBE (review-only) ----------
      // Sends ONE review for the top candidate and checks every field the cap depends on decoded
      // from the real response. Places nothing. Success flips options_live_integration_verified.
      if (MODE === "probe" || (MODE === "entry" && !verified)) {
        const result = await probe(broker, snapshot, store);
        await setCfg(PROBE_KEY, JSON.stringify(result));
        state.probe = result;
        if (result.ok) { await setCfg(VERIFIED_KEY, "true"); await page(`✅ Options adapter VERIFIED on a real broker review (${result.candidate}): fees ${result.fee}, buying power ${result.buyingPower}. The next entry tick may place one contract.`); }
        else await page(`⚠️ Options adapter NOT verified: ${result.reason}. No order will be placed until this is fixed.`);
      }

      // ---------- ENTRY ----------
      if (MODE === "entry" && verified && clean) {
        const policy = await readOptionsExecutionPolicy();
        const today = etDay(Date.now());
        const ledger = await store.withAccountLock(ACCOUNT, () => store.intentsSince(0));
        const todays = ledger.filter((r) => r.action === "open" && etDay(r.createdAtMs ?? 0) === today);
        // Slots: every name that clears the screen, up to options_live_slots (default 3) at once — one entry per tick, so the next
        // tick takes the next name; the reserve and cluster rules inside pickCandidate are the real ceiling. The divergence check
        // (no unknowns, fees inside the reserve, fills near the limit) throttles back to one slot once it has ten closed trades and is red.
        const trips = roundTrips(ledger), divergence = divergenceVerdict(trips, ledger, policy.feeBudgetUsd);
        const wantedSlots = Number(await cfg(SLOTS_KEY));
        const slots = slotsFor(divergence.closedTrades, divergence.green, Number.isFinite(wantedSlots) && wantedSlots > 0 ? wantedSlots : undefined);
        const promoted = (await cfg(PROMOTED_KEY)) === "true";
        state.slots = slots; state.promoted = promoted; state.ledger = { closedTrades: divergence.closedTrades, divergenceGreen: divergence.green, reasons: divergence.reasons.slice(0, 5) };
        if (!policy.armed) log("entry: desk is not armed");
        else if (!session || Date.now() > session.closesAtMs - 30 * 60_000) log("entry: inside the last 30 minutes — no new entries");
        else if (owned.length >= slots) log(`entry: ${owned.length} position${owned.length === 1 ? "" : "s"} open — ${slots} slot${slots === 1 ? "" : "s"} (${divergence.closedTrades} closed live trades, divergence ${divergence.green ? "green" : "red"})`);
        else if (todays.length >= OPTIONS_LIVE_RULES.maxEntriesPerDay) log(`entry: ${todays.length} entry attempt(s) already today`);
        else if (tier && tier.mult === 0) log(`entry: drawdown tier ${tier.tier} (${tier.label}) — entries halted`);
        else {
          const pick = await pickCandidate(broker, policy, snapshot?.buyingPowerUsd ?? 0, { equity: totalValue, tier, promoted, owned });
          state.candidate = pick.note; state.market = pick.market; state.grade = pick.grade; state.cap = pick.cap;
          let res: Awaited<ReturnType<typeof executeOptionsIntent>> | null = null;
          if (!pick.intent) log(`entry: ${pick.note}`);
          else {
            // The ladder's answer becomes the policy the core enforces on review AND re-review: this tick's cap, slots and contracts — never above the armed ceiling.
            const entryDeps: OptionsExecutorDependencies = { ...deps, policy: async () => { const base = await readOptionsExecutionPolicy(); return { ...base, maxLossUsd: base.maxLossUsd == null ? null : Math.min(base.maxLossUsd, pick.cap), maxOpenPositions: slots, maxQuantity: pick.intent!.quantity }; } };
            broker.noteTheoreticalMaxLoss(pick.maxLossUsd);
            res = await executeOptionsIntent(pick.intent, entryDeps);
            log(`ENTRY ${pick.intent.kind} ${pick.underlying} × ${pick.intent.quantity} [${pick.grade} cap $${pick.cap}]: ${res.status}${res.reason ? ` — ${res.reason}` : ""}${res.orderId ? ` order ${res.orderId}` : ""}`);
            // Stash the thesis on the reservation RECORD (the intent stays canonical): the fill ingest copies the range edge onto the owned record.
            // Written before anything else follows the core's answer — the guardian's invalidation rule depends on it.
            if (res.status === "accepted" && pick.candidate) await store.withAccountLock(ACCOUNT, async () => { const rec = await store.getIntent(pick.intent!.refId); if (rec) await store.putIntent({ ...rec, candidate: { ...pick.candidate } }); })
              .catch((e) => log(`could not stash the candidate on ${pick.intent!.refId} (invalidation rule will be skipped for it): ${String(e).slice(0, 160)}`));
          }
          // The trade cards (D5): built from what the tick knew, AFTER the core has answered and the thesis is stashed; a throw yields no cards
          // (safeEntryTickCards), the write is `.catch`ed — never on the order's path.
          const cards = safeEntryTickCards({ data: pick.data ?? null, refused: pick.refused ?? [], equity: totalValue, feeReserveUsd: policy.feeBudgetUsd ?? 0,
            chosen: pick.intent && pick.research && pick.live && pick.grade ? { candidate: pick.research, live: pick.live, quantity: pick.intent.quantity, grade: pick.grade, cap: pick.cap } : null, result: res }, log);
          if (pick.intent && res) {
            if (res.status === "accepted") await page(`📥 Options ENTRY placed: ${pick.intent.kind} ${pick.underlying} ${pick.expiry} × ${pick.intent.quantity} at ${pick.intent.limitPrice.toFixed(2)} (grade ${pick.grade}, max loss $${pick.maxLossUsd.toFixed(0)} + fees under a $${pick.cap} cap${tier && tier.tier > 0 ? `, drawdown tier ${tier.tier} ×${tier.mult}` : ""}; invalidation ${pick.candidate?.direction === "bullish" ? `below ${pick.candidate.rangeLow}` : `above ${pick.candidate?.rangeHigh}`}). Order ${res.orderId}.${cards[0] ? `\n${cards[0].text}` : ""}`);
            else if (res.status === "refused") log(`entry refused by the core: ${res.reason}`);
            else await page(`🚨 Options entry ended ${res.status}: ${res.reason}. No retry until reconciled.`);
          }
          await persistEntryDecision(cards, log).catch((e) => log(`trade cards: ${String(e).slice(0, 160)}`));
        }
      }
      await setCfg(STATE_KEY, JSON.stringify(state));
    });
  } finally {
    await appendLog().catch(() => {});
    await pool.end().catch(() => {});
  }
}

async function research(): Promise<OptionsResearch | null> {
  try { const r = JSON.parse((await cfg(OPTIONS_RESEARCH_KEY)) ?? "null"); return isOptionsResearch(r) ? r : null; } catch { return null; }
}
/** Account value from the after-close collector (options_account_snapshot): the equity the ladder and the drawdown tiers size against. null → the reserve refuses. */
async function accountValue(): Promise<number | null> {
  const acct = await prisma.agentConfig.findUnique({ where: { key: "options_account_snapshot" } }).then((r) => r?.value ? JSON.parse(r.value) as { totalValue?: number } : null).catch(() => null);
  return typeof acct?.totalValue === "number" && acct.totalValue > 0 ? acct.totalValue : null;
}
/** What the desk saw of the market on this tick — stamped into options_live_state.market beside the candidate note. */
interface MarketView extends MarketStamp { veto: "on" | "off"; spyIntradayPct: number | "unknown" | "stale"; at: string }
/** What the ladder sizes against: account value, the drawdown tier, the A+ switch and what is already owned. */
interface SizingContext { equity: number | null; tier: DrawdownTier | null; promoted: boolean; owned: OwnedPositionRecord[] }
/** What the runner remembers about the setup beside the canonical intent — written on the reservation record after acceptance. */
interface CandidateStash { symbol: string; kind: string; setup: string; direction: "bullish" | "bearish"; rangeLow: number; rangeHigh: number; grade: OptionsGrade; cap: number; spreadPct: number | null; quantity: number }
interface Pick {
  intent: OptionsLiveIntent | null; note: string; maxLossUsd: number; underlying: string; expiry: string; market?: MarketView; grade: OptionsGrade | null; cap: number; candidate?: CandidateStash;
  /** For the trade card, written AFTER the decision: the chosen research row re-priced live, every refused row with its gate, and the snapshot the greeks come from. */
  research?: ResearchCandidate; live?: LivePricing; refused?: RefusedCandidate[]; data?: OptionsResearch | null;
}
/** Top debit candidate from the research screen, re-priced on quotes fetched THIS second and sized by the ladder:
 *  cap = min(ceiling, maxLossFor(grade, equity)) × drawdown multiplier; two contracts only on a Strong-or-better grade whose structure fits twice. */
async function pickCandidate(broker: RobinhoodLiveBroker, policy: OptionsLivePolicy, buyingPower: number, ctx: SizingContext): Promise<Pick> {
  const data = await research();
  const ceiling = policy.maxLossUsd ?? 0, fee = policy.feeBudgetUsd ?? 0, mult = ctx.tier?.mult ?? 1;
  // The screen runs at the widest cap any grade could earn this tick; each candidate's own grade narrows it below.
  const cap = Math.round(maxLossFor(ctx.promoted ? "A+" : "Strong", ctx.equity, ceiling) * mult * 100) / 100;
  const refused: RefusedCandidate[] = [];
  const none = (note: string, market?: MarketView): Pick => ({ intent: null, note, maxLossUsd: 0, underlying: "", expiry: "", market, grade: null, cap, refused, data });
  if (!data) return none("no broker research on file");
  // Broad market first: SPY/QQQ against their averages from the research bars, VIX from Yahoo (stamp only, null on failure),
  // SPY's intraday move from a live quote (fail-soft). The one pre-registered veto is on unless options_live_market_veto="false".
  const vetoOn = (await cfg(MARKET_VETO_KEY)) !== "false";
  const vix = await vixLevel();
  const stamp = marketState({ SPY: data.bars.SPY, QQQ: data.bars.QQQ }, vix, Date.now());
  const spyQuote = vetoOn ? await broker.underlyingQuote("SPY") : null;
  const shockNow = intradayShock(spyQuote, "bullish", Date.now());
  const market: MarketView = { spy: stamp.spy, qqq: stamp.qqq, vix: stamp.vix, veto: vetoOn ? "on" : "off", spyIntradayPct: shockNow.movePct ?? (shockNow.stale ? "stale" : "unknown"), at: new Date().toISOString() };
  log(`market: SPY ${stamp.spy.regime} 20d${stamp.spy.dayPct != null ? ` ${stamp.spy.dayPct >= 0 ? "+" : ""}${stamp.spy.dayPct}% on ${stamp.spy.day}` : ""} · QQQ ${stamp.qqq.regime} 20d${stamp.qqq.dayPct != null ? ` ${stamp.qqq.dayPct >= 0 ? "+" : ""}${stamp.qqq.dayPct}%` : ""} · VIX ${stamp.vix ?? "unknown"} · SPY intraday ${market.spyIntradayPct === "unknown" ? "unknown" : `${market.spyIntradayPct >= 0 ? "+" : ""}${market.spyIntradayPct}%`} · veto ${market.veto}`);
  const candidates = screenResearchContracts(data, cap, buyingPower, Date.now(), { vix }).filter((c) => OPTIONS_LIVE_RULES.entryKinds.includes(c.kind as StructureKind));
  if (!candidates.length) return none(noCandidateNote(data, cap), market);
  const ownedLegs = ctx.owned.map((o) => ({ symbol: o.underlying, kind: o.kind }));
  const openAtRiskUsd = ctx.owned.reduce((sum, o) => sum + (o.entryPrice * 100 + fee) * (o.legs[0]?.quantity ?? 1), 0);
  const refusals: string[] = [];
  const refuse = (c: ResearchCandidate, gate: string) => { refusals.push(`${c.symbol} ${c.kind}: ${gate}`); refused.push({ candidate: c, gate }); };
  for (const c of candidates.slice(0, 3)) {
    // The screen ran on the snapshot's clock; the desk runs on its own. A row that aged past 36h since then refuses here.
    const earnings = spansEarnings(c.symbol, c.expiry, data.events, Date.now());
    if (!earnings.permitted) { refuse(c, earnings.note); continue; }
    if (vetoOn) {
      const direction = directionOfKind(c.kind);
      const veto = marketVeto(stamp, direction, c.symbol);
      if (veto.vetoed) { refuse(c, `market veto — ${veto.reason}`); continue; }
      const shock = intradayShock(spyQuote, direction, Date.now());
      if (shock.vetoed) { refuse(c, `market shock veto — ${shock.reason}`); continue; }
    }
    // Do not chase: the name's own move today (live quote, ≤15 min old) against its implied daily move from the research ATM IV.
    // At 2× or more the desk waits for the next trigger. No quote, a stale one, or no IV → stamped null, never a veto.
    const chase = chaseCheck(await broker.underlyingQuote(c.symbol), c.atmIv, c.symbol, Date.now());
    log(`chase ${c.symbol}: ${chase.reason}`);
    if (chase.vetoed) { refuse(c, chase.reason); continue; }
    // Cluster: the same direction in the same group, or an index ETF beside a semis/megacap name, is one bet already on.
    const cluster = clusterRisk(ownedLegs, { symbol: c.symbol, kind: c.kind });
    if (cluster.refused) { refuse(c, cluster.reason!); continue; }
    const legs = c.legs.map((id, i) => ({ optionId: id, side: i === 0 ? "buy" as const : "sell" as const }));
    const contracts = await broker.contracts(c.legs);
    const net = openNetAsk(legs, contracts);
    if (net == null || net <= 0) continue;
    // For the card only: the net mid ("mark") beside the natural the desk pays. Not a gate.
    const mark = Math.round(legs.reduce((sum, l) => { const k = contracts.find((x) => x.optionId === l.optionId)!; return sum + (l.side === "buy" ? 1 : -1) * (k.bid + k.ask) / 2; }, 0) * 100) / 100;
    // Grade on LIVE spreads (the research stamp is the same rule on older quotes), then the cap this grade earns at this equity and tier.
    const spreadPct = legSpreadPct(contracts.filter((k) => c.legs.includes(k.optionId)));
    const verdict = gradeFor({ ...c, spreadPct }, ctx.promoted);
    const gradeCap = Math.round(maxLossFor(verdict.grade, ctx.equity, ceiling) * mult * 100) / 100;
    const perContract = net * 100 + fee;
    if (perContract > gradeCap) { refuse(c, `$${perContract.toFixed(0)} max loss over the $${gradeCap} ${verdict.grade} cap (${verdict.reasons[0]})`); continue; }
    const quantity = verdict.grade !== "Normal" && perContract * 2 <= gradeCap ? 2 : 1;
    const maxLossUsd = net * 100 * quantity;
    const reserve = reserveRefusal(openAtRiskUsd, maxLossUsd + fee * quantity, ctx.equity);
    if (reserve) { refuse(c, reserve); continue; }
    const dte = dteOf(c.expiry, Date.now());
    if (dte < OPTIONS_DESK_RULES.minDte || dte > OPTIONS_DESK_RULES.maxDte) continue;
    // One live earnings read for the chosen name only. Any failure — tool missing, shape unknown, broker error — refuses:
    // an unconfirmed earnings date is an earnings trade the desk did not ask for. Index ETFs have none to confirm.
    if (!OPTIONS_EVENT_RULES.indexEtfs.includes(c.symbol)) {
      let live: Awaited<ReturnType<typeof broker.nextEarnings>>;
      try { live = await broker.nextEarnings(c.symbol); }
      catch (e) { refuse(c, `live earnings check failed — ${String(e).slice(0, 160)} (refused, fail closed)`); continue; }
      if (live.earningsAt <= c.expiry) { refuse(c, `broker says earnings ${live.earningsAt}${live.timing ? ` (${live.timing})` : ""}${live.verified ? "" : ", tentative"} falls before expiry ${c.expiry} (via ${live.via})`); continue; }
      log(`earnings ${c.symbol}: next ${live.earningsAt}${live.verified ? "" : " (tentative)"} after expiry ${c.expiry} (via ${live.via}); research row ${earnings.note}`);
    }
    log(`grade ${c.symbol} ${c.kind}: ${verdict.grade} (${verdict.reasons.join("; ")}) → cap $${gradeCap}${mult < 1 ? ` after ×${mult} drawdown tier` : ""}, ${quantity} contract${quantity === 1 ? "" : "s"}`);
    return { intent: { refId: randomUUID(), action: "open", kind: c.kind as StructureKind, quantity, limitPrice: net, legs }, note: `${c.kind} ${c.symbol} ${c.expiry} × ${quantity} @ ${net.toFixed(2)} [${verdict.grade} cap $${gradeCap} · dte ${c.dteBucket} · hold ${c.expectedHoldDays}d · theta ${c.thetaDragUsd == null ? "unknown" : `$${c.thetaDragUsd}`} · delta ${c.deltaBand} · chase ${chase.ratio ?? "unknown"} · cluster ${clusterOf(c.symbol) ?? "none"}] (${c.reason})`, maxLossUsd, underlying: c.symbol, expiry: c.expiry, market, grade: verdict.grade, cap: gradeCap,
      candidate: { symbol: c.symbol, kind: c.kind, setup: c.setup, direction: directionOfKind(c.kind), rangeLow: c.rangeLow, rangeHigh: c.rangeHigh, grade: verdict.grade, cap: gradeCap, spreadPct, quantity },
      research: c, live: { natural: net, mark, expectedFill: net }, refused, data };
  }
  return none(refusals.length ? `refused: ${refusals.join("; ")}` : "the research candidates no longer fit the cap on live quotes", market);
}
/** A cap-sized debit spread to REVIEW when no signal is live: adjacent strikes, same expiry, quality-passing, cheapest first. */
async function probeStructure(broker: RobinhoodLiveBroker, cap: number, fee: number): Promise<Pick> {
  const data = await research();
  const none = (note: string): Pick => ({ intent: null, note, maxLossUsd: 0, underlying: "", expiry: "", grade: null, cap });
  if (!data) return none("no broker research on file");
  const good = data.contracts.filter((c) => contractQualityFailures(c).length === 0);
  const pairs: { long: string; short: string; kind: StructureKind; symbol: string; expiry: string; est: number }[] = [];
  for (const a of good) for (const b of good) {
    if (a.symbol !== b.symbol || a.expiry !== b.expiry || a.type !== b.type || a.id === b.id) continue;
    const adjacent = (a.type === "call" ? b.strike > a.strike : b.strike < a.strike) && Math.abs(a.strike - b.strike) <= 5;
    if (!adjacent) continue;
    const est = a.ask - b.bid;
    if (est > 0 && est * 100 + fee <= cap) pairs.push({ long: a.id, short: b.id, kind: a.type === "call" ? "call_debit" : "put_debit", symbol: a.symbol, expiry: a.expiry, est });
  }
  pairs.sort((x, y) => x.est - y.est);
  for (const pr of pairs.slice(0, 3)) {
    const legs = [{ optionId: pr.long, side: "buy" as const }, { optionId: pr.short, side: "sell" as const }];
    const net = openNetAsk(legs, await broker.contracts([pr.long, pr.short]));
    if (net == null || net <= 0 || net * 100 + fee > cap) continue;
    return { intent: { refId: randomUUID(), action: "open", kind: pr.kind, quantity: 1, limitPrice: net, legs }, note: `probe-only ${pr.kind} ${pr.symbol} ${pr.expiry} @ ${net.toFixed(2)} (no signal; review only)`, maxLossUsd: net * 100, underlying: pr.symbol, expiry: pr.expiry, grade: null, cap };
  }
  return none("no quality-passing debit spread fits the cap on live quotes");
}
/** Review-only pass on the top candidate; every decoded field is reported, nothing is placed. */
async function probe(broker: RobinhoodLiveBroker, snapshot: Awaited<ReturnType<typeof broker.snapshot>> | null, store: PostgresOptionsLiveStore) {
  const at = new Date().toISOString();
  if (!snapshot) return { at, ok: false, reason: "broker snapshot failed" };
  const check: string[] = [];
  if (snapshot.accountNumber !== ACCOUNT) check.push(`account ${snapshot.accountNumber || "missing"}`);
  if (!snapshot.active || !snapshot.agenticAllowed) check.push("account not active/agentic");
  if (snapshot.optionLevel !== "option_level_3") check.push(`option level ${snapshot.optionLevel}`);
  if (snapshot.marginType !== "limited_margin") check.push(`account type ${snapshot.marginType}`);
  if (!Number.isFinite(snapshot.buyingPowerUsd)) check.push("buying power unreadable");
  if (!snapshot.regularSession) check.push("no regular session");
  if (check.length) return { at, ok: false, reason: `snapshot: ${check.join("; ")}` };
  const maxLoss = parseOptionsMaxLoss(await cfg(OPTIONS_MAX_LOSS_KEY)) ?? 0;
  const fee = parseOptionsMaxLoss(await cfg("options_live_verified_fee_reserve_usd")) ?? 0;
  const probePolicy: OptionsLivePolicy = { armed: true, maxLossUsd: maxLoss, feeBudgetUsd: fee, guardianHealthyAtMs: Date.now() };
  let pick = await pickCandidate(broker, probePolicy, snapshot.buyingPowerUsd, { equity: await accountValue(), tier: null, promoted: false, owned: [] });
  // No signal today is the normal case for a rule that fires a few times a month. The probe only
  // needs a real, cap-sized debit structure to REVIEW (never place), so fall back to the cheapest
  // quality-passing adjacent-strike debit spread on the watchlist.
  if (!pick.intent) pick = await probeStructure(broker, maxLoss, fee);
  if (!pick.intent) return { at, ok: false, reason: `no structure to review: ${pick.note}` };
  const legIds = pick.intent.legs.map((l) => l.optionId), refId = pick.intent.refId;
  const fresh = await store.withAccountLock(ACCOUNT, () => broker.snapshot(legIds, refId));
  let prepared;
  // The review is sized exactly as the entry would be: the pick's cap and contract count become the policy, as on an entry tick.
  try { prepared = prepareOptionsOrder(pick.intent, { ...probePolicy, maxLossUsd: Math.min(maxLoss, pick.cap), maxQuantity: pick.intent.quantity }, fresh, null, Date.now()); }
  catch (e) { return { at, ok: false, reason: `policy refused the probe order: ${String(e).slice(0, 200)}`, candidate: pick.note }; }
  broker.noteTheoreticalMaxLoss(prepared.theoreticalMaxLossUsd);
  const raw = await broker.callTool("review_option_order", { ...prepared.params });
  const review = broker.decodeReview(raw) as { approved: boolean; estimatedFeeUsd: number; buyingPowerRequiredUsd: number; maxLossUsd: number; missing: string[]; blocking: string[] };
  const keys = (x: unknown, d = 0): string[] => (x && typeof x === "object" && d < 3 ? Object.entries(x as Record<string, unknown>).flatMap(([k, v]) => [k, ...keys(v, d + 1).map((s) => `${k}.${s}`)]) : []);
  const shape = keys(raw).slice(0, 80);
  if (!review.approved) return { at, ok: false, reason: `review ${review.missing.length ? `missing ${review.missing.join(",")}` : ""}${review.blocking.length ? ` blocking: ${review.blocking.join("; ")}` : ""}`, candidate: pick.note, shape };
  return { at, ok: true, candidate: pick.note, fee: review.estimatedFeeUsd, buyingPower: review.buyingPowerRequiredUsd, maxLoss: review.maxLossUsd, shape };
}

// CLI: `live-desk.ts guard|entry|probe` (the Mac's launchd runner). The Railway worker imports runLiveDesk instead.
if (process.argv[1] && /live-desk\.ts$/.test(process.argv[1])) {
  const arg = process.argv[2];
  if (!["guard", "entry", "probe"].includes(arg ?? "")) { console.error("mode must be guard | entry | probe"); process.exit(2); }
  runLiveDesk(arg as LiveDeskMode)
    .catch((e) => { console.error(`live-desk ${arg} failed: ${String(e).slice(0, 300)}`); process.exitCode = 1; })
    .finally(() => prisma.$disconnect().catch(() => {}));
}
