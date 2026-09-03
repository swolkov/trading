// TradingView-alert → Kraken margin order executor.
//
// CLOSES ARE NEVER GATED. The close path runs FIRST — above the arm switch, above
// validate-only, above every risk layer — because a close only reduces risk. This was
// once false: `kraken_margin_auto=false` returned before the close block, so the
// operator's instinctive reaction to trouble ("turn the bot off") also disabled the only
// command that flattens the position it left behind. Closes are also scoped to positions
// THIS BOT OPENED (see the ownership ledger below); Kraken margin positions carry no
// userref, so an unfiltered close would market-flatten Spencer's own hand-opened book.
//
// SAFETY MODEL (every layer must be crossed before real money moves — ENTRIES only):
//   1. kraken_margin_auto         — default OFF: alerts are logged + scored, never traded.
//   2. kraken_margin_validate_only — default ON: even when armed, orders go out with
//      validate=true (Kraken checks but does not execute) until this is explicitly "false".
//   3. kraken_margin_max_leverage — hard cap (default 2). Values below Kraken's margin
//      minimum of 2 REFUSE entries rather than silently rounding up.
//   4. kraken_margin_per_trade_usd — margin committed per entry (default $100).
//   5. kraken_margin_daily_loss_cap — today's margin loss beyond this blocks NEW ENTRIES
//      (default $200). It never blocks a close — a kill switch must not stop a
//      flattening order.
//   6. Anti-stacking: an entry is refused when ANY position exists on that pair — either
//      direction — and when kraken_margin_max_positions (default 3) are already open.
//      Either direction matters because Kraken spot margin NETS FIFO: an opposing order
//      does not open a second position, it reduces the existing one, which on a manual
//      position means closing part of Spencer's book. ⚠️ kraken_margin_allow_stacking
//      ="true" disables this, and therefore disables the manual-book boundary too.
//   7. Every entry carries an attached stop-loss (conditional close) at half the
//      liquidation cushion — and the guardian's naked-position guard (margin-watch step
//      3c) VERIFIES that every bot position actually has one, placing it and paging if
//      not. The attachment alone was never enough: a partially-filled post-only entry, or
//      a close[] rejected at fill time, leaves a live levered position running to
//      liquidation. Nothing checked the position→stop direction until that guard existed.
//   8. RISK GOVERNOR — the structural fix for the fee-bleed that cost the real money:
//      • kraken_margin_max_trades_per_day (default 6) — hard cap on entries/day.
//      • kraken_margin_cooldown_min (default 30) — minimum minutes between entries, so
//        a once-per-bar alert can't churn 280 trades/month.
//      • kraken_margin_live_max_risk_pct (default 0.5, hard ceiling 2.0) — SIZE is capped
//        so the stop-loss can never lose more than this % of equity; notional shrinks
//        automatically. NOTE the `live_` in the name: this is deliberately NOT the paper
//        experiment's kraken_margin_max_risk_pct (3%, ×2 on conviction), so arming can
//        never silently inherit a research setting. Observed paper losing streak is 13 in
//        a row: 0.5% costs 6% of the account, 3% costs 33%, 6% costs 55%.
//      • kraken_margin_disarmed_dd — account drawdown circuit breaker (set by the
//        guardian); while true, NO new entries (closes still allowed).
//   9. MAKER ENTRIES — kraken_margin_maker_entries (default true) rests a post-only
//      limit so entries pay the maker fee, not taker (taker was 96% of the real loss).
//      Post-only means Kraken rejects rather than crosses, so we never pay taker; an
//      unfilled entry is swept by the guardian.
// One order per invocation, tagged with its own userref. Fails closed on any read error.
// Close orders are reduce_only so a stale read can never flip us into an opposite position.
import { prisma } from "@/lib/db";
import { sendNotification } from "@/lib/notifications";
import { krakenPrivate, krakenPair, getKrakenPrice, getPairMeta, krakenTouch, krakenOpenOrders, krakenCancelOrder } from "@/lib/kraken";
import { pairMatchesSymbol, pairBase } from "@/lib/kraken-pairs";
import { getKrakenMarginPositions, getKrakenMarginHealth, listRoundTrips } from "@/lib/kraken-margin";

// Distinct from the trend bot's 770077 so each system's orders are separable forever.
export const MARGIN_USERREF = 770078;

export interface AlertOrder {
  symbol: string;              // "BTC/USD" style
  side: "buy" | "sell" | "close";
  leverage?: number;
  note?: string;
}

export interface ExecResult {
  executed: boolean;
  validated: boolean;          // true = validate-only round (no money moved)
  note: string;
  txid?: string;
}

async function cfg(key: string): Promise<string | null> {
  const row = await prisma.agentConfig.findUnique({ where: { key } }).catch(() => null);
  return row?.value ?? null;
}

// Same read, but a DB failure THROWS instead of reading as "unset". Use this for any flag
// whose safe state is "stop" — cfg() collapses "read failed" and "not configured" into
// null, which for a kill switch means a transient query error reads as "not disarmed".
async function cfgStrict(key: string): Promise<string | null> {
  const row = await prisma.agentConfig.findUnique({ where: { key } });
  return row?.value ?? null;
}

// OWNERSHIP LEDGER — which margin positions belong to this bot.
// Kraken margin positions carry NO userref, so OpenPositions cannot tell our position from
// one Spencer opened by hand. Without this, a `close` alert would market-flatten his own
// discretionary book on the same pair. We therefore record the txid of every entry we place;
// a position's key in OpenPositions is its opening order's txid, so that is the join.
const BOT_TXIDS_KEY = "kraken_margin_bot_txids";
// Prune generously. A pruned entry does not merely mean "closes skip this position" — the
// close path's stop sweep would still match its stop by userref and cancel it, while 3c no
// longer recognises the position to re-protect it. Forgetting an entry therefore STRIPS a
// live position's stop. Rollover economics make a 30-day margin hold implausible, but the
// cost of being wrong is unbounded and the cost of a longer window is a few hundred bytes.
const BOT_TXID_TTL_MS = 180 * 24 * 3600_000;
const BOT_TXID_MAX = 2000;

async function recordBotEntry(txid: string, pair: string): Promise<void> {
  try {
    const raw = await cfg(BOT_TXIDS_KEY);
    const cutoff = Date.now() - BOT_TXID_TTL_MS;
    const prev: { txid: string; pair: string; ts: number }[] = raw ? JSON.parse(raw) : [];
    const next = prev.filter((e) => e && e.ts > cutoff && e.txid !== txid);
    next.push({ txid, pair, ts: Date.now() });
    await prisma.agentConfig.upsert({
      where: { key: BOT_TXIDS_KEY },
      update: { value: JSON.stringify(next.slice(-BOT_TXID_MAX)) },
      create: { key: BOT_TXIDS_KEY, value: JSON.stringify(next.slice(-BOT_TXID_MAX)) },
    });
  } catch (e) {
    // NOT best-effort in consequence: an unrecorded position is invisible to BOTH the close
    // path and the guardian's naked-position guard, so it is unclosable by alert AND
    // unprotected. Page immediately with the id needed to adopt it.
    await sendNotification(
      `🚨 Could not record bot position ${txid} on ${pair}. It will NOT be recognised by close alerts or the naked-position guard. Add it to kraken_margin_adopt_txids now. ${String(e).slice(0, 120)}`,
      "margin_urgent",
    ).catch(() => {});
  }
}

export async function botTxids(): Promise<Set<string>> {
  const raw = await cfg(BOT_TXIDS_KEY);
  if (!raw) return new Set();
  try {
    return new Set((JSON.parse(raw) as { txid: string }[]).map((e) => e.txid).filter(Boolean));
  } catch { return new Set(); }
}

// A position is OURS if its OpenPositions key (the opening order's txid) is in the ledger.
// Fails CLOSED by design: an unrecognised position is treated as Spencer's and left alone.
// `kraken_margin_close_all_positions=true` is the deliberate escape hatch for a real
// emergency where the ledger is known to be incomplete.
export async function isBotPosition(positionId: string, ours: Set<string>): Promise<boolean> {
  return ours.has(positionId);
}

// parseFloat(...) || default treats an EXPLICIT "0" as unset — which turned
// "daily_loss_cap=0" into $200. Honor any finite configured number.
async function cfgNum(key: string, fallback: number): Promise<number> {
  const raw = await cfg(key);
  if (raw == null || raw.trim() === "") return fallback;
  const n = parseFloat(raw);
  return Number.isFinite(n) ? n : fallback;
}

// Self-contained per-day counter for the trade-frequency governor. Resets at UTC
// midnight. Only real (executed) entries are counted, so validate-mode testing does not
// burn the daily cap.
const DAY_STATE_KEY = "kraken_margin_day_state";
interface DayState { date: string; entries: number; lastEntryIso: string | null }
async function loadDayState(): Promise<DayState> {
  const today = new Date().toISOString().slice(0, 10);
  const raw = await cfg(DAY_STATE_KEY);
  if (raw) {
    try {
      const s = JSON.parse(raw) as DayState;
      if (s.date === today) return s;
    } catch { /* fall through to fresh */ }
  }
  return { date: today, entries: 0, lastEntryIso: null };
}
async function bumpDayState(prev: DayState): Promise<void> {
  const next: DayState = { date: prev.date, entries: prev.entries + 1, lastEntryIso: new Date().toISOString() };
  const value = JSON.stringify(next);
  await prisma.agentConfig.upsert({
    where: { key: DAY_STATE_KEY },
    update: { value },
    create: { key: DAY_STATE_KEY, value },
  }).catch(() => {});
}

// Execution lock — serializes the ENTRY path so two webhook invocations landing at once
// can't both read the same day-state, both pass the cap, and both place an order. Atomic
// compare-and-swap (ISO strings compare in time order). Fails CLOSED: if it can't be
// acquired, the alert is refused rather than risking a concurrent double-entry.
const EXEC_LOCK_KEY = "kraken_margin_exec_lock";
// ⚠️ THE TTL MUST EXCEED THE ROUTE'S maxDuration, or the invariant inverts. The lock's
// whole job is that a holder is provably dead before its lock can be stolen. The webhook's
// maxDuration is 300s (raised so a slow Kraken run can't be killed mid-AddOrder), so a
// holder can legitimately still be alive at 120s — at which point a second alert steals the
// lock, reads the same day-state, sees no position yet, and both place. Two entries, double
// the intended risk. 330s > 300s restores "expired means dead".
const EXEC_LOCK_TTL_MS = 330_000;
// Each holder writes a unique token, so release can only clear ITS OWN lock. With a plain
// blank-on-release, a holder that overran would wipe the lock a later invocation legitimately
// holds, and the next alert would walk straight in.
function lockToken(): string {
  return `${new Date().toISOString()}#${Math.random().toString(36).slice(2, 10)}`;
}
async function acquireExecLock(): Promise<string | null> {
  await prisma.agentConfig.upsert({
    where: { key: EXEC_LOCK_KEY }, update: {}, create: { key: EXEC_LOCK_KEY, value: "" },
  }).catch(() => {});
  const cutoff = new Date(Date.now() - EXEC_LOCK_TTL_MS).toISOString();
  const token = lockToken();
  const r = await prisma.agentConfig.updateMany({
    where: { key: EXEC_LOCK_KEY, OR: [{ value: "" }, { value: { lt: cutoff } }] },
    data: { value: token },
  }).catch(() => ({ count: 0 }));
  return r.count === 1 ? token : null;
}
async function releaseExecLock(token: string | null): Promise<void> {
  if (!token) return;
  // CAS release: only clears the lock if we still hold it.
  await prisma.agentConfig.updateMany({
    where: { key: EXEC_LOCK_KEY, value: token },
    data: { value: "" },
  }).catch(() => {});
}

export async function executeAlert(alert: AlertOrder): Promise<ExecResult> {
  const pair = krakenPair(alert.symbol);

  // ---- CLOSE PATH ----
  // FIRST, above every other guard — including the arm switch and validate-only. A close
  // only ever REDUCES risk, so nothing may block it. This used to sit below the
  // kraken_margin_auto check, which meant the operator's most natural panic reaction
  // ("turn the bot off") also disabled the one command that flattens the position it
  // left open. Disarming must stop new risk, never trap existing risk.
  if (alert.side === "close") {
    const validateClose = (await cfg("kraken_margin_validate_only")) !== "false";
    try {
      const all = (await getKrakenMarginPositions())
        .filter((p) => pairMatchesSymbol(p.pair, alert.symbol));
      // OWNERSHIP FILTER: only flatten positions this bot opened. Kraken margin positions
      // carry no userref, so without this a close alert market-closes Spencer's own
      // hand-opened position on the same pair — his second book, destroyed by a trade he
      // never authorised. Unknown positions are left alone (fail closed).
      // Join on ordertxid ("O…"), NOT the position key ("T…"). AddOrder returns an ORDER
      // txid; OpenPositions is keyed by the TRADE txid. Verified on the real account:
      // 115 fills, 72 distinct orders, ZERO where the two ids matched. Joining on the
      // wrong one silently matches nothing and turns every close into a no-op — which is
      // more dangerous than the over-closing it was meant to prevent.
      const ours = await botTxids();
      // ONE-SHOT AND PAIR-SCOPED. Sticky, an emergency flag set once would silently flatten
      // Spencer's manual book on every later close for that pair. Global, it would be burned
      // by whichever close alert happened to land first — he sets it to free a stuck ETH
      // position, a routine BTC close consumes it, and ETH is still open while his manual
      // BTC book just got flattened. So the value names the symbol it authorises
      // ("ETH/USD", or "ALL"), and it is consumed ONLY on a matching pair that actually has
      // something to close.
      const closeAllRaw = (await cfg("kraken_margin_close_all_positions")) ?? "";
      const closeAllTarget = closeAllRaw.trim().toUpperCase();
      const closeAll = all.length > 0 && (closeAllTarget === "ALL" || closeAllTarget === alert.symbol.toUpperCase()
        // "true" kept for backward compatibility, but it is pair-scoped like the rest.
        || (closeAllTarget === "TRUE"));
      if (closeAll) {
        const cleared = await prisma.agentConfig.updateMany({
          where: { key: "kraken_margin_close_all_positions", value: closeAllRaw },
          data: { value: "" },
        }).catch(() => ({ count: 0 }));
        if (cleared.count !== 1) {
          await sendNotification(
            `⚠️ Could not clear kraken_margin_close_all_positions after using it on ${pair} — it is STILL ARMED and will flatten manual positions on the next close. Clear it by hand.`,
            "margin_urgent",
          ).catch(() => {});
        }
      }
      const adoptRaw = (await cfg("kraken_margin_adopt_txids")) ?? "";
      const adopted = new Set(adoptRaw.split(",").map((s) => s.trim()).filter(Boolean));
      const isOurs = (p: { ordertxid: string; id: string }) =>
        ours.has(p.ordertxid) || adopted.has(p.ordertxid) || adopted.has(p.id);
      const positions = closeAll ? all : all.filter(isOurs);
      const skipped = all.filter((p) => !closeAll && !isOurs(p));
      // Notifications are deliberately deferred until AFTER the orders are placed:
      // sendNotification's fetch has no timeout, and a hung Slack webhook must never sit
      // between a close alert and the close itself.
      const pending: string[] = [];
      if (!positions.length) {
        const note = skipped.length > 0
          ? `close alert: ${skipped.length} position(s) on ${pair} are NOT the bot's — left untouched. Position ids: ${skipped.map((p) => p.ordertxid || p.id).join(", ")}. To flatten one deliberately, add its id to kraken_margin_adopt_txids (or kraken_margin_close_all_positions=true for all).`
          : "close alert but no open position";
        if (skipped.length > 0) await sendNotification(`⚠️ ${note}`, "margin_urgent");
        return { executed: false, validated: false, note };
      }
      if (skipped.length > 0) {
        pending.push(`⚠️ Close on ${pair}: flattened ${positions.length} bot position(s), LEFT ${skipped.length} manual position(s) alone (ids: ${skipped.map((p) => p.ordertxid || p.id).join(", ")}).`);
      }
      if (closeAll) {
        const notOurs = all.filter((p) => !isOurs(p)).length;
        pending.push(`⚠️ close_all_positions was ON: flattened ALL ${positions.length} position(s) on ${pair}${notOurs ? `, INCLUDING ${notOurs} that were NOT the bot's` : ""}. The flag has been cleared — set it again if you need it.`);
      }
      // A real position gets a REAL close even in validate-only mode: validate exists to
      // stop us opening risk, not to stop us shedding it. Announce it so it is never a
      // surprise. ⚠️ This means a close alert moves real money even in validate mode —
      // test closes are no longer safe.
      if (validateClose) {
        pending.push(`⚠️ validate_only is ON but a REAL position existed on ${pair} — the close was executed for real (a close only reduces risk).`);
      }
      const validate = false;
      // Round close volume to the pair's lot precision — same as the entry path. Hardcoding 8
      // decimals gets a close REJECTED by Kraken on any pair with fewer lot decimals, leaving the
      // risk-reducing close silently un-done (the same class of bug the entry path already guards).
      const closeMeta = await getPairMeta(pair);
      const txids: string[] = [];
      for (const p of positions) {
        const params: Record<string, string> = {
          pair,
          type: p.side === "long" ? "sell" : "buy",
          ordertype: "market",
          volume: p.vol.toFixed(closeMeta.lotDecimals),
          leverage: String(Math.max(2, Math.round(p.leverage))),
          // reduce_only: if the position shrank between our read and this order (manual
          // close, partial liquidation, duplicate alert), Kraken reduces to flat instead
          // of opening an opposite position with the excess volume.
          reduce_only: "true",
          userref: String(MARGIN_USERREF),
        };
        if (validate) params.validate = "true";
        const res = await krakenPrivate("AddOrder", params);
        const txid = (res.txid as string[] | undefined)?.[0];
        if (txid) txids.push(txid);
      }
      // CANCEL THE NOW-STRANDED STOPS IMMEDIATELY. Kraken's attached close[] cannot be
      // reduce_only (the API has no such parameter), so a stop left resting after the
      // position is gone will, if it triggers, open a BRAND NEW leveraged position in the
      // opposite direction — unowned (its ordertxid is the stop's, not in the ledger),
      // therefore invisible to this close path and to the naked-position guard, and with
      // no stop of its own. The guardian's orphan sweep needs two consecutive runs, so it
      // would leave a 5-10 minute window in which an ordinary 1.5% move flips a closed
      // trade into an unmonitored short. Scoped to our userref, so manual orders are safe.
      try {
        const resting = (await krakenOpenOrders()).filter((o) =>
          o.userref === MARGIN_USERREF &&
          o.ordertype.includes("stop") &&
          pairBase(o.pair) === pairBase(pair) &&
          positions.some((p) => (p.side === "long" ? "sell" : "buy") === o.side));
        // Count real successes: a swallowed cancel failure would report "cancelled" while
        // the stop still rests, carrying the exact flip risk this sweep exists to remove.
        const failed: string[] = [];
        let cancelled = 0;
        for (const o of resting) {
          try { await krakenCancelOrder(o.txid); cancelled++; } catch { failed.push(o.txid); }
        }
        if (cancelled) pending.push(`🧹 Cancelled ${cancelled} stranded stop(s) on ${pair} after the close (a resting stop with no position can open a fresh one).`);
        if (failed.length) {
          await sendNotification(
            `🚨 Could NOT cancel ${failed.length} stop(s) on ${pair} after closing (${failed.join(", ")}). A stranded stop can OPEN a new leveraged position if it triggers. Cancel them on Kraken now.`,
            "margin_urgent",
          ).catch(() => {});
        }
      } catch (err) {
        await sendNotification(
          `⚠️ Closed ${pair} but could NOT sweep its resting stops — a stranded stop can open a new position if it triggers. Check Kraken. ${String(err).slice(0, 140)}`,
          "margin_urgent",
        ).catch(() => {});
      }
      for (const msg of pending) await sendNotification(msg, "margin_urgent").catch(() => {});
      return {
        executed: !validate,
        validated: validate,
        txid: txids[0],
        note: `closed ${positions.length} position(s) on ${pair}`,
      };
    } catch (e) {
      // A close that did not close is the most urgent event this system can produce —
      // it means risk is still on and the operator believes it is off. Page, don't log.
      await sendNotification(
        `🚨 CLOSE FAILED on ${pair} — the position may STILL BE OPEN. Check Kraken now. Error: ${String(e).slice(0, 200)}`,
        "margin_urgent",
      ).catch(() => {});
      return { executed: false, validated: false, note: `close failed: ${e}` };
    }
  }

  // ---- ENTRY PATH ----
  // Layer 1: armed at all? (Entries only — the close path above deliberately runs first.)
  const auto = (await cfg("kraken_margin_auto")) === "true";
  if (!auto) return { executed: false, validated: false, note: "tracked only (kraken_margin_auto off)" };

  // Layer 2: validate-only unless explicitly disabled.
  const validate = (await cfg("kraken_margin_validate_only")) !== "false";

  // Layer 8a: account drawdown circuit breaker. The guardian sets this when equity
  // falls too far from its peak; while tripped, no new risk (closes still allowed above).
  // cfgStrict, not cfg: a transient DB error must not read as "not disarmed" and let an
  // entry through the account-level kill switch. Every other flag already fails safe.
  try {
    if ((await cfgStrict("kraken_margin_disarmed_dd")) === "true") {
      return { executed: false, validated: false, note: "entries halted — account drawdown circuit breaker tripped" };
    }
  } catch {
    return { executed: false, validated: false, note: "could not read the drawdown breaker — failing closed" };
  }

  // Serialize entries: without this, two alerts landing together both read the same
  // day-state and both place an order. Fails closed — a lock we can't get = no entry.
  const lockToken_ = await acquireExecLock();
  if (!lockToken_) {
    return { executed: false, validated: false, note: "another entry is in progress — skipped (no concurrent entries)" };
  }
  try {
    // Layer 8b: trade-frequency governor — the structural cure for the fee bleed.
    const dayState = await loadDayState();
    const maxPerDay = Math.max(1, await cfgNum("kraken_margin_max_trades_per_day", 6));
    if (dayState.entries >= maxPerDay) {
      return { executed: false, validated: false, note: `entry refused: ${dayState.entries}/${maxPerDay} trades already today` };
    }
    const cooldownMin = Math.max(0, await cfgNum("kraken_margin_cooldown_min", 30));
    if (dayState.lastEntryIso && Date.now() - new Date(dayState.lastEntryIso).getTime() < cooldownMin * 60_000) {
      const waited = Math.round((Date.now() - new Date(dayState.lastEntryIso).getTime()) / 60_000);
      return { executed: false, validated: false, note: `entry refused: cooldown (${waited}/${cooldownMin} min since last entry)` };
    }

    // Layer 3: leverage. Kraken margin minimum is 2; a cap below that means "no entries".
    const maxLev = await cfgNum("kraken_margin_max_leverage", 2);
    if (maxLev < 2) {
      return { executed: false, validated: false, note: `entries disabled (max leverage ${maxLev} < Kraken minimum 2)` };
    }
    const leverage = Math.min(Math.min(20, maxLev), Math.max(2, alert.leverage ?? 2));
    const perTrade = Math.max(10, await cfgNum("kraken_margin_per_trade_usd", 100));
    const lossCap = Math.max(0, await cfgNum("kraken_margin_daily_loss_cap", 200));

    // Layer 5: daily loss kill switch — realized round trips closed today plus open P&L.
    // Fails closed on ANY read problem, including a stale trade sync.
    const syncedAt = await cfg("margin_trades_synced_at");
    if (!syncedAt || Date.now() - new Date(syncedAt).getTime() > 15 * 60 * 1000) {
      return { executed: false, validated: false, note: "trade sync stale (>15m) — cannot trust loss cap, failing closed" };
    }
    const dayStart = new Date();
    dayStart.setUTCHours(0, 0, 0, 0);
    const trips = await listRoundTrips();
    const realizedToday = trips
      .filter((t) => new Date(t.closedAt) >= dayStart)
      .reduce((s, t) => s + t.netPnl, 0);
    const health = await getKrakenMarginHealth();
    const equity = health.equity;
    // Fail closed if equity reads 0/unreadable — otherwise risk-based sizing below would
    // silently skip its cap and place a full-size order.
    if (!(equity > 0)) {
      return { executed: false, validated: false, note: "equity reads 0/unreadable — failing closed" };
    }
    // The cap trips on EITHER measure, never on their sum. health.unrealized is TradeBalance
    // 'n' — the whole account, including positions Spencer opened by hand. Netting them
    // meant one profitable manual long could mask a bot that had already realised past the
    // cap, and the bot would keep entering. Realized-only is the bot-attributable number;
    // the combined figure is kept as an ADDITIONAL trigger, never as an offset.
    const todayPnl = realizedToday + (health.unrealized || 0);
    if (realizedToday < -lossCap || todayPnl < -lossCap) {
      const which = realizedToday < -lossCap ? `realized $${realizedToday.toFixed(0)}` : `realized+unrealized $${todayPnl.toFixed(0)}`;
      await sendNotification(
        `🛑 Margin auto-trade BLOCKED — today's margin P&L (${which}) is past the $${lossCap} daily loss cap. No new entries until tomorrow (closes still go through).`,
        "kraken",
      );
      return { executed: false, validated: false, note: `daily loss cap hit (${which} < -${lossCap})` };
    }

    // Layer 6: anti-stacking — count BOTH open positions AND our resting orders toward
    // the cap. Counting resting orders means an entry whose HTTP response timed out (but
    // that Kraken accepted) still counts on the next alert, so a timeout can't sneak a
    // second position past the limit.
    const openPositions = await getKrakenMarginPositions();
    const ourOrders = (await krakenOpenOrders()).filter((o) => o.userref === MARGIN_USERREF);
    const ourEntryOrders = ourOrders.filter((o) => !o.ordertype.includes("stop"));
    const exposureCount = openPositions.length + ourEntryOrders.length;
    const maxPositions = Math.max(1, await cfgNum("kraken_margin_max_positions", 3));
    if (exposureCount >= maxPositions) {
      return { executed: false, validated: false, note: `entry refused: ${exposureCount} positions+resting orders already (max ${maxPositions})` };
    }
    const allowStacking = (await cfg("kraken_margin_allow_stacking")) === "true";
    const wantSide = alert.side === "buy" ? "long" : "short";
    // ⚠️ EITHER DIRECTION, not just the same one. Kraken spot margin nets FIFO — it does
    // not hold a long and a short on one pair. So an OPPOSING order does not open a new
    // position: it REDUCES the existing one. If that existing position is Spencer's
    // hand-opened long, a bot `sell` alert closes part of HIS position at the bot's size,
    // realising his P&L on a trade he never authorised — the manual-book boundary breached
    // through the entry path rather than the close path. It also leaves the entry's
    // attached stop protecting nothing, and no position ever appears under our ordertxid.
    // A genuine reversal must be an explicit close followed by an entry, never netting.
    // The netting guard below is only as good as this read. 3b in the guardian refuses to
    // act on an empty OpenPositions when margin is in use, because Kraken returns an empty
    // collection during degradation — and here an empty read means "no conflict", which
    // waves through the exact opposing entry that would net against Spencer's position.
    // Fail closed on the same signal.
    if (openPositions.length === 0 && (health.marginUsedRaw == null || health.marginUsedRaw > 0)) {
      return { executed: false, validated: false, note: "positions read empty while margin is in use (or unreadable) — failing closed rather than risk netting against an existing position" };
    }
    const conflicting = openPositions.filter((p) => pairMatchesSymbol(p.pair, alert.symbol));
    if (!allowStacking && (
      conflicting.length > 0 ||
      ourEntryOrders.some((o) => pairMatchesSymbol(o.pair, alert.symbol))
    )) {
      const owned = await botTxids();
      const dirs = conflicting.map((p) => p.side).join("/") || "resting order";
      const theirs = conflicting.filter((p) => !owned.has(p.ordertxid)).length;
      return {
        executed: false,
        validated: false,
        note: `entry refused: ${alert.symbol} already has exposure (${dirs}${theirs ? `, ${theirs} NOT the bot's` : ""}) — an opposing order would net against it, not open a new position`,
      };
    }

    // Attached protective exit + risk-based sizing, both computed from the ACTUAL entry
    // price. For a maker order that price is the resting limit (bid/ask), NOT the last
    // trade — sizing the stop from a different price than the entry would make the real
    // stop distance (and risk) wrong.
    // The DEFAULT (0.3/leverage) is half the liquidation cushion and self-adjusts. An
    // EXPLICIT kraken_margin_stop_pct does not, so it is clamped to 60% of the cushion
    // here: a stop set wider than liquidation can never trigger — the position would
    // always liquidate first, and risk sizing would understate the real max loss by
    // several multiples while reporting a stop that is pure decoration.
    // liquidationEstimate models the killing move as 0.6/leverage, so THAT is the cushion —
    // not 1/leverage. The clamp must leave real headroom inside it (Kraken liquidates off
    // the account margin level, which degrades before any single stop would fire), so an
    // explicit stop is held to 60% of the true distance: 0.6 × (0.6/L) = 0.36/L.
    const liqDistance = 0.6 / Math.max(1, leverage);
    const stopPct = Math.min(0.5, 0.6 * liqDistance, Math.max(0.001, (await cfgNum("kraken_margin_stop_pct", (0.3 / leverage) * 100)) / 100));
    const trailPct = Math.min(50, Math.max(0, await cfgNum("kraken_margin_trail_pct", 0)));
    const makerEntries = (await cfg("kraken_margin_maker_entries")) !== "false";
    const meta = await getPairMeta(pair);

    // The entry reference price: the resting limit for a maker order, else the last trade.
    let entryPx: number;
    if (makerEntries) {
      const { bid, ask } = await krakenTouch(alert.symbol);
      entryPx = alert.side === "buy" ? bid : ask;
    } else {
      entryPx = await getKrakenPrice(alert.symbol);
    }
    if (!(entryPx > 0)) return { executed: false, validated: false, note: "no entry price available — skipped" };

    // RISK-BASED SIZING: notional capped so a stop-out loses ≤ max_risk_pct of equity.
    //
    // ⚠️ LIVE RISK HAS ITS OWN KEY, deliberately separate from the paper experiment's.
    // `kraken_margin_max_risk_pct` is read by the PAPER sizer too, and it is set high (3%,
    // doubled to 6% on high conviction) so paper dollars look like real trading. Sharing
    // one key would mean the day this is armed, live silently inherits the paper research
    // setting. The observed paper losing streak is 13 in a row — at 3% that is a −33%
    // account, at 6% a −55% account (which needs +124% to recover). So live reads
    // `kraken_margin_live_max_risk_pct` and defaults to 0.5%: a 13-loss streak costs 6%.
    // Raise it deliberately, in steps, only after live fills have proven out.
    let notional = perTrade * leverage;
    const maxRiskPct = Math.min(2, Math.max(0.1, await cfgNum("kraken_margin_live_max_risk_pct", 0.5))) / 100;
    const riskDist = trailPct > 0 ? trailPct / 100 : stopPct;   // fraction; price-independent
    if (equity > 0 && riskDist > 0) {
      const notionalCap = (maxRiskPct * equity) / riskDist;
      if (notional > notionalCap) notional = notionalCap;
    }
    const rawVol = notional / entryPx;
    if (meta.orderMin > 0 && rawVol < meta.orderMin) {
      return { executed: false, validated: false, note: `size ${rawVol} below Kraken minimum ${meta.orderMin} after risk cap — skipped` };
    }
    const volume = rawVol.toFixed(meta.lotDecimals);
    const stopPrice = alert.side === "buy" ? entryPx * (1 - stopPct) : entryPx * (1 + stopPct);
    const closeParams: Record<string, string> = trailPct > 0
      ? { "close[ordertype]": "trailing-stop", "close[price]": `+${trailPct.toFixed(2)}%` }
      : { "close[ordertype]": "stop-loss", "close[price]": stopPrice.toFixed(meta.priceDecimals) };

    const params: Record<string, string> = {
      pair,
      type: alert.side,
      volume,
      leverage: String(leverage),
      userref: String(MARGIN_USERREF),
      ...closeParams,
    };
    if (makerEntries) {
      params.ordertype = "limit";
      params.price = entryPx.toFixed(meta.priceDecimals);
      params.oflags = "post";   // post-only: Kraken rejects rather than crossing → never taker
    } else {
      params.ordertype = "market";
    }
    if (validate) params.validate = "true";

    let res;
    try {
      res = await krakenPrivate("AddOrder", params);
    } catch (e) {
      if (makerEntries && /post|would|cross/i.test(String(e))) {
        return { executed: false, validated: false, note: "maker entry would cross — price moved, skipped (no chase)" };
      }
      throw e;
    }
    const txid = (res.txid as string[] | undefined)?.[0];
    const descr = (res.descr as { order?: string } | undefined)?.order;

    // Record ownership BEFORE anything else can fail: this txid is how the close path and
    // the guardian's naked-position check know the resulting position is ours rather than
    // Spencer's. A missing entry here makes a close skip that position (safe); it can
    // never cause us to close one that is not ours.
    if (!validate && txid) await recordBotEntry(txid, pair);

    // Count on acceptance (conservative — an unfilled maker rest still consumes a slot,
    // which caps churn; the guardian sweeps unfilled entries). Real executions only.
    if (!validate) await bumpDayState(dayState);

    const stopDesc = trailPct > 0 ? `trailing stop ${trailPct.toFixed(1)}%` : `stop ${(stopPct * 100).toFixed(1)}%`;
    return {
      executed: !validate,
      validated: validate,
      txid,
      note: `${alert.side} $${notional.toFixed(0)} notional (${leverage}x, ${makerEntries ? "maker" : "market"}) ${pair}, ${stopDesc}, risk≤${(maxRiskPct * 100).toFixed(1)}% equity${validate ? " (validate)" : ""} — ${descr ?? ""}`,
    };
  } catch (e) {
    // An AddOrder that times out may still have been ACCEPTED — the request succeeded and
    // only the response was lost. Reporting "order failed" would leave Spencer believing
    // nothing happened while a real levered position exists. Look before we say that.
    try {
      const [pos, ords] = await Promise.all([
        getKrakenMarginPositions().catch(() => []),
        krakenOpenOrders().catch(() => []),
      ]);
      const livePos = pos.filter((p) => pairMatchesSymbol(p.pair, alert.symbol));
      const liveOrd = ords.filter((o) => o.userref === MARGIN_USERREF && pairBase(o.pair) === pairBase(pair));
      if (livePos.length || liveOrd.length) {
        // The txid is unknown on this path (that IS the failure), so the position cannot be
        // recorded in the ownership ledger — meaning it is currently unclosable by alert and
        // outside the naked-position guard. Hand over the ids needed to adopt it.
        const ids = livePos.map((p) => p.ordertxid || p.id).filter(Boolean).join(", ");
        await sendNotification(
          `🚨 Order errored but Kraken shows ${livePos.length} position(s) and ${liveOrd.length} order(s) on ${pair} — it may have been ACCEPTED. It is NOT in the ownership ledger, so closes and the naked-stop guard will skip it. Adopt it: set kraken_margin_adopt_txids=${ids || "<position id from Kraken>"}. Error: ${String(e).slice(0, 140)}`,
          "margin_urgent",
        ).catch(() => {});
        return { executed: false, validated: validate, note: `order errored BUT live exposure detected on ${pair} — verify manually: ${e}` };
      }
    } catch { /* best-effort confirmation only */ }
    return { executed: false, validated: validate, note: `order failed: ${e}` };
  } finally {
    await releaseExecLock(lockToken_);
  }
}
