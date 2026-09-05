// THE $20 ROUND TRIP — one tiny real trade, through the REAL executor path, to verify the
// Kraken behaviours the executor and guardian assume before any sleeve is armed:
//
//   1. validate=true accepts the exact order shape (pair, lot precision, leverage, close[])
//   2. a real entry is accepted and ledgered (ownership) through executeAlert
//   3. OpenPositions shows the position, keyed by trade id with our ordertxid (and how fast)
//   4. the attached close[] stop shows in OpenOrders with our userref within 6 minutes,
//      its trigger (descr.price) is readable, and its volume equals the filled volume
//   5. ClosedOrders honours userref + start and reports opentm / vol_exec (recovery path)
//   6. TradeBalance.m is > 0 while the position is open (the fail-closed read guard)
//   7. a reduce_only stop-loss is accepted on the pair (placed far away, cancelled at once)
//   8. OHLC with `since` returns ≤720 bars (the scanner's data path)
//   9. a reduce_only market close is accepted and OpenPositions reflects it at once
//  10. after the close nothing of ours rests on the pair (the executor's sweep) and the
//      round trip's real fees are read back from the trade history
//
// Spencer starts it from the admin page (one click = the whole round trip: entry AND close).
// The guardian cron advances it every 5 minutes; nothing here bypasses a single executor
// guard — the executor is ARMED for the source "roundtrip" only, on one symbol, at a $10
// margin cap (= $20 notional at 2×), for the seconds the entry takes, under the shared close
// lock (so no second start and no close can interleave), and every touched config key is
// restored in `finally` — DISARM FIRST (auto → validate → sources → the limits). A restore
// that fails is retried by every guardian tick until it is clean. An interrupted start is
// recovered from the ownership ledger / OpenPositions, so an accepted entry is never
// orphaned. Kraken's FIFO netting cannot be exercised with one position; that check is
// documented, not measured.
import { prisma } from "@/lib/db";
import { sendNotification } from "@/lib/notifications";
import { krakenConfigured, krakenOpenOrders, krakenPrivate, krakenPublic, krakenCancelOrder, krakenClosedOrders, getPairMeta, krakenPair, type OpenOrder } from "@/lib/kraken";
import { getKrakenMarginPositions, getKrakenMarginHealth, getKrakenOHLC, type KrakenMarginPosition } from "@/lib/kraken-margin";
import { pairBase, isUsMarginSymbol } from "@/lib/kraken-pairs";
import { MARGIN_USERREF, executeAlert, acquireCloseLock, releaseCloseLock, type LedgerEntry } from "@/lib/margin-executor";
import { failClosedOnEmptyPositions } from "@/lib/margin-live-risk";

export const RT_KEY = "kraken_margin_round_trip";
export const RT_SOURCE = "roundtrip";
export const RT_MARGIN_USD = 10;            // margin per entry → $20 notional at the 2× rung
export const RT_MAX_OPEN_MS = 15 * 60_000;  // close no later than this after the entry
export const RT_CLOSE_AFTER_MS = 7 * 60_000; // close once the 6-min close[] window has passed
export const RT_ATTACHED_WINDOW_S = 6 * 60;  // a stop appearing later is NOT the attached close[]
export const RT_MAX_CLOSE_ATTEMPTS = 3;

export type RtStage = "idle" | "entering" | "open" | "closing" | "done" | "aborted" | "failed";
export interface RtCheck { ok: boolean | null; note: string; at: string }
export interface RtState {
  stage: RtStage;
  symbol: string;
  startedAt: string;
  updatedAt: string;
  entryTxid?: string;
  entrySentAt?: number;      // epoch secs
  closeTxid?: string;
  closeAttempts?: number;
  abortRequested?: boolean;
  positionId?: string;
  fillVol?: number;
  checks: Record<string, RtCheck>;
  log: string[];
  savedCfg?: Record<string, string | null>;
  restoreFailed?: string[];  // keys whose restore failed — retried every tick until empty
  error?: string;
  finishedAt?: string;
  fees?: { entry: number; exit: number; net: number | null };
}

export const RT_CHECKS: { key: string; label: string }[] = [
  { key: "validate_accepted", label: "validate=true accepts the exact order shape (pair, lot, leverage, close[])" },
  { key: "entry_accepted", label: "real entry accepted through executeAlert and ledgered" },
  { key: "position_visible", label: "OpenPositions shows the position keyed by trade id with our ordertxid" },
  { key: "attached_stop_visible", label: "attached close[] stop in OpenOrders with our userref within 6 min" },
  { key: "stop_trigger_readable", label: "the stop's trigger price (descr.price) is readable" },
  { key: "stop_vol_equals_fill", label: "the attached stop's volume equals the filled volume" },
  { key: "closed_orders_recovery", label: "ClosedOrders honours userref + start with opentm / vol_exec" },
  { key: "trade_balance_margin", label: "TradeBalance.m > 0 while the position is open" },
  { key: "reduce_only_stop_accepted", label: "a reduce_only stop-loss is accepted (placed far, cancelled at once)" },
  { key: "ohlc_since", label: "OHLC with since returns ≤720 bars" },
  { key: "close_accepted", label: "reduce_only market close accepted through the executor's close path" },
  { key: "position_gone", label: "OpenPositions reflects the close immediately" },
  { key: "pair_swept", label: "nothing of ours rests on the pair after the close" },
  { key: "fees_read_back", label: "entry + exit fees read back from the trade history" },
  { key: "fifo_netting", label: "FIFO netting on :BTNL — cannot be exercised with one position (documented, not measured)" },
];

// Restore order matters: DISARM first, then the source allowlist, then the limits — so no
// instant exists where auto=true meets a restored (wider) allowlist or cap.
const CFG_KEYS = ["kraken_margin_auto", "kraken_margin_validate_only", "kraken_margin_live_sources", "kraken_margin_symbols", "kraken_margin_per_trade_usd", "kraken_margin_max_positions"] as const;

const nowIso = () => new Date().toISOString();
const check = (ok: boolean | null, note: string): RtCheck => ({ ok, note, at: nowIso() });

export async function readRoundTrip(): Promise<RtState | null> {
  const row = await prisma.agentConfig.findUnique({ where: { key: RT_KEY } }).catch(() => null);
  if (!row?.value) return null;
  try { return JSON.parse(row.value) as RtState; } catch { return null; }
}
async function save(state: RtState): Promise<void> {
  state.updatedAt = nowIso();
  state.log = state.log.slice(-80);
  const value = JSON.stringify(state);
  await prisma.agentConfig.upsert({ where: { key: RT_KEY }, update: { value }, create: { key: RT_KEY, value } });
}
const log = (s: RtState, line: string) => { s.log.push(`${nowIso().slice(11, 19)} ${line}`); };

async function readCfg(keys: readonly string[]): Promise<Record<string, string | null>> {
  const rows = await prisma.agentConfig.findMany({ where: { key: { in: [...keys] } } });
  const out: Record<string, string | null> = {};
  for (const k of keys) out[k] = rows.find((r) => r.key === k)?.value ?? null;
  return out;
}
async function setCfg(key: string, value: string | null): Promise<void> {
  if (value == null) { await prisma.agentConfig.deleteMany({ where: { key } }); return; }
  await prisma.agentConfig.upsert({ where: { key }, update: { value }, create: { key, value } });
}
/** Put every touched key back exactly as it was (unset stays unset), disarm-first. Returns
 *  the keys that could not be restored; never throws. */
export async function restoreCfg(saved: Record<string, string | null> | undefined, only?: string[]): Promise<string[]> {
  const failed: string[] = [];
  if (!saved) return failed;
  for (const k of CFG_KEYS) {
    if (only && !only.includes(k)) continue;
    try { await setCfg(k, saved[k] ?? null); } catch { failed.push(k); }
  }
  return failed;
}

// ---- PURE evaluators (tested) -------------------------------------------------------------

export interface OpenSnapshot {
  entryTxid: string; pair: string; sentAtSec: number; nowSec: number;
  positions: Pick<KrakenMarginPosition, "id" | "ordertxid" | "pair" | "side" | "vol">[];
  orders: OpenOrder[];
  marginUsedRaw: number | null;
  closed: { txid: string; opentm: number; volExec: number }[] | null;   // null = read failed
}
/** Evaluate the "position is open" checks from one snapshot. Only sets a check when the
 *  answer is KNOWN; a still-pending attached stop is left null until the 6-min window ends.
 *  Only a stop opened within the window after the send counts as the ATTACHED close[] — a
 *  later one is the guardian's replacement and proves the opposite. */
export function evaluateOpenChecks(s: OpenSnapshot): { checks: Record<string, RtCheck>; position: OpenSnapshot["positions"][number] | null } {
  const c: Record<string, RtCheck> = {};
  const pos = s.positions.find((p) => p.ordertxid === s.entryTxid && pairBase(p.pair) === pairBase(s.pair)) ?? null;
  const secs = Math.max(0, Math.round(s.nowSec - s.sentAtSec));
  if (pos) c.position_visible = check(true, `visible ${secs}s after send: id ${pos.id}, vol ${pos.vol}`);
  else if (secs > 120) c.position_visible = check(false, `not in OpenPositions ${secs}s after send`);

  const stops = s.orders.filter((o) => o.userref === MARGIN_USERREF && o.ordertype === "stop-loss" && o.side === "sell" && pairBase(o.pair) === pairBase(s.pair));
  const attached = stops.filter((o) => o.opentm >= s.sentAtSec - 2 && o.opentm - s.sentAtSec <= RT_ATTACHED_WINDOW_S);
  const late = stops.filter((o) => o.opentm - s.sentAtSec > RT_ATTACHED_WINDOW_S);
  if (attached.length) {
    const st = attached[0];
    c.attached_stop_visible = check(true, `stop ${st.txid} opened ${Math.round(st.opentm - s.sentAtSec)}s after send, seen at ${secs}s`);
    c.stop_trigger_readable = check(st.price > 0, st.price > 0 ? `trigger $${st.price}` : "descr.price missing/zero — the guardian would skip this book");
    if (pos) {
      const eq = Math.abs(st.vol - pos.vol) <= Math.max(pos.vol * 0.01, 1e-8);
      c.stop_vol_equals_fill = check(eq, `stop vol ${st.vol} vs position vol ${pos.vol}`);
    }
  } else if (late.length) {
    c.attached_stop_visible = check(false, `no attached stop within ${RT_ATTACHED_WINDOW_S}s; a stop appeared ${Math.round(late[0].opentm - s.sentAtSec)}s after send (guardian replacement?)`);
  } else if (secs > RT_ATTACHED_WINDOW_S) {
    c.attached_stop_visible = check(false, `no stop of ours on the pair ${secs}s after send`);
  }

  if (s.marginUsedRaw != null) c.trade_balance_margin = check(s.marginUsedRaw > 0, `TradeBalance.m = ${s.marginUsedRaw}`);
  else if (secs > 120) c.trade_balance_margin = check(false, "TradeBalance omitted m entirely");

  if (s.closed) {
    const mine = s.closed.find((o) => o.txid === s.entryTxid);
    if (mine) c.closed_orders_recovery = check(mine.volExec > 0 && mine.opentm > 0, `entry listed: opentm ${mine.opentm}, vol_exec ${mine.volExec}`);
    else if (secs > 120) c.closed_orders_recovery = check(false, "entry NOT listed under userref+start — the recovery path would miss a lost response");
  }
  return { checks: c, position: pos };
}

export interface CloseSnapshot { entryTxid: string; pair: string; positions: Pick<KrakenMarginPosition, "id" | "ordertxid" | "pair">[]; orders: OpenOrder[]; marginUsedRaw: number | null }
/** After the close. An EMPTY positions read while margin is still in use is a degraded read,
 *  not a flat account — position_gone stays unknown then. */
export function evaluateCloseChecks(s: CloseSnapshot): Record<string, RtCheck> {
  const c: Record<string, RtCheck> = {};
  const still = s.positions.some((p) => p.ordertxid === s.entryTxid && pairBase(p.pair) === pairBase(s.pair));
  if (still) c.position_gone = check(false, "position STILL listed right after the close");
  else if (failClosedOnEmptyPositions(s.positions.length, s.marginUsedRaw)) c.position_gone = check(null, "positions read empty while margin is in use — unreliable, re-checking");
  else c.position_gone = check(true, "position gone on the first read after the close");
  const ours = s.orders.filter((o) => o.userref === MARGIN_USERREF && pairBase(o.pair) === pairBase(s.pair));
  c.pair_swept = check(ours.length === 0, ours.length ? `${ours.length} order(s) of ours still resting: ${ours.map((o) => `${o.ordertype} ${o.txid}`).join(", ")}` : "nothing of ours on the pair");
  return c;
}

/** All measured checks answered, and all of them ok. */
export function roundTripVerdict(checks: Record<string, RtCheck>): { complete: boolean; allOk: boolean; failed: string[] } {
  const measured = RT_CHECKS.filter((k) => k.key !== "fifo_netting");
  const failed = measured.filter((k) => checks[k.key]?.ok === false).map((k) => k.key);
  const complete = measured.every((k) => checks[k.key] && checks[k.key].ok != null);
  return { complete, allOk: complete && failed.length === 0, failed };
}

/** The executor's validate pass proves the order SHAPE only when it reached Kraken: its
 *  success note describes the order ("buy $20 notional (2x, market) XBTUSD, stop 3.0% …");
 *  any refusal or error note means nothing was validated, whatever `validated` says. */
export function validatePassOk(r: { validated: boolean; executed: boolean; note: string }): boolean {
  return r.validated && !r.executed && /notional \(/.test(r.note) && !/refused|failed|errored|not sent|skipped/i.test(r.note);
}

// ---- The state machine ---------------------------------------------------------------------

export async function startRoundTrip(symbol = "BTC/USD"): Promise<{ ok: boolean; note: string; state: RtState | null }> {
  if (!krakenConfigured()) return { ok: false, note: "Kraken not configured", state: null };
  symbol = symbol.toUpperCase();
  if (!isUsMarginSymbol(symbol)) return { ok: false, note: `${symbol} is not a US-margin pair`, state: null };
  const prev = await readRoundTrip();
  if (prev && ["entering", "open", "closing"].includes(prev.stage)) return { ok: false, note: `a round trip is already ${prev.stage}`, state: prev };
  if (prev?.restoreFailed?.length) return { ok: false, note: `the previous round trip could not restore ${prev.restoreFailed.join(", ")} — the guardian is retrying; wait for it`, state: prev };

  // ONE start at a time, and no close can interleave with the arming window: the shared
  // close lock. A second start (double click, second tab) is refused, not queued.
  const lock = await acquireCloseLock(5_000);
  if (!lock) return { ok: false, note: "another close/reconcile/round trip holds the lock — try again in a minute", state: prev };
  try {
    const cfg0 = await readCfg(CFG_KEYS);
    if (cfg0.kraken_margin_auto === "true") return { ok: false, note: "the executor is ARMED (kraken_margin_auto=true) — the round trip is for the disarmed phase only", state: prev };

    // Preflight on the account: nothing on the pair from anyone (FIFO), nothing of ours resting.
    const pair = krakenPair(symbol);
    const [positions, orders, health] = await Promise.all([getKrakenMarginPositions(), krakenOpenOrders(), getKrakenMarginHealth()]);
    if (failClosedOnEmptyPositions(positions.length, health.marginUsedRaw)) return { ok: false, note: "positions read empty while margin is in use — unreliable read, try again", state: prev };
    const onPair = positions.filter((p) => pairBase(p.pair) === pairBase(pair));
    if (onPair.length) return { ok: false, note: `${onPair.length} position(s) already open on ${symbol} — a round trip needs an empty pair (Kraken nets FIFO)`, state: prev };
    const oursResting = orders.filter((o) => o.userref === MARGIN_USERREF && pairBase(o.pair) === pairBase(pair));
    if (oursResting.length) return { ok: false, note: `${oursResting.length} order(s) of ours already rest on ${symbol} — clear them first`, state: prev };
    if (!(health.equity > 0)) return { ok: false, note: "could not read equity", state: prev };

    const state: RtState = { stage: "entering", symbol, startedAt: nowIso(), updatedAt: nowIso(), checks: {}, log: [], savedCfg: cfg0, closeAttempts: 0 };
    state.checks.fifo_netting = check(null, "one position only — not measurable here; the FIFO guard is enforced in code and paged");
    log(state, `preflight ok: equity $${health.equity.toFixed(0)}, pair empty, nothing resting`);
    await save(state);

    const meta = await getPairMeta(symbol).catch(() => null);
    try {
      // Arm the executor for THIS source, THIS symbol, one position, $10 margin — limits first,
      // auto LAST — then run the real entry path twice: validate=true (shape), then for real.
      await setCfg("kraken_margin_live_sources", RT_SOURCE);
      await setCfg("kraken_margin_symbols", symbol);
      await setCfg("kraken_margin_per_trade_usd", String(RT_MARGIN_USD));
      await setCfg("kraken_margin_max_positions", "1");
      await setCfg("kraken_margin_validate_only", "true");
      await setCfg("kraken_margin_auto", "true");

      const v = await executeAlert({ symbol, side: "buy", note: "$20 round trip — validate pass", source: RT_SOURCE });
      const vOk = validatePassOk(v);
      state.checks.validate_accepted = check(vOk, v.note.slice(0, 200));
      log(state, `validate pass: ${v.note.slice(0, 160)}`);
      if (!vOk) {
        state.stage = "failed"; state.error = `validate pass did not reach Kraken cleanly: ${v.note}`; state.finishedAt = nowIso();
        return { ok: false, note: state.error, state };
      }

      await setCfg("kraken_margin_validate_only", "false");
      state.entrySentAt = Math.floor(Date.now() / 1000);
      await save(state);   // persist the send time BEFORE the send: an interrupted route can still recover
      const r = await executeAlert({ symbol, side: "buy", note: "$20 round trip", source: RT_SOURCE });
      if (r.executed && r.txid) {
        state.entryTxid = r.txid;
        state.stage = "open";
        state.checks.entry_accepted = check(true, `txid ${r.txid} — ${r.note.slice(0, 160)}${meta ? ` (lot decimals ${meta.lotDecimals})` : ""}`);
        log(state, `entry sent: ${r.txid}`);
      } else {
        // Not sent — OR sent and lost (the executor's own recovery may have ledgered it).
        // Leave the stage at "entering": the guardian's recovery below adopts a ledgered fill.
        state.checks.entry_accepted = check(false, r.note.slice(0, 200));
        log(state, `entry not confirmed: ${r.note.slice(0, 160)}`);
        if (/refused|skipped|nothing placed|not attempted|cooldown|already today/i.test(r.note)) {
          state.stage = "failed"; state.error = `entry not sent: ${r.note}`; state.finishedAt = nowIso();
        }
      }
    } catch (e) {
      state.error = String(e).slice(0, 300);
      log(state, `error: ${state.error}`);
      // stage stays "entering" → recovery decides whether a fill exists
    } finally {
      state.restoreFailed = await restoreCfg(state.savedCfg);
      if (state.restoreFailed.length) {
        log(state, `⚠️ could not restore ${state.restoreFailed.join(", ")} — the guardian retries every tick`);
        await sendNotification(`🚨 Round trip: could not restore ${state.restoreFailed.join(", ")} after the entry. The guardian retries the restore every 5 min; until then check /margin/paper.`, "margin_urgent").catch(() => {});
      } else {
        log(state, "config restored (executor disarmed again)");
      }
      await save(state);
    }
    if (state.stage === "open") {
      await sendNotification(`🧪 $20 round trip STARTED on ${symbol}: entry ${state.entryTxid} sent. The guardian checks Kraken's behaviour every 5 min and closes it within ~${Math.round(RT_CLOSE_AFTER_MS / 60_000)} min.`, "margin_results").catch(() => {});
      return { ok: true, note: `entry sent (${state.entryTxid})`, state };
    }
    if (state.stage === "entering") {
      await sendNotification(`⚠️ $20 round trip on ${symbol}: the entry's outcome is unconfirmed (${state.error ?? state.checks.entry_accepted?.note ?? "?"}). The guardian checks the ledger and OpenPositions next tick and adopts or fails it.`, "margin_urgent").catch(() => {});
      return { ok: false, note: "entry unconfirmed — recovery next guardian tick", state };
    }
    await sendNotification(`⚠️ $20 round trip did not start: ${state.error}`, "margin_urgent").catch(() => {});
    return { ok: false, note: state.error ?? "not started", state };
  } finally {
    await releaseCloseLock(lock);
  }
}

/** An interrupted/unconfirmed start: was the entry actually accepted? Look at the ownership
 *  ledger (the executor's own recovery writes it even on a lost response) and at OpenPositions. */
async function recoverEntering(state: RtState): Promise<void> {
  const pair = krakenPair(state.symbol);
  const startedMs = new Date(state.startedAt).getTime();
  let found: { txid: string; ts: number } | null = null;
  try {
    const raw = (await prisma.agentConfig.findUnique({ where: { key: "kraken_margin_bot_txids" } }))?.value;
    const ledger = raw ? (JSON.parse(raw) as LedgerEntry[]) : [];
    const mine = ledger.filter((e) => e && pairBase(e.pair) === pairBase(pair) && e.ts >= startedMs - 5_000).sort((a, b) => a.ts - b.ts);
    if (mine.length) found = { txid: mine[0].txid, ts: mine[0].ts };
  } catch { /* fall through to OpenPositions */ }
  if (!found) {
    try {
      const [positions, health] = await Promise.all([getKrakenMarginPositions(), getKrakenMarginHealth().catch(() => null)]);
      if (!failClosedOnEmptyPositions(positions.length, health?.marginUsedRaw ?? null)) {
        const p = positions.find((q) => pairBase(q.pair) === pairBase(pair) && new Date(q.openedAt).getTime() >= startedMs - 5_000);
        if (p) found = { txid: p.ordertxid, ts: new Date(p.openedAt).getTime() };
      } else { log(state, "recovery: positions read unreliable — retry next tick"); return; }
    } catch (e) { log(state, `recovery read failed: ${String(e).slice(0, 80)}`); return; }
  }
  if (found) {
    state.entryTxid = found.txid;
    state.entrySentAt = state.entrySentAt ?? Math.floor(found.ts / 1000);
    state.stage = "open";
    state.checks.entry_accepted = check(true, `recovered after an interrupted start: ${found.txid}`);
    log(state, `recovered entry ${found.txid} — continuing as OPEN`);
    await sendNotification(`🧪 Round trip on ${state.symbol}: the interrupted entry WAS accepted (${found.txid}) — adopted, will be closed on schedule.`, "margin_results").catch(() => {});
  } else if (Date.now() - startedMs > 5 * 60_000) {
    state.stage = "failed"; state.error = state.error ?? "start did not complete and no fill was found in the ledger or OpenPositions"; state.finishedAt = nowIso();
    log(state, "recovery: nothing found after 5 min — failed");
    await sendNotification(`⚠️ Round trip on ${state.symbol} failed to start (${state.error}). Nothing is open.`, "margin_urgent").catch(() => {});
  }
}

/** One tick: run whatever checks the stage allows, close when it is time, finish. Safe to call
 *  every 5 minutes from the guardian and on demand from the admin page. */
export async function advanceRoundTrip(): Promise<RtState | null> {
  const state = await readRoundTrip();
  if (!state) return null;
  // Any restore debt is paid first, every tick, until clean — a crash between arming and
  // restore, or a DB hiccup during restore, must never leave the executor armed.
  if (state.savedCfg && state.stage !== "entering") {
    const cur = await readCfg(CFG_KEYS).catch(() => null);
    const debt = new Set(state.restoreFailed ?? []);
    if (cur) for (const k of CFG_KEYS) if ((cur[k] ?? null) !== (state.savedCfg[k] ?? null) && (k === "kraken_margin_auto" || k === "kraken_margin_validate_only" || cur.kraken_margin_live_sources === RT_SOURCE || debt.size)) debt.add(k);
    if (debt.size) {
      const failed = await restoreCfg(state.savedCfg, [...debt]);
      state.restoreFailed = failed;
      log(state, failed.length ? `restore retry failed: ${failed.join(", ")}` : `restored ${[...debt].join(", ")}`);
      await save(state);
    }
  }
  if (state.stage === "entering") {
    if (Date.now() - new Date(state.startedAt).getTime() > 90_000) {   // the start route is dead by now
      state.restoreFailed = await restoreCfg(state.savedCfg);
      await recoverEntering(state);
      await save(state);
    }
    return state;
  }
  if (state.stage !== "open" && state.stage !== "closing") return state;

  const pair = krakenPair(state.symbol);
  const nowSec = Date.now() / 1000;
  try {
    if (state.stage === "open" && state.entryTxid && state.entrySentAt) {
      const [positions, orders, health] = await Promise.all([getKrakenMarginPositions(), krakenOpenOrders(), getKrakenMarginHealth().catch(() => null)]);
      const closed = await krakenClosedOrders(MARGIN_USERREF, state.entrySentAt - 2).catch(() => null);
      const { checks, position } = evaluateOpenChecks({ entryTxid: state.entryTxid, pair, sentAtSec: state.entrySentAt, nowSec, positions, orders, marginUsedRaw: health?.marginUsedRaw ?? null, closed });
      for (const [k, v] of Object.entries(checks)) if (!state.checks[k] || state.checks[k].ok !== true) state.checks[k] = v;
      if (position) { state.positionId = position.id; state.fillVol = position.vol; }

      // 7. reduce_only stop-loss accepted: far from the market, cancelled immediately.
      if (position && !state.checks.reduce_only_stop_accepted) {
        try {
          const meta = await getPairMeta(state.symbol);
          const tick = await krakenPublic("Ticker", { pair }).catch(() => null);
          const px = tick ? parseFloat(((Object.values(tick)[0] as { c?: string[] })?.c?.[0]) ?? "0") : 0;
          const far = px > 0 ? (px * 0.7).toFixed(meta.priceDecimals) : null;
          if (far) {
            const res = await krakenPrivate("AddOrder", { pair, type: "sell", ordertype: "stop-loss", price: far, volume: position.vol.toFixed(meta.lotDecimals), leverage: "2", reduce_only: "true", userref: String(MARGIN_USERREF) });
            const txid = (res.txid as string[] | undefined)?.[0];
            if (txid) {
              try { await krakenCancelOrder(txid); state.checks.reduce_only_stop_accepted = check(true, `accepted (${txid}) at $${far}, cancelled`); }
              catch (e) { state.checks.reduce_only_stop_accepted = check(true, `accepted (${txid}) at $${far}; cancel FAILED (${String(e).slice(0, 60)}) — the guardian's reconciler removes the duplicate`); }
            } else state.checks.reduce_only_stop_accepted = check(false, "AddOrder returned no txid");
          }
        } catch (e) { state.checks.reduce_only_stop_accepted = check(false, String(e).slice(0, 160)); }
      }
      // 8. OHLC since.
      if (!state.checks.ohlc_since) {
        try {
          const bars = await getKrakenOHLC(state.symbol, 1, nowSec - 3600);
          state.checks.ohlc_since = check(bars.length > 0 && bars.length <= 720, `${bars.length} bars for the last hour`);
        } catch (e) { state.checks.ohlc_since = check(false, String(e).slice(0, 120)); }
      }
      log(state, `open checks: ${Object.entries(checks).map(([k, v]) => `${k}=${v.ok}`).join(" ")}`);

      const sinceMs = (nowSec - state.entrySentAt) * 1000;
      const readyToClose = sinceMs >= RT_CLOSE_AFTER_MS && (state.checks.attached_stop_visible?.ok != null);
      const overdue = sinceMs >= RT_MAX_OPEN_MS;
      const entryGone = !position && sinceMs > 120_000 && state.checks.position_visible?.ok === true && !failClosedOnEmptyPositions(positions.length, health?.marginUsedRaw ?? null);
      if (readyToClose || overdue || entryGone || state.abortRequested) {
        state.stage = "closing";
        log(state, entryGone ? "position gone before our close (stop fired?) — verifying" : `closing (${Math.round(sinceMs / 60_000)} min open)`);
      }
    }

    if (state.stage === "closing") {
      // Through the executor's real close path (lock, ownership, FIFO guard, sweep). Retried
      // on later ticks while it has not been accepted, up to RT_MAX_CLOSE_ATTEMPTS.
      if (!state.checks.close_accepted?.ok && (state.closeAttempts ?? 0) < RT_MAX_CLOSE_ATTEMPTS) {
        state.closeAttempts = (state.closeAttempts ?? 0) + 1;
        const r = await executeAlert({ symbol: state.symbol, side: "close", note: `$20 round trip close (attempt ${state.closeAttempts})`, source: RT_SOURCE });
        const accepted = r.executed || /nothing sent|no open position/.test(r.note);
        state.checks.close_accepted = check(accepted, `attempt ${state.closeAttempts}: ${r.note.slice(0, 180)}`);
        if (r.txid) state.closeTxid = r.txid;
        log(state, `close attempt ${state.closeAttempts}: ${r.note.slice(0, 160)}`);
        if (!accepted && state.closeAttempts >= RT_MAX_CLOSE_ATTEMPTS) {
          await sendNotification(`🚨 Round trip on ${state.symbol}: the close was not accepted after ${state.closeAttempts} attempts (${r.note.slice(0, 120)}). The position stays under the guardian (48h time stop) — close it by hand on Kraken if you want it flat now.`, "margin_urgent").catch(() => {});
        }
      }
      const [positions, orders, health] = await Promise.all([getKrakenMarginPositions(), krakenOpenOrders(), getKrakenMarginHealth().catch(() => null)]);
      Object.assign(state.checks, evaluateCloseChecks({ entryTxid: state.entryTxid ?? "", pair, positions, orders, marginUsedRaw: health?.marginUsedRaw ?? null }));
      if (state.checks.position_gone.ok) {
        // 10. fees from the trade history (synced by the guardian). Entry = our order txid;
        // exit = the close order's txid when we have it, else the closing fills on the pair
        // (by pair base, after the send, position-closing only) capped at the filled volume.
        try {
          const rows = await prisma.$queryRawUnsafe<{ ordertxid: string; pair: string; fee: number; cost: number; vol: number; type: string; posstatus: string; margin: number }[]>(
            `SELECT ordertxid, pair, fee, cost, vol, type, posstatus, margin FROM kraken_my_trades WHERE time >= to_timestamp($1) ORDER BY time`,
            (state.entrySentAt ?? 0) - 5,
          );
          const entryRows = rows.filter((r) => r.ordertxid === state.entryTxid);
          const exitRows = state.closeTxid ? rows.filter((r) => r.ordertxid === state.closeTxid) : [];
          if (!exitRows.length) {
            const want = state.fillVol ?? entryRows.reduce((s, r) => s + (r.vol ?? 0), 0);
            let acc = 0;
            for (const r of rows) {
              if (r.ordertxid === state.entryTxid || r.type !== "sell" || pairBase(r.pair) !== pairBase(pair)) continue;
              if (!(r.posstatus && r.posstatus.length) && !(r.margin > 0)) continue;
              if (acc >= want * 0.999) break;
              exitRows.push(r); acc += r.vol ?? 0;
            }
          }
          const sum = (a: typeof rows, f: (r: (typeof rows)[number]) => number) => a.reduce((s, r) => s + (f(r) ?? 0), 0);
          const have = entryRows.length > 0 && exitRows.length > 0;
          const entryFee = sum(entryRows, (r) => r.fee), exitFee = sum(exitRows, (r) => r.fee);
          state.fees = { entry: entryFee, exit: exitFee, net: have ? sum(exitRows, (r) => r.cost) - sum(entryRows, (r) => r.cost) - entryFee - exitFee : null };
          state.checks.fees_read_back = check(have ? true : null, have ? `entry fee $${entryFee.toFixed(4)}, exit fee $${exitFee.toFixed(4)}, net $${(state.fees.net ?? 0).toFixed(4)}` : "trade history not synced yet — next tick");
        } catch (e) { state.checks.fees_read_back = check(null, `history read failed: ${String(e).slice(0, 80)}`); }
        if (state.checks.fees_read_back?.ok || Date.now() - new Date(state.startedAt).getTime() > RT_MAX_OPEN_MS + 10 * 60_000) {
          if (!state.checks.fees_read_back?.ok) state.checks.fees_read_back = check(false, "fees not found in the trade history after 10 min — run the trade sync and read them by hand");
          state.stage = state.abortRequested ? "aborted" : "done"; state.finishedAt = nowIso();
          const v = roundTripVerdict(state.checks);
          log(state, `${state.stage} — ${v.allOk ? "ALL CHECKS PASSED" : `failed: ${v.failed.join(", ") || "incomplete"}`}`);
          await sendNotification(`🧪 $20 round trip on ${state.symbol} ${state.stage}: ${v.allOk ? "✅ every measured Kraken behaviour matched the code's assumptions" : `❌ failed: ${v.failed.join(", ") || "(incomplete)"}`}. Net after fees: ${state.fees?.net != null ? `$${state.fees.net.toFixed(2)}` : "?"}. Details on /margin/paper.`, v.allOk ? "margin_results" : "margin_urgent").catch(() => {});
        }
      } else if (state.checks.position_gone.ok === false && Date.now() - new Date(state.startedAt).getTime() > RT_MAX_OPEN_MS + 30 * 60_000) {
        // Still open half an hour past the deadline: stop ticking here — the guardian owns the
        // position (managed stop + 48h time stop). Say so, loudly, once.
        state.stage = "failed"; state.error = "position still open 30 min after the close attempts — the guardian manages it (48h time stop); close by hand if needed"; state.finishedAt = nowIso();
        await sendNotification(`🚨 Round trip: ${state.symbol} position still open after the close attempts. It is ledgered and under the guardian; close it by hand if you want it flat now.`, "margin_urgent").catch(() => {});
      }
    }
  } catch (e) {
    log(state, `tick error: ${String(e).slice(0, 160)}`);
  }
  await save(state);
  return state;
}

/** Abort: restore config, then close through the executor and keep ticking until the position
 *  is provably gone — "aborted" is a verified state, never a declared one. */
export async function abortRoundTrip(): Promise<RtState | null> {
  const state = await readRoundTrip();
  if (!state) return null;
  state.restoreFailed = await restoreCfg(state.savedCfg);
  if (state.stage === "entering") { await recoverEntering(state); }
  if (state.stage === "open" || state.stage === "closing") {
    state.abortRequested = true;
    state.stage = "closing";
    log(state, "abort requested — closing through the executor");
    await save(state);
    return advanceRoundTrip();
  }
  if (state.stage === "entering") { state.abortRequested = true; log(state, "abort requested while the entry is unconfirmed — recovery decides next tick"); }
  await save(state);
  return state;
}
