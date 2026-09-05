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
// margin cap (= $20 notional at 2×), for the seconds the entry takes, and every touched
// config key is restored in `finally`. Kraken's FIFO netting cannot be exercised with one
// position; that check is documented, not measured.
import { prisma } from "@/lib/db";
import { sendNotification } from "@/lib/notifications";
import { krakenConfigured, krakenOpenOrders, krakenPrivate, krakenPublic, krakenCancelOrder, krakenClosedOrders, getPairMeta, krakenPair, type OpenOrder } from "@/lib/kraken";
import { getKrakenMarginPositions, getKrakenMarginHealth, getKrakenOHLC, type KrakenMarginPosition } from "@/lib/kraken-margin";
import { pairBase, isUsMarginSymbol } from "@/lib/kraken-pairs";
import { MARGIN_USERREF, executeAlert } from "@/lib/margin-executor";

export const RT_KEY = "kraken_margin_round_trip";
export const RT_SOURCE = "roundtrip";
export const RT_MARGIN_USD = 10;          // margin per entry → $20 notional at the 2× rung
export const RT_MAX_OPEN_MS = 15 * 60_000; // close no later than this after the entry
export const RT_CLOSE_AFTER_MS = 7 * 60_000; // close once the 6-min close[] window has passed

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
  positionId?: string;
  fillVol?: number;
  checks: Record<string, RtCheck>;
  log: string[];
  savedCfg?: Record<string, string | null>;
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

const CFG_KEYS = ["kraken_margin_live_sources", "kraken_margin_auto", "kraken_margin_validate_only", "kraken_margin_per_trade_usd", "kraken_margin_max_positions", "kraken_margin_symbols"] as const;

const nowIso = () => new Date().toISOString();
const check = (ok: boolean | null, note: string): RtCheck => ({ ok, note, at: nowIso() });

export async function readRoundTrip(): Promise<RtState | null> {
  const row = await prisma.agentConfig.findUnique({ where: { key: RT_KEY } }).catch(() => null);
  if (!row?.value) return null;
  try { return JSON.parse(row.value) as RtState; } catch { return null; }
}
async function save(state: RtState): Promise<void> {
  state.updatedAt = nowIso();
  state.log = state.log.slice(-60);
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
/** Put every touched key back exactly as it was (unset stays unset). Never throws. */
export async function restoreCfg(saved: Record<string, string | null> | undefined): Promise<string[]> {
  const failed: string[] = [];
  if (!saved) return failed;
  for (const k of CFG_KEYS) {
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
 *  answer is KNOWN; a still-pending attached stop is left null until the 6-min window ends. */
export function evaluateOpenChecks(s: OpenSnapshot): { checks: Record<string, RtCheck>; position: OpenSnapshot["positions"][number] | null } {
  const c: Record<string, RtCheck> = {};
  const pos = s.positions.find((p) => p.ordertxid === s.entryTxid && pairBase(p.pair) === pairBase(s.pair)) ?? null;
  const secs = Math.max(0, Math.round(s.nowSec - s.sentAtSec));
  if (pos) c.position_visible = check(true, `visible ${secs}s after send: id ${pos.id}, vol ${pos.vol}`);
  else if (secs > 120) c.position_visible = check(false, `not in OpenPositions ${secs}s after send`);

  const stops = s.orders.filter((o) => o.userref === MARGIN_USERREF && o.ordertype === "stop-loss" && o.side === "sell" && pairBase(o.pair) === pairBase(s.pair));
  if (stops.length) {
    const st = stops[0];
    c.attached_stop_visible = check(true, `${stops.length} stop(s) visible ${secs}s after send (txid ${st.txid})`);
    c.stop_trigger_readable = check(st.price > 0, st.price > 0 ? `trigger $${st.price}` : "descr.price missing/zero — the guardian would skip this book");
    if (pos) {
      const eq = Math.abs(st.vol - pos.vol) <= Math.max(pos.vol * 0.01, 1e-8);
      c.stop_vol_equals_fill = check(eq, `stop vol ${st.vol} vs position vol ${pos.vol}`);
    }
  } else if (secs > 6 * 60) {
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

export interface CloseSnapshot { entryTxid: string; pair: string; positions: Pick<KrakenMarginPosition, "id" | "ordertxid" | "pair">[]; orders: OpenOrder[] }
export function evaluateCloseChecks(s: CloseSnapshot): Record<string, RtCheck> {
  const c: Record<string, RtCheck> = {};
  const still = s.positions.some((p) => p.ordertxid === s.entryTxid && pairBase(p.pair) === pairBase(s.pair));
  c.position_gone = check(!still, still ? "position STILL listed right after the close" : "position gone on the first read after the close");
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

// ---- The state machine ---------------------------------------------------------------------

export async function startRoundTrip(symbol = "BTC/USD"): Promise<{ ok: boolean; note: string; state: RtState | null }> {
  if (!krakenConfigured()) return { ok: false, note: "Kraken not configured", state: null };
  symbol = symbol.toUpperCase();
  if (!isUsMarginSymbol(symbol)) return { ok: false, note: `${symbol} is not a US-margin pair`, state: null };
  const prev = await readRoundTrip();
  if (prev && ["entering", "open", "closing"].includes(prev.stage)) return { ok: false, note: `a round trip is already ${prev.stage}`, state: prev };

  const cfg0 = await readCfg(CFG_KEYS);
  if (cfg0.kraken_margin_auto === "true") return { ok: false, note: "the executor is ARMED (kraken_margin_auto=true) — the round trip is for the disarmed phase only", state: prev };

  // Preflight on the account: nothing on the pair from anyone (FIFO), nothing of ours resting.
  const pair = krakenPair(symbol);
  const [positions, orders, health] = await Promise.all([getKrakenMarginPositions(), krakenOpenOrders(), getKrakenMarginHealth()]);
  const onPair = positions.filter((p) => pairBase(p.pair) === pairBase(pair));
  if (onPair.length) return { ok: false, note: `${onPair.length} position(s) already open on ${symbol} — a round trip needs an empty pair (Kraken nets FIFO)`, state: prev };
  const oursResting = orders.filter((o) => o.userref === MARGIN_USERREF && pairBase(o.pair) === pairBase(pair));
  if (oursResting.length) return { ok: false, note: `${oursResting.length} order(s) of ours already rest on ${symbol} — clear them first`, state: prev };
  if (!(health.equity > 0)) return { ok: false, note: "could not read equity", state: prev };

  const state: RtState = { stage: "entering", symbol, startedAt: nowIso(), updatedAt: nowIso(), checks: {}, log: [], savedCfg: cfg0 };
  state.checks.fifo_netting = check(null, "one position only — not measurable here; the FIFO guard is enforced in code and paged");
  log(state, `preflight ok: equity $${health.equity.toFixed(0)}, pair empty, nothing resting`);
  await save(state);

  const meta = await getPairMeta(symbol).catch(() => null);
  try {
    // Arm the executor for THIS source, THIS symbol, one position, $10 margin — then run the
    // real entry path twice: once as validate=true (shape), once for real.
    await setCfg("kraken_margin_live_sources", RT_SOURCE);
    await setCfg("kraken_margin_symbols", symbol);
    await setCfg("kraken_margin_per_trade_usd", String(RT_MARGIN_USD));
    await setCfg("kraken_margin_max_positions", "1");
    await setCfg("kraken_margin_validate_only", "true");
    await setCfg("kraken_margin_auto", "true");

    const v = await executeAlert({ symbol, side: "buy", note: "$20 round trip — validate pass", source: RT_SOURCE });
    state.checks.validate_accepted = check(v.validated && !v.executed, v.note.slice(0, 200));
    log(state, `validate pass: ${v.note.slice(0, 160)}`);
    if (!v.validated) {
      state.stage = "failed"; state.error = `validate pass refused: ${v.note}`; state.finishedAt = nowIso();
      return { ok: false, note: state.error, state };
    }

    await setCfg("kraken_margin_validate_only", "false");
    const sentAt = Math.floor(Date.now() / 1000);
    const r = await executeAlert({ symbol, side: "buy", note: "$20 round trip", source: RT_SOURCE });
    state.entrySentAt = sentAt;
    if (r.executed && r.txid) {
      state.entryTxid = r.txid;
      state.stage = "open";
      state.checks.entry_accepted = check(true, `txid ${r.txid} — ${r.note.slice(0, 160)}${meta ? ` (lot decimals ${meta.lotDecimals})` : ""}`);
      log(state, `entry sent: ${r.txid}`);
    } else {
      state.stage = "failed"; state.error = `entry not sent: ${r.note}`; state.finishedAt = nowIso();
      state.checks.entry_accepted = check(false, r.note.slice(0, 200));
      log(state, `entry refused: ${r.note.slice(0, 160)}`);
    }
  } catch (e) {
    state.stage = "failed"; state.error = String(e).slice(0, 300); state.finishedAt = nowIso();
    log(state, `error: ${state.error}`);
  } finally {
    const failed = await restoreCfg(state.savedCfg);
    if (failed.length) {
      log(state, `⚠️ could not restore ${failed.join(", ")} — the guardian retries`);
      await sendNotification(`🚨 Round trip: could not restore ${failed.join(", ")} after the entry. The executor may still be armed for source "${RT_SOURCE}" only (one symbol, $10 margin, 1 position). Guardian retries the restore.`, "margin_urgent").catch(() => {});
    } else {
      log(state, "config restored (executor disarmed again)");
    }
    await save(state);
  }
  if (state.stage === "open") {
    await sendNotification(`🧪 $20 round trip STARTED on ${symbol}: entry ${state.entryTxid} sent. The guardian checks Kraken's behaviour every 5 min and closes it within ~${Math.round(RT_CLOSE_AFTER_MS / 60_000)} min.`, "margin_results").catch(() => {});
    return { ok: true, note: `entry sent (${state.entryTxid})`, state };
  }
  await sendNotification(`⚠️ $20 round trip did not start: ${state.error}`, "margin_urgent").catch(() => {});
  return { ok: false, note: state.error ?? "not started", state };
}

/** One tick: run whatever checks the stage allows, close when it is time, finish. Safe to call
 *  every 5 minutes from the guardian and on demand from the admin page. */
export async function advanceRoundTrip(): Promise<RtState | null> {
  const state = await readRoundTrip();
  if (!state) return null;
  // A crash between arming and restore leaves the executor armed for "roundtrip" only; put it back.
  if (state.stage !== "entering" && state.savedCfg) {
    const cur = await readCfg(["kraken_margin_live_sources"]);
    if (cur.kraken_margin_live_sources === RT_SOURCE) {
      const failed = await restoreCfg(state.savedCfg);
      log(state, failed.length ? `restore retry failed: ${failed.join(", ")}` : "restored leftover round-trip arming");
      await save(state);
    }
  }
  if (state.stage === "entering") {
    // The start call died mid-way (route killed). Nothing to do but restore and mark it.
    if (Date.now() - new Date(state.startedAt).getTime() > 5 * 60_000) {
      await restoreCfg(state.savedCfg);
      state.stage = "failed"; state.error = "start did not complete (route interrupted) — check Kraken for a stray position and adopt/close it"; state.finishedAt = nowIso();
      await save(state);
      await sendNotification(`🚨 Round trip: the start was interrupted. Check Kraken for a position on ${state.symbol} with no ledger entry.`, "margin_urgent").catch(() => {});
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
            if (txid) { await krakenCancelOrder(txid); state.checks.reduce_only_stop_accepted = check(true, `accepted (${txid}) at $${far}, cancelled`); }
            else state.checks.reduce_only_stop_accepted = check(false, "AddOrder returned no txid");
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
      const entryGone = !position && sinceMs > 120_000 && state.checks.position_visible?.ok === true;   // it filled earlier and is gone now
      if (readyToClose || overdue || entryGone) {
        state.stage = "closing";
        log(state, entryGone ? "position gone before our close (stop fired?) — verifying" : `closing (${Math.round(sinceMs / 60_000)} min open)`);
      }
    }

    if (state.stage === "closing") {
      // Through the executor's real close path (lock, ownership, FIFO guard, sweep).
      if (!state.closeTxid && !state.checks.close_accepted) {
        const r = await executeAlert({ symbol: state.symbol, side: "close", note: "$20 round trip close", source: RT_SOURCE });
        state.checks.close_accepted = check(r.executed || /nothing sent|no open position/.test(r.note), r.note.slice(0, 200));
        state.closeTxid = r.txid;
        log(state, `close: ${r.note.slice(0, 160)}`);
      }
      const [positions, orders] = await Promise.all([getKrakenMarginPositions(), krakenOpenOrders()]);
      Object.assign(state.checks, evaluateCloseChecks({ entryTxid: state.entryTxid ?? "", pair, positions, orders }));
      if (state.checks.position_gone.ok) {
        // 10. fees from the trade history (synced by the guardian; read directly here).
        try {
          const rows = await prisma.$queryRawUnsafe<{ ordertxid: string; fee: number; cost: number; type: string; price: number }[]>(
            `SELECT ordertxid, fee, cost, type, price FROM kraken_my_trades WHERE ordertxid = $1 OR (pair = $2 AND time >= to_timestamp($3) AND type='sell') ORDER BY time`,
            state.entryTxid ?? "", pair, state.entrySentAt ?? 0,
          );
          const entryFee = rows.filter((r) => r.ordertxid === state.entryTxid).reduce((s, r) => s + (r.fee ?? 0), 0);
          const exitRows = rows.filter((r) => r.ordertxid !== state.entryTxid);
          const exitFee = exitRows.reduce((s, r) => s + (r.fee ?? 0), 0);
          const entryCost = rows.filter((r) => r.ordertxid === state.entryTxid).reduce((s, r) => s + (r.cost ?? 0), 0);
          const exitCost = exitRows.reduce((s, r) => s + (r.cost ?? 0), 0);
          const have = rows.some((r) => r.ordertxid === state.entryTxid) && exitRows.length > 0;
          state.fees = { entry: entryFee, exit: exitFee, net: have ? exitCost - entryCost - entryFee - exitFee : null };
          state.checks.fees_read_back = check(have ? true : null, have ? `entry fee $${entryFee.toFixed(4)}, exit fee $${exitFee.toFixed(4)}, net $${(state.fees.net ?? 0).toFixed(4)}` : "trade history not synced yet — next tick");
        } catch (e) { state.checks.fees_read_back = check(null, `history read failed: ${String(e).slice(0, 80)}`); }
        if (state.checks.fees_read_back?.ok || Date.now() - new Date(state.startedAt).getTime() > RT_MAX_OPEN_MS + 10 * 60_000) {
          if (!state.checks.fees_read_back?.ok) state.checks.fees_read_back = check(false, "fees not found in the trade history after 10 min — run the trade sync and read them by hand");
          state.stage = "done"; state.finishedAt = nowIso();
          const v = roundTripVerdict(state.checks);
          log(state, `done — ${v.allOk ? "ALL CHECKS PASSED" : `failed: ${v.failed.join(", ") || "incomplete"}`}`);
          await sendNotification(`🧪 $20 round trip on ${state.symbol} finished: ${v.allOk ? "✅ every measured Kraken behaviour matched the code's assumptions" : `❌ failed: ${v.failed.join(", ") || "(incomplete)"}`}. Net after fees: ${state.fees?.net != null ? `$${state.fees.net.toFixed(2)}` : "?"}. Details on /margin/paper.`, v.allOk ? "margin_results" : "margin_urgent").catch(() => {});
        }
      } else if (Date.now() - new Date(state.startedAt).getTime() > RT_MAX_OPEN_MS + 10 * 60_000) {
        state.stage = "failed"; state.error = "position still open 10 min after the close attempt — the guardian manages it (48h time stop); close by hand if needed"; state.finishedAt = nowIso();
        await sendNotification(`🚨 Round trip: ${state.symbol} position still open after the close attempt. Check Kraken.`, "margin_urgent").catch(() => {});
      }
    }
  } catch (e) {
    log(state, `tick error: ${String(e).slice(0, 160)}`);
  }
  await save(state);
  return state;
}

/** Abort: close through the executor if open, restore config, mark aborted. */
export async function abortRoundTrip(): Promise<RtState | null> {
  const state = await readRoundTrip();
  if (!state) return null;
  await restoreCfg(state.savedCfg);
  if (state.stage === "open" || state.stage === "closing") {
    try {
      const r = await executeAlert({ symbol: state.symbol, side: "close", note: "$20 round trip ABORT", source: RT_SOURCE });
      log(state, `abort close: ${r.note.slice(0, 160)}`);
    } catch (e) { log(state, `abort close error: ${String(e).slice(0, 120)}`); }
  }
  if (state.stage !== "done") { state.stage = "aborted"; state.finishedAt = nowIso(); }
  await save(state);
  return state;
}
