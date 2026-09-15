// THE OPTIONS LIVE DESK RUNNER (Sep 13 2026) — the only process that may place a Robinhood order.
//
//   node --env-file=.env.local --import tsx scripts/robinhood/live-desk.ts guard   # every 5 min in RTH
//   node --env-file=.env.local --import tsx scripts/robinhood/live-desk.ts entry   # :05/:35 in RTH — guard, then one entry attempt
//   node --env-file=.env.local --import tsx scripts/robinhood/live-desk.ts probe   # review-only: proves the decoders on real responses
//
// Runs on this Mac (the OAuth credential lives here; Vercel never holds it). Every order goes
// through the validated core in src/lib/options-live-executor.ts: review → durable reservation →
// place → reconcile, under the account lock, one contract, inside the $100 cap. This file decides
// WHEN and WHAT; the core decides WHETHER. Nothing here calls the broker's order tools directly.
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
import { OPTIONS_LIVE_RULES, drawdownHalt, dteOf, etDay, exitDecision, openNetAsk, type OwnedPositionRecord } from "../../src/lib/options-live-guardian";
import { OPTIONS_RESEARCH_KEY, OPTIONS_DESK_RULES, contractQualityFailures, isOptionsResearch, noCandidateNote, screenResearchContracts, type OptionsResearch } from "../../src/lib/options-desk-model";
import { OPTIONS_EVENT_RULES, guardianExDivExit, spansEarnings } from "../../src/lib/options-events";
import { chaseCheck, directionOfKind, intradayShock, marketState, marketVeto, vixLevel, type MarketStamp } from "../../src/lib/options-market-state";
import { OPTIONS_MAX_LOSS_KEY, parseOptionsMaxLoss } from "../../src/lib/options-operation";
import type { StructureKind } from "../../src/lib/options-structures";

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
        if (rec.order.state === "filled" && rec.intent && rec.canonicalOrder) {
          await store.withAccountLock(ACCOUNT, async () => {
            if (rec.action === "open") {
              const legs = rec.intent!.legs.map((l) => ({ optionId: l.optionId, side: l.side === "buy" ? "long" as const : "short" as const, quantity: rec.intent!.quantity }));
              const contracts = await broker.contracts(legs.map((l) => l.optionId));
              const strikes = contracts.map((c) => c.strike);
              const width = strikes.length === 2 ? Math.abs(strikes[0] - strikes[1]) : 0;
              const shortLeg = legs.find((l) => l.side === "short");
              const shortStrike = shortLeg ? contracts.find((c) => c.optionId === shortLeg.optionId)?.strike ?? null : null;
              const event = (await research())?.events?.[contracts[0]?.underlying ?? ""];
              const owned: OwnedPositionRecord = { id: rec.refId, accountNumber: ACCOUNT, openingRefId: rec.refId, legs, kind: rec.intent!.kind, direction: rec.canonicalOrder!.direction,
                entryPrice: Number(rec.canonicalOrder!.price), width, openedAtMs: rec.createdAtMs ?? Date.now(), expiry: contracts[0]?.expiry ?? "", underlying: contracts[0]?.underlying ?? "",
                exDivAt: event?.exDivAt ?? null, ...(event?.exDivSource ? { exDivSource: event.exDivSource } : {}), shortStrike };
              await store.putOwnedPosition(owned);
              await store.putIntent({ ...rec, state: "settled" });
              await page(`✅ Options FILLED: ${owned.kind} ${owned.underlying} ${owned.expiry} × ${rec.intent!.quantity} at ${owned.entryPrice.toFixed(2)} (order ${rec.order!.id}). The guardian now manages it: stop at half the premium, a trail once it has been worth 1.5× (keeps half the best gain), out 7 days before expiry.`);
            } else if (rec.action === "close" && rec.positionId) {
              await store.releaseOwnedPosition(rec.positionId);
              await store.putIntent({ ...rec, state: "settled" });
              await page(`✅ Options CLOSED: position ${rec.positionId} at ${rec.canonicalOrder!.price} (order ${rec.order!.id}).`);
            }
          });
        } else if (["open", "partially_filled"].includes(rec.order.state) && rec.createdAtMs && Date.now() - rec.createdAtMs > OPTIONS_LIVE_RULES.staleEntryMinutes * 60_000) {
          try { await broker.cancel(rec.order.id); log(`stale ${rec.action} ${rec.refId} cancelled after ${OPTIONS_LIVE_RULES.staleEntryMinutes} min; next tick settles or ingests its fills`); }
          catch (e) { fail("cancel stale order", e); }
        }
      }

      // 2) Broker snapshot: account, positions, orders, quotes for our legs.
      // The adapter reads intents and owned positions from the store while building a snapshot, and
      // the store refuses any read outside the account lock — so the snapshot is taken under it.
      // (The core takes its own lock around its snapshots; this is the guardian's standalone read.)
      let snapshot: Awaited<ReturnType<typeof broker.snapshot>> | null = null;
      try { snapshot = await store.withAccountLock(ACCOUNT, () => broker.snapshot([], "")); } catch (e) { fail("broker snapshot", e); }
      const owned = await store.withAccountLock(ACCOUNT, () => store.ownedPositions()) as OwnedPositionRecord[];
      state.owned = owned.map((o) => ({ id: o.id, kind: o.kind, underlying: o.underlying, expiry: o.expiry, entryPrice: o.entryPrice }));
      if (snapshot) {
        state.buyingPower = snapshot.buyingPowerUsd; state.brokerPositions = snapshot.positions.length; state.openOrders = snapshot.orders.filter((o) => !["filled", "cancelled", "rejected"].includes(o.state)).length;
        // 3) Manage what we own; release what the broker no longer shows.
        for (const pos of owned) {
          const live = snapshot.positions.find((p) => p.id === pos.id);
          if (!live) {
            await store.withAccountLock(ACCOUNT, () => store.releaseOwnedPosition(pos.id));
            await page(`⚠️ Options position ${pos.id} (${pos.kind} ${pos.underlying}) is no longer at the broker — expired, assigned or closed by hand. Released from the guardian.`);
            continue;
          }
          const decision = exitDecision(pos, snapshot.contracts, Date.now());
          log(`${pos.underlying} ${pos.kind}: ${decision.reason}`);
          // The trail's anchor lives on the owned record, so a restart cannot forget the best mark seen.
          if (decision.peakNet != null && decision.peakNet !== pos.peakNet) await store.withAccountLock(ACCOUNT, () => store.putOwnedPosition({ ...pos, peakNet: decision.peakNet }));
          // Ex-dividend assignment rule: a call debit spread with its short call in the money and the ex-date ≤ 2 days out closes at
          // its executable mark. The underlying quote is fail-soft — no quote, rule skipped and said so.
          if (!decision.exit && pos.kind === "call_debit" && pos.exDivAt) {
            const q = await broker.underlyingQuote(pos.underlying);
            const ex = guardianExDivExit(pos, q, Date.now());
            log(`${pos.underlying} ${pos.kind}: ${ex.reason}`);
            if (ex.exit && decision.markNet != null && decision.markNet > 0) { decision.exit = true; decision.reason = ex.reason; decision.limitPrice = Math.min(decision.markNet, pos.width > 0 ? pos.width : decision.markNet); }
            else if (ex.exit) log(`${pos.underlying} ${pos.kind}: ex-dividend exit wanted but no bid — will retry next tick`);
          }
          if (!decision.exit || decision.limitPrice == null) continue;
          const closeIntent: OptionsLiveIntent = { refId: randomUUID(), action: "close", kind: pos.kind, positionId: pos.id, quantity: pos.legs[0].quantity, limitPrice: decision.limitPrice,
            legs: pos.legs.map((l) => ({ optionId: l.optionId, side: l.side === "long" ? "sell" as const : "buy" as const })) };
          broker.noteTheoreticalMaxLoss(0);
          const res = await executeOptionsIntent(closeIntent, deps);
          log(`close ${pos.id}: ${res.status}${res.reason ? ` — ${res.reason}` : ""}`);
          if (res.status === "accepted") await page(`📤 Options CLOSE sent for ${pos.underlying} ${pos.kind} at ${decision.limitPrice.toFixed(2)} (${decision.reason}).`);
          else if (res.status !== "refused") { clean = false; await page(`🚨 Options close for ${pos.id} ended ${res.status}: ${res.reason}`); }
        }
        // 4) Drawdown halt on account value.
        const acct = await prisma.agentConfig.findUnique({ where: { key: "options_account_snapshot" } }).then((r) => r?.value ? JSON.parse(r.value) as { totalValue?: number } : null).catch(() => null);
        const totalValue = typeof acct?.totalValue === "number" ? acct.totalValue : null;
        if (totalValue != null) {
          const high = Number((await cfg(HIGH_KEY)) ?? totalValue) || totalValue;
          const dd = drawdownHalt(totalValue, high);
          await setCfg(HIGH_KEY, String(dd.newHigh));
          state.totalValue = totalValue; state.equityHigh = dd.newHigh;
          if (dd.halt && (await cfg(ARMED_KEY)) === "true") { await setCfg(ARMED_KEY, "false"); await page(`🛑 Options desk DISARMED: account value $${totalValue.toFixed(0)} is more than $${OPTIONS_LIVE_RULES.drawdownHaltUsd} under its high $${dd.newHigh.toFixed(0)}. Open positions stay managed.`); }
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
        const todays = (await store.withAccountLock(ACCOUNT, () => store.intentsSince(Date.now() - 36 * 3600_000))).filter((r) => r.action === "open" && etDay(r.createdAtMs ?? 0) === today);
        if (!policy.armed) log("entry: desk is not armed");
        else if (!session || Date.now() > session.closesAtMs - 30 * 60_000) log("entry: inside the last 30 minutes — no new entries");
        else if (owned.length >= OPTIONS_LIVE_RULES.maxOpenPositions) log("entry: a position is open — one at a time");
        else if (todays.length >= OPTIONS_LIVE_RULES.maxEntriesPerDay) log(`entry: ${todays.length} entry attempt(s) already today`);
        else {
          const pick = await pickCandidate(broker, policy, snapshot?.buyingPowerUsd ?? 0);
          state.candidate = pick.note; state.market = pick.market;
          if (!pick.intent) log(`entry: ${pick.note}`);
          else {
            broker.noteTheoreticalMaxLoss(pick.maxLossUsd);
            const res = await executeOptionsIntent(pick.intent, deps);
            log(`ENTRY ${pick.intent.kind} ${pick.underlying}: ${res.status}${res.reason ? ` — ${res.reason}` : ""}${res.orderId ? ` order ${res.orderId}` : ""}`);
            if (res.status === "accepted") await page(`📥 Options ENTRY placed: ${pick.intent.kind} ${pick.underlying} ${pick.expiry} × 1 at ${pick.intent.limitPrice.toFixed(2)} (max loss $${pick.maxLossUsd.toFixed(0)} + fees). Order ${res.orderId}.`);
            else if (res.status === "refused") log(`entry refused by the core: ${res.reason}`);
            else await page(`🚨 Options entry ended ${res.status}: ${res.reason}. No retry until reconciled.`);
          }
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
/** What the desk saw of the market on this tick — stamped into options_live_state.market beside the candidate note. */
interface MarketView extends MarketStamp { veto: "on" | "off"; spyIntradayPct: number | "unknown" | "stale"; at: string }
/** Top debit candidate from the research screen, re-priced on quotes fetched THIS second. */
async function pickCandidate(broker: RobinhoodLiveBroker, policy: OptionsLivePolicy, buyingPower: number): Promise<{ intent: OptionsLiveIntent | null; note: string; maxLossUsd: number; underlying: string; expiry: string; market?: MarketView }> {
  const data = await research();
  const cap = policy.maxLossUsd ?? 0, fee = policy.feeBudgetUsd ?? 0;
  if (!data) return { intent: null, note: "no broker research on file", maxLossUsd: 0, underlying: "", expiry: "" };
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
  if (!candidates.length) return { intent: null, note: noCandidateNote(data, cap), maxLossUsd: 0, underlying: "", expiry: "", market };
  const refusals: string[] = [];
  for (const c of candidates.slice(0, 3)) {
    // The screen ran on the snapshot's clock; the desk runs on its own. A row that aged past 36h since then refuses here.
    const earnings = spansEarnings(c.symbol, c.expiry, data.events, Date.now());
    if (!earnings.permitted) { refusals.push(`${c.symbol} ${c.kind}: ${earnings.note}`); continue; }
    if (vetoOn) {
      const direction = directionOfKind(c.kind);
      const veto = marketVeto(stamp, direction, c.symbol);
      if (veto.vetoed) { refusals.push(`${c.symbol} ${c.kind}: market veto — ${veto.reason}`); continue; }
      const shock = intradayShock(spyQuote, direction, Date.now());
      if (shock.vetoed) { refusals.push(`${c.symbol} ${c.kind}: market shock veto — ${shock.reason}`); continue; }
    }
    // Do not chase: the name's own move today (live quote, ≤15 min old) against its implied daily move from the research ATM IV.
    // At 2× or more the desk waits for the next trigger. No quote, a stale one, or no IV → stamped null, never a veto.
    const chase = chaseCheck(await broker.underlyingQuote(c.symbol), c.atmIv, c.symbol, Date.now());
    log(`chase ${c.symbol}: ${chase.reason}`);
    if (chase.vetoed) { refusals.push(`${c.symbol} ${c.kind}: ${chase.reason}`); continue; }
    const legs = c.legs.map((id, i) => ({ optionId: id, side: i === 0 ? "buy" as const : "sell" as const }));
    const contracts = await broker.contracts(c.legs);
    const net = openNetAsk(legs, contracts);
    if (net == null || net <= 0) continue;
    const maxLossUsd = net * 100;
    if (maxLossUsd + fee > cap) { continue; }
    const dte = dteOf(c.expiry, Date.now());
    if (dte < OPTIONS_DESK_RULES.minDte || dte > OPTIONS_DESK_RULES.maxDte) continue;
    // One live earnings read for the chosen name only. Any failure — tool missing, shape unknown, broker error — refuses:
    // an unconfirmed earnings date is an earnings trade the desk did not ask for. Index ETFs have none to confirm.
    if (!OPTIONS_EVENT_RULES.indexEtfs.includes(c.symbol)) {
      let live: Awaited<ReturnType<typeof broker.nextEarnings>>;
      try { live = await broker.nextEarnings(c.symbol); }
      catch (e) { refusals.push(`${c.symbol} ${c.kind}: live earnings check failed — ${String(e).slice(0, 160)} (refused, fail closed)`); continue; }
      if (live.earningsAt <= c.expiry) { refusals.push(`${c.symbol} ${c.kind}: broker says earnings ${live.earningsAt}${live.timing ? ` (${live.timing})` : ""}${live.verified ? "" : ", tentative"} falls before expiry ${c.expiry} (via ${live.via})`); continue; }
      log(`earnings ${c.symbol}: next ${live.earningsAt}${live.verified ? "" : " (tentative)"} after expiry ${c.expiry} (via ${live.via}); research row ${earnings.note}`);
    }
    return { intent: { refId: randomUUID(), action: "open", kind: c.kind as StructureKind, quantity: 1, limitPrice: net, legs }, note: `${c.kind} ${c.symbol} ${c.expiry} @ ${net.toFixed(2)} [dte ${c.dteBucket} · hold ${c.expectedHoldDays}d · theta ${c.thetaDragUsd == null ? "unknown" : `$${c.thetaDragUsd}`} · delta ${c.deltaBand} · chase ${chase.ratio ?? "unknown"}] (${c.reason})`, maxLossUsd, underlying: c.symbol, expiry: c.expiry, market };
  }
  return { intent: null, note: refusals.length ? `refused: ${refusals.join("; ")}` : "the research candidates no longer fit the cap on live quotes", maxLossUsd: 0, underlying: "", expiry: "", market };
}
/** A cap-sized debit spread to REVIEW when no signal is live: adjacent strikes, same expiry, quality-passing, cheapest first. */
async function probeStructure(broker: RobinhoodLiveBroker, cap: number, fee: number): Promise<Awaited<ReturnType<typeof pickCandidate>>> {
  const data = await research();
  const none = (note: string) => ({ intent: null, note, maxLossUsd: 0, underlying: "", expiry: "" });
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
    return { intent: { refId: randomUUID(), action: "open", kind: pr.kind, quantity: 1, limitPrice: net, legs }, note: `probe-only ${pr.kind} ${pr.symbol} ${pr.expiry} @ ${net.toFixed(2)} (no signal; review only)`, maxLossUsd: net * 100, underlying: pr.symbol, expiry: pr.expiry };
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
  let pick = await pickCandidate(broker, probePolicy, snapshot.buyingPowerUsd);
  // No signal today is the normal case for a rule that fires a few times a month. The probe only
  // needs a real, cap-sized debit structure to REVIEW (never place), so fall back to the cheapest
  // quality-passing adjacent-strike debit spread on the watchlist.
  if (!pick.intent) pick = await probeStructure(broker, maxLoss, fee);
  if (!pick.intent) return { at, ok: false, reason: `no structure to review: ${pick.note}` };
  const legIds = pick.intent.legs.map((l) => l.optionId), refId = pick.intent.refId;
  const fresh = await store.withAccountLock(ACCOUNT, () => broker.snapshot(legIds, refId));
  let prepared;
  try { prepared = prepareOptionsOrder(pick.intent, probePolicy, fresh, null, Date.now()); }
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
