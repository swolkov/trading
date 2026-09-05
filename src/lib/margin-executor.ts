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
//   3. kraken_margin_max_leverage — operator CEILING (default 5 so the account can
//      grow into 3×/5×). Actual leverage is min(ceiling, equity ladder): 2× below
//      $10k (the $5k live book), 3× from $10k, 5× from $20k. Risk % does not change.
//      Values below Kraken's margin minimum of 2 REFUSE entries rather than silently
//      rounding up.
//   4. kraken_margin_per_trade_usd — OPTIONAL ceiling on margin per entry (default 0 =
//      none; sizing is risk-based like paper: risk × equity ÷ stop, ≤ leverage × equity).
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
//      • kraken_margin_live_max_risk_pct (default 3, hard ceiling 6) — SIZE is capped so
//        the stop-loss can never lose more than this % of equity; notional shrinks
//        automatically. The `live_` prefix exists so live and paper are INDEPENDENTLY
//        settable, not to force a different number — it defaults to the same 3% the paper
//        sizer uses, which is the agreed policy. Total damage from a losing run is bounded
//        by the drawdown breaker (layer 8a), not by this number; risk % sets how fast that
//        bound is reached (6 losses at 3%, 33 at 0.5%).
//        ⚠️ CONVICTION-SCALED, mirroring the paper record: high 2×, low 0.5×, clamped at
//        6%. So a HIGH-conviction entry risks 6% and three consecutive such losses trip
//        the 15% drawdown breaker. That is deliberate — flat sizing was measured to throw
//        away the entire edge — but it is the fastest path to the breaker, by design.
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
import { pairMatchesSymbol, pairBase, isUsMarginSymbol, usRetailMaxLeverage } from "@/lib/kraken-pairs";
import { applyReconcile, planReconcile } from "@/lib/margin-book";
import { getKrakenMarginPositions, getKrakenMarginHealth, listRoundTrips } from "@/lib/kraken-margin";
import { convictionForAlert } from "@/lib/margin-scanner";
import {
  DEFAULT_MAX_LEVERAGE,
  EXEC_LOCK_TTL_MS,
  LIVE_STOP_DEFAULT_PCT,
  clampLiveStopFrac,
  effectiveMaxLeverage,
  fifoWouldHitManual,
  failClosedOnEmptyPositions,
  liveNotional,
  liveRiskFraction,
  parseLiveRiskBasePct,
  pairHasExposure,
} from "@/lib/margin-live-risk";

// Distinct from the trend bot's 770077 so each system's orders are separable forever.
export const MARGIN_USERREF = 770078;

export interface AlertOrder {
  symbol: string;              // "BTC/USD" style
  side: "buy" | "sell" | "close";
  leverage?: number;
  note?: string;
  // Conviction tier for this setup. Supply it to override; leave it undefined and the
  // executor scores the coin itself with the SAME scorer the paper record uses. Sizing
  // scales with it exactly as paper does — see liveRiskFraction().
  conviction?: "low" | "med" | "high";
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

export interface LedgerEntry { txid: string; pair: string; ts: number; stopFrac?: number }
// Returns true only when the entry is durably written. STRICT read: a failed read must
// never be treated as an empty ledger — writing [B] over a ledger that held A would strip
// A's ownership (unclosable by alert, unprotected by the guardian). A corrupt existing
// ledger is backed up, then replaced. `stopFrac` is the entry's authorised 1R, stored so
// the guardian's managed exit never has to re-derive it from a stop that may already
// have been ratcheted.
async function recordBotEntry(txid: string, pair: string, meta?: { stopFrac?: number }): Promise<boolean> {
  try {
    const raw = await cfgStrict(BOT_TXIDS_KEY);
    const cutoff = Date.now() - BOT_TXID_TTL_MS;
    let prev: LedgerEntry[] = [];
    if (raw) {
      try { prev = JSON.parse(raw) as LedgerEntry[]; }
      catch {
        await prisma.agentConfig.upsert({ where: { key: `${BOT_TXIDS_KEY}_corrupt_backup` }, update: { value: raw }, create: { key: `${BOT_TXIDS_KEY}_corrupt_backup`, value: raw } }).catch(() => {});
        await sendNotification(`🚨 kraken_margin_bot_txids was CORRUPT; backed up to kraken_margin_bot_txids_corrupt_backup and restarted. Any older bot position must be re-adopted via kraken_margin_adopt_txids.`, "margin_urgent").catch(() => {});
        prev = [];
      }
    }
    const next = prev.filter((e) => e && e.ts > cutoff && e.txid !== txid);
    next.push({ txid, pair, ts: Date.now(), ...(meta?.stopFrac ? { stopFrac: meta.stopFrac } : {}) });
    await prisma.agentConfig.upsert({
      where: { key: BOT_TXIDS_KEY },
      update: { value: JSON.stringify(next.slice(-BOT_TXID_MAX)) },
      create: { key: BOT_TXIDS_KEY, value: JSON.stringify(next.slice(-BOT_TXID_MAX)) },
    });
    return true;
  } catch (e) {
    // NOT best-effort in consequence: an unrecorded position is invisible to BOTH the close
    // path and the guardian's naked-position guard, so it is unclosable by alert AND
    // unprotected. Page immediately with the id needed to adopt it.
    await sendNotification(
      `🚨 Could not record bot position ${txid} on ${pair}. It will NOT be recognised by close alerts or the naked-position guard. Add it to kraken_margin_adopt_txids now. ${String(e).slice(0, 120)}`,
      "margin_urgent",
    ).catch(() => {});
    return false;
  }
}

export async function botTxids(): Promise<Set<string>> {
  const raw = await cfg(BOT_TXIDS_KEY);
  if (!raw) return new Set();
  try {
    return new Set((JSON.parse(raw) as { txid: string }[]).map((e) => e.txid).filter(Boolean));
  } catch { return new Set(); }
}

// THE ownership predicate — ledger ∪ kraken_margin_adopt_txids, matched on ordertxid OR
// position id — built ONCE here so the close path and the guardian's naked-position guard
// and managed exit cannot disagree about which positions are the bot's. STRICT reads: a
// DB failure THROWS rather than reading as "nothing is ours" (which made a close a silent
// no-op with the wrong reason, and would leave adopted positions unprotected).
export async function botOwnership(): Promise<{ isOurs: (p: { ordertxid: string; id: string }) => boolean; ledger: Set<string>; adopted: Set<string>; ledgerCorrupt: boolean; stopFracOf: (ordertxid: string) => number | null }> {
  const raw = await cfgStrict(BOT_TXIDS_KEY);
  const adoptRaw = (await cfgStrict("kraken_margin_adopt_txids")) ?? "";
  const adopted = new Set(adoptRaw.split(",").map((s) => s.trim()).filter(Boolean));
  let ledger = new Set<string>();
  const stopFrac = new Map<string, number>();
  let ledgerCorrupt = false;
  if (raw) {
    // A corrupt ledger must not take the ADOPTION list and the emergency override down
    // with it — those are read independently and keep working. Every caller reports the
    // flag loudly; positions recorded only in the corrupt ledger read as NOT ours (fail
    // closed) until the operator adopts them or repairs the ledger.
    try {
      const entries = JSON.parse(raw) as LedgerEntry[];
      ledger = new Set(entries.map((e) => e.txid).filter(Boolean));
      for (const e of entries) if (e.txid && e.stopFrac && e.stopFrac > 0) stopFrac.set(e.txid, e.stopFrac);
    } catch { ledgerCorrupt = true; }
  }
  return {
    ledger, adopted, ledgerCorrupt,
    isOurs: (p) => ledger.has(p.ordertxid) || adopted.has(p.ordertxid) || adopted.has(p.id),
    stopFracOf: (ordertxid) => stopFrac.get(ordertxid) ?? null,
  };
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
    // SERIALISE closes — wait for a concurrent close to finish, never refuse. Two closes
    // reading the same snapshot would both pass the FIFO guard and the second would reduce
    // a NEWER manual position after the first consumed the bot's. reduce_only is not
    // idempotency. A lock that could trap a close is worse than no lock, so after 20s we
    // proceed regardless; the fresh positions read below is what makes the retry harmless.
    const closeToken = `${new Date().toISOString()}#${Math.random().toString(36).slice(2, 10)}`;
    let closeLockHeld = false;
    // Wait up to the lock's TTL (60s): a live holder is never bypassed, a dead one expires, a
    // close is never refused. Each tranche is also re-read right before its own order.
    for (let i = 0; i < 60; i++) {
      const cutoff = new Date(Date.now() - 60_000).toISOString();
      await prisma.agentConfig.upsert({ where: { key: "kraken_margin_close_lock" }, update: {}, create: { key: "kraken_margin_close_lock", value: "" } }).catch(() => {});
      const r = await prisma.agentConfig.updateMany({ where: { key: "kraken_margin_close_lock", OR: [{ value: "" }, { value: { lt: cutoff } }] }, data: { value: closeToken } }).catch(() => ({ count: 0 }));
      if (r.count === 1) { closeLockHeld = true; break; }
      await new Promise((r) => setTimeout(r, 1000));
    }
    try {
      // Our RESTING ENTRY orders on the pair go first: a partially filled maker entry could
      // otherwise keep filling after the flatten and leave a fresh bot tranche behind a
      // "closed" result. Then the positions are read, so the volume to flatten is current.
      try {
        const restingEntries = (await krakenOpenOrders()).filter((o) => o.userref === MARGIN_USERREF && !o.ordertype.includes("stop") && pairBase(o.pair) === pairBase(pair));
        for (const o of restingEntries) { try { await krakenCancelOrder(o.txid); } catch { await sendNotification(`⚠️ Could not cancel resting entry ${o.txid} on ${pair} before the close — cancel it on Kraken.`, "margin_urgent").catch(() => {}); } }
      } catch { /* the post-close sweep re-reads orders and reports its own failures */ }
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
      // Ownership is a STRICT read: if the ledger cannot be read, the close is NOT attempted
      // (a silent "not the bot's" no-op told the operator the wrong reason and left risk on).
      // The emergency authorisation is read FIRST, so a broken ledger cannot block the one
      // close the operator has explicitly authorised. It is CONSUMED only after a close
      // actually went through (below) — a burned flag with nothing closed is the worst outcome.
      const closeAllRaw = (await cfg("kraken_margin_close_all_positions")) ?? "";
      const closeAllTarget = closeAllRaw.trim().toUpperCase();
      const closeAllAuthorised = closeAllTarget === "ALL" || closeAllTarget === "TRUE" || closeAllTarget === alert.symbol.toUpperCase();
      let ownership: Awaited<ReturnType<typeof botOwnership>>;
      try {
        ownership = await botOwnership();
      } catch (e) {
        if (!closeAllAuthorised) {
          await sendNotification(
            `🚨 Close on ${pair} NOT attempted — the ownership ledger could not be read (${String(e).slice(0, 120)}). The position is still open with its stop. Retry the close, or set kraken_margin_close_all_positions=${alert.symbol.toUpperCase()} to flatten the pair without it.`,
            "margin_urgent",
          ).catch(() => {});
          return { executed: false, validated: false, note: `close not attempted: ownership ledger unreadable — retry` };
        }
        // Authorised to flatten the pair regardless of ownership: proceed as if nothing is ours.
        ownership = { isOurs: () => false, ledger: new Set(), adopted: new Set(), ledgerCorrupt: false, stopFracOf: () => null };
      }
      // ONE-SHOT AND PAIR-SCOPED. Sticky, an emergency flag set once would silently flatten
      // Spencer's manual book on every later close for that pair. Global, it would be burned
      // by whichever close alert happened to land first — he sets it to free a stuck ETH
      // position, a routine BTC close consumes it, and ETH is still open while his manual
      // BTC book just got flattened. So the value names the symbol it authorises
      // ("ETH/USD", or "ALL"), and it is consumed ONLY on a matching pair that actually has
      // something to close.
      // "ALL" and the legacy "true" both mean EVERY pair — whichever close lands first
      // consumes it. Anything else must name the symbol it authorises.
      const closeAll = all.length > 0 && closeAllAuthorised;
      const { isOurs } = ownership;
      const preNotes: string[] = [];   // deferred: nothing may sit between a close alert and the close
      if (ownership.ledgerCorrupt) {
        preNotes.push(`🚨 kraken_margin_bot_txids is CORRUPT (unparseable). Positions recorded only there are being treated as NOT the bot's. Repair it, or adopt them via kraken_margin_adopt_txids.`);
      }
      // KRAKEN NETS FIFO: a reduce-only sell on the pair reduces the OLDEST long first,
      // whoever opened it. A bot position with an OLDER manual position beside it cannot
      // be closed by a pair-level order without hitting Spencer's book — refuse, and say so.
      const samePair = (a: string, b: string) => pairBase(a) === pairBase(b);
      const fifoBlocked = closeAll ? [] : all.filter((p) => isOurs(p) && fifoWouldHitManual(p, all, (q) => isOurs(q as unknown as { ordertxid: string; id: string }), samePair));
      const positions = closeAll ? all : all.filter((p) => isOurs(p) && !fifoBlocked.includes(p));
      const skipped = all.filter((p) => !closeAll && !isOurs(p));
      if (fifoBlocked.length) {
        preNotes.push(`🚨 Close on ${pair}: ${fifoBlocked.length} bot position(s) NOT closed — an OLDER manual position on the same side would be reduced first (Kraken nets FIFO). Close the manual one by hand first, or set kraken_margin_close_all_positions=${alert.symbol.toUpperCase()} to flatten the whole pair deliberately. The bot's stops stay in place.`);
      }
      // Notifications are deliberately deferred until AFTER the orders are placed:
      // sendNotification's fetch has no timeout, and a hung Slack webhook must never sit
      // between a close alert and the close itself.
      const pending: string[] = [...preNotes];
      if (!positions.length) {
        for (const m of preNotes) await sendNotification(m, "margin_urgent").catch(() => {});
        if (fifoBlocked.length) return { executed: false, validated: false, note: `close refused: an older manual position on ${pair} would be closed first (FIFO) — bot positions left open with their stops` };
        const note = skipped.length > 0
          ? `close alert: ${skipped.length} position(s) on ${pair} are NOT the bot's — left untouched. Position ids: ${skipped.map((p) => p.ordertxid || p.id).join(", ")}. To flatten the pair deliberately set kraken_margin_close_all_positions=${alert.symbol.toUpperCase()} (or ALL). ⚠️ Adopting an id via kraken_margin_adopt_txids puts that position under the bot's FULL container (3% stop, ratchet, 48h time stop) — only adopt positions the bot actually opened.`
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
      let closeErr: unknown = null;
      for (const p of positions) {
        // Fresh check: is this exact tranche still open, at what volume? A concurrent close
        // (or Kraken) may have taken it; a reduce-only order for a gone tranche would net
        // against the NEXT position on the side under FIFO — possibly Spencer's.
        let liveVol = p.vol;
        try {
          const now = await getKrakenMarginPositions();
          const cur = now.find((q) => q.id === p.id);
          if (!cur) { pending.push(`ℹ️ ${pair}: tranche ${p.id} was already closed — skipped.`); continue; }
          liveVol = cur.vol;
        } catch { /* keep the snapshot volume; reduce_only bounds the damage to flat */ }
        const params: Record<string, string> = {
          pair,
          type: p.side === "long" ? "sell" : "buy",
          ordertype: "market",
          volume: liveVol.toFixed(closeMeta.lotDecimals),
          leverage: String(Math.max(2, Math.round(p.leverage))),
          // reduce_only: if the position shrank between our read and this order (manual
          // close, partial liquidation, duplicate alert), Kraken reduces to flat instead
          // of opening an opposite position with the excess volume.
          reduce_only: "true",
          userref: String(MARGIN_USERREF),
        };
        if (validate) params.validate = "true";
        try {
          const res = await krakenPrivate("AddOrder", params);
          const txid = (res.txid as string[] | undefined)?.[0];
          if (txid) txids.push(txid);
        } catch (e) {
          closeErr = e;
          break;
        }
      }
      // RECONCILE FROM WHAT IS ACTUALLY LEFT. Whatever the responses said (accepted, partial,
      // lost), the truth is the remaining bot exposure on each side we touched: zero → every
      // stop of ours on that side goes (a resting non-reduce-only stop would OPEN a position);
      // some → exactly one full-volume reduce-only stop stays. A read we cannot trust leaves
      // everything as it was and says so LOUDLY (the guardian retries within 5 min).
      let confirmedGone = false;
      const touchedSides = new Set<"long" | "short">(positions.map((p) => p.side));
      try {
        const health = await getKrakenMarginHealth().catch(() => null);
        const after = await getKrakenMarginPositions();
        if (failClosedOnEmptyPositions(after.length, health?.marginUsedRaw ?? null)) throw new Error("positions read unreliable after close");
        const targeted = new Set(positions.map((p) => p.id));
        confirmedGone = !after.some((p) => targeted.has(p.id));
        const px = await getKrakenPrice(alert.symbol).catch(() => 0);
        const orders = await krakenOpenOrders();
        for (const side of touchedSides) {
          // ALL remaining bot exposure on this side — including tranches this close refused
          // (FIFO) — decides the cover, never just the ones we targeted.
          const remainingBot = after.filter((p) => pairMatchesSymbol(p.pair, alert.symbol) && p.side === side && (closeAll || isOurs(p)));
          const vol = remainingBot.reduce((s, p) => s + p.vol, 0);
          const closeSide = side === "long" ? "sell" : "buy";
          const ours = orders.filter((o) => o.userref === MARGIN_USERREF && o.ordertype.includes("stop") && pairBase(o.pair) === pairBase(pair) && o.side === closeSide);
          const fixed = ours.filter((o) => o.ordertype === "stop-loss" && o.price > 0);
          const bestResting = fixed.length ? (side === "long" ? Math.max(...fixed.map((o) => o.price)) : Math.min(...fixed.map((o) => o.price))) : null;
          const entryPx = vol > 0 ? remainingBot.reduce((s, p) => s + p.entryPrice * p.vol, 0) / vol : 0;
          const fracs = remainingBot.map((p) => ownership.stopFracOf(p.ordertxid) ?? 0).filter((f) => f > 0);
          const levMax = Math.max(2, ...remainingBot.map((p) => p.leverage));
          const frac = fracs.length ? Math.min(...fracs) : clampLiveStopFrac(await cfgNum("kraken_margin_stop_pct", LIVE_STOP_DEFAULT_PCT), levMax);
          const level = bestResting ?? (side === "long" ? entryPx * (1 - frac) : entryPx * (1 + frac));
          const plan = planReconcile({ side, vol, targetLevel: level, px, priceDecimals: closeMeta.priceDecimals, lotDecimals: closeMeta.lotDecimals }, ours);
          if (plan.blocked) { pending.push(`🚨 ${pair} ${side}: could not reconcile stops after the close — ${plan.blocked}. Stops LEFT IN PLACE; the guardian retries in ≤5 min. Check Kraken.`); continue; }
          if (!plan.place && !plan.cancel.length) continue;
          const out = await applyReconcile(plan, {
            placeStop: async (lvl, v) => {
              const res = await krakenPrivate("AddOrder", { pair, type: closeSide, ordertype: "stop-loss", price: lvl, volume: v, leverage: String(Math.round(levMax)), reduce_only: "true", userref: String(MARGIN_USERREF) });
              return (res.txid as string[] | undefined)?.[0];
            },
            cancel: (txid) => krakenCancelOrder(txid),
          });
          if (out.cancelled.length) pending.push(`🧹 ${pair} ${side}: ${plan.reason} — cancelled ${out.cancelled.length} stop(s)${out.placed ? `, placed one for ${plan.place?.vol}` : ""}.`);
          if (out.placeFailed) pending.push(`🚨 ${pair} ${side}: ${vol} still open and a protective stop could NOT be placed (${out.placeFailed}) — act on Kraken now.`);
          if (out.failedCancels.length) pending.push(`🚨 ${pair} ${side}: could NOT cancel stop(s) ${out.failedCancels.join(", ")} after the close. A stranded non-reduce-only stop can OPEN a position if it triggers. Cancel them on Kraken now.`);
          if (vol > 0 && closeErr == null && !fifoBlocked.length) pending.push(`⚠️ ${pair} ${side}: ${vol} still open after the close orders (partial fill?) — covered by a stop; retry the close.`);
        }
      } catch (e) {
        pending.push(`🚨 Could not confirm the close on ${pair} (${String(e).slice(0, 80)}) — resting stop(s) LEFT IN PLACE; the guardian reconciles within ~5 min. Check Kraken now.`);
      }
      // Consume the one-shot authorisation now that a close actually went through. A failed
      // consume is paged: the flag would flatten manual positions on the NEXT close too.
      if (closeAll && (txids.length > 0 || confirmedGone)) {
        const cleared = await prisma.agentConfig.updateMany({
          where: { key: "kraken_margin_close_all_positions", value: closeAllRaw },
          data: { value: "" },
        }).catch(() => ({ count: 0 }));
        if (cleared.count !== 1) {
          await sendNotification(`⚠️ Could not clear kraken_margin_close_all_positions after using it on ${pair} — it is STILL ARMED and will flatten manual positions on the next close. Clear it by hand.`, "margin_urgent").catch(() => {});
        }
      }
      for (const msg of pending) await sendNotification(msg, "margin_urgent").catch(() => {});
      if (closeErr) {
        await sendNotification(
          `🚨 CLOSE FAILED on ${pair} after flattening ${txids.length} of ${positions.length} — the rest may STILL BE OPEN. Check Kraken now. Error: ${String(closeErr).slice(0, 200)}`,
          "margin_urgent",
        ).catch(() => {});
        return { executed: txids.length > 0, validated: false, note: `close failed after flattening ${txids.length}/${positions.length}: ${closeErr}` };
      }
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
    } finally {
      if (closeLockHeld) {
        await prisma.agentConfig.updateMany({ where: { key: "kraken_margin_close_lock", value: closeToken }, data: { value: "" } }).catch(() => {});
      }
    }
  }

  // ---- ENTRY PATH ----
  // Layer 1: armed at all? (Entries only — the close path above deliberately runs first.)
  const auto = (await cfg("kraken_margin_auto")) === "true";
  if (!auto) return { executed: false, validated: false, note: "tracked only (kraken_margin_auto off)" };

  // Layer 1b: the pair must be one a US retail account can actually margin-trade — the
  // same table that bounds the scanner universe and the paper record (kraken-pairs.ts).
  // Kraken would reject the order anyway, but only after we hold the exec lock, burn the
  // cooldown, and spend a dozen API calls; and an entry alert on an untradeable pair means
  // the alert SOURCE is misconfigured, which deserves a clear note rather than a Kraken
  // error string. Entries only — the close path above must never be blocked.
  if (!isUsMarginSymbol(alert.symbol)) {
    return { executed: false, validated: false, note: `entry refused: ${alert.symbol} is not in the US-retail margin universe (US_MARGIN_MAX_LEVERAGE)` };
  }

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
  // Set immediately before AddOrder. Every read above it (round trips, health, positions,
  // orders) can throw on a Kraken rate limit — and the catch below must NOT then tell the
  // operator to "adopt" a position that is his own, because nothing was ever sent.
  let addOrderSent = false;
  let sentAtSec = 0;
  let stopPctSent = 0;                       // the stop distance this entry was sized with
  let dayStateRef: DayState | null = null;   // so a recovered fill still counts toward the day
  try {
    // Layer 8b: trade-frequency governor — the structural cure for the fee bleed.
    const dayState = await loadDayState();
    dayStateRef = dayState;
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
    // The actual cap is applied AFTER equity is known (ladder below). This check only
    // refuses a misconfigured operator ceiling.
    const cfgMaxLev = await cfgNum("kraken_margin_max_leverage", DEFAULT_MAX_LEVERAGE);
    if (cfgMaxLev < 2) {
      return { executed: false, validated: false, note: `entries disabled (max leverage ${cfgMaxLev} < Kraken minimum 2)` };
    }
    // Optional operator ceiling on margin per entry. Default 0 = NONE: sizing is risk-based
    // exactly like paper. (The old $100 default silently made live risk ~0.6%, not 3%.)
    const perTrade = Math.max(0, await cfgNum("kraken_margin_per_trade_usd", 0));
    const lossCap = Math.max(0, await cfgNum("kraken_margin_daily_loss_cap", 200));

    // Layer 5a: the guardian's PROTECTION must have actually run recently (the stamp is
    // written only after step 3c completed without a failure — not at route start). The
    // container's exit and the naked-position rescue live there; entering while it is down
    // would open a trade nothing manages. Re-checked immediately before AddOrder.
    const guardianFresh = async (): Promise<boolean> => {
      const v = await cfg("margin_watch_protect_ok");
      const t = v ? Date.parse(v) : NaN;
      return Number.isFinite(t) && Date.now() - t <= 15 * 60 * 1000;
    };
    if (!(await guardianFresh())) {
      return { executed: false, validated: false, note: "guardian protection has not completed in 15m — no new entries while nothing would manage them (failing closed)" };
    }

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
    // Equity ladder: $5k book stays 2× even if the operator ceiling is 5. Risk % is
    // unchanged — larger equity just means larger dollar bets at the same 3%/6%.
    const maxLev = effectiveMaxLeverage(cfgMaxLev, equity);
    // Also capped at the pair's own US-retail maximum (ALGO/XLM are 2×, PENGU/NEAR/RENDER
    // 3×): once the ladder allows 3×+ an order above the pair cap would be rejected by
    // Kraken — fail-safe, but a silent "this pair can never enter". Cap it here instead.
    const leverage = Math.min(maxLev, usRetailMaxLeverage(alert.symbol, maxLev), Math.max(2, alert.leverage ?? 2));
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
    if (failClosedOnEmptyPositions(openPositions.length, health.marginUsedRaw)) {
      return { executed: false, validated: false, note: "positions read empty while margin is in use (or unreadable) — failing closed rather than risk netting against an existing position" };
    }
    const conflicting = openPositions.filter((p) => pairMatchesSymbol(p.pair, alert.symbol));
    // ALL our resting orders count — stops included. A bot stop resting on a pair with no
    // position is by definition stranded (the guardian's sweep needs two runs), and a new
    // opposing entry inside that window would be DOUBLED when the old stop fired — as an
    // unowned, stop-less position. Refusing entry is strictly safe.
    if (!allowStacking && pairHasExposure(
      alert.symbol,
      openPositions.map((p) => p.pair),
      ourOrders.map((o) => o.pair),
      pairMatchesSymbol,
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
    // DEFAULT = the paper record's container (3%, LIVE_STOP_DEFAULT_PCT), so the "At LIVE
    // sizing" column describes a trade with the SAME stop the paper sleeve was scored with.
    // (It was 0.3/leverage = 15% at 2× until Sep 5 2026: same signal, different container.)
    const stopPct = clampLiveStopFrac(await cfgNum("kraken_margin_stop_pct", LIVE_STOP_DEFAULT_PCT), leverage);
    stopPctSent = stopPct;
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
    // LIVE RISK HAS ITS OWN KEY so paper and live can be tuned independently — but it
    // DEFAULTS TO THE SAME 3% the paper sizer uses, because that is the agreed policy:
    // the paper sizer was built to mirror the live executor, and 3% is the level this
    // operation has run for a long time (futures used 3-8%).
    //
    // The separate key exists to prevent a silent COUPLING, not to impose a lower number.
    // ⚠️ An earlier version of this comment argued for 0.5% off a "13 consecutive losses"
    // figure. That figure was wrong twice over: it pooled six strategies including the two
    // that were retired (the strategy we would actually arm shows 0-3), and it ignored the
    // drawdown breaker entirely. The guardian halts entries at
    // kraken_margin_max_drawdown_pct (15%) and now stays halted pending review, so the
    // damage from ANY streak is bounded near 15-17% at every risk level in this range —
    // 3% simply reaches that bound in 6 losses instead of 33. Risk level sets the SPEED of
    // the stop, not the size of the loss. Choosing it is Spencer's call, not the code's.
    // Ceiling 6% mirrors the paper conviction ceiling: it blocks catastrophe, not policy.
    const baseRiskPct = parseLiveRiskBasePct(await cfgNum("kraken_margin_live_max_risk_pct", 3));
    // CONVICTION-SCALED, exactly as the paper record is. Shared with the scoreboard via
    // margin-live-risk.ts so the two cannot drift. Unscoreable → 1× (med), never high.
    // The alert's own `conviction` is honoured ONLY when kraken_margin_trust_alert_conviction
    // is "true": otherwise a payload could double the risk on the strength of the shared
    // secret alone. Default: the executor scores the coin itself, as paper does.
    const trustAlertConviction = (await cfg("kraken_margin_trust_alert_conviction")) === "true";
    let convTier: "low" | "med" | "high" | null = trustAlertConviction ? (alert.conviction ?? null) : null;
    if (!convTier && (alert.side === "buy" || alert.side === "sell")) {
      try {
        convTier = (await convictionForAlert(alert.symbol, alert.side))?.tier ?? null;
      } catch { convTier = null; }
    }
    const maxRiskPct = liveRiskFraction(baseRiskPct, convTier);
    const riskDist = trailPct > 0 ? trailPct / 100 : stopPct;   // fraction; price-independent
    // SIZE = risk × equity ÷ stop, capped at leverage × equity — paper's positionNotional
    // on the REAL account's equity, so dollar size grows with the account automatically.
    const notional = liveNotional(equity, maxRiskPct, riskDist, leverage, perTrade);
    if (!(notional > 0)) return { executed: false, validated: false, note: "sizing produced no notional — skipped" };
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

    if (!(await guardianFresh())) {
      return { executed: false, validated: false, note: "guardian protection went stale during entry checks — not sent (failing closed)" };
    }
    let res;
    sentAtSec = Math.floor(Date.now() / 1000);
    addOrderSent = true;   // from here on, an exception may mean an ACCEPTED order
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
    const ledgered = !validate && txid ? await recordBotEntry(txid, pair, { stopFrac: stopPct }) : true;

    // Count on acceptance (conservative — an unfilled maker rest still consumes a slot,
    // which caps churn; the guardian sweeps unfilled entries). Real executions only.
    if (!validate) await bumpDayState(dayState);

    const stopDesc = trailPct > 0 ? `trailing stop ${trailPct.toFixed(1)}%` : `stop ${(stopPct * 100).toFixed(1)}%`;
    return {
      executed: !validate,
      validated: validate,
      txid,
      note: `${alert.side} $${notional.toFixed(0)} notional (${leverage}x, ${makerEntries ? "maker" : "market"}) ${pair}, ${stopDesc}, ${convTier ?? "unscored"} conviction → risk≤${(maxRiskPct * 100).toFixed(1)}% equity${validate ? " (validate)" : ""}${ledgered ? "" : " ⚠️ UNLEDGERED — adopt it"} — ${descr ?? ""}`,
    };
  } catch (e) {
    if (!addOrderSent) {
      // Failed on a READ before any order was sent. Nothing was placed; say exactly that —
      // and never list positions here, because any position on the pair is Spencer's.
      return { executed: false, validated: validate, note: `entry failed before any order was sent — nothing placed: ${String(e).slice(0, 160)}` };
    }
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
      // Our RESTING entry orders carry our userref: their identity is known, so ledger
      // them now and a later fill is a recognised position (closable, protected).
      // Only THIS order: our direction, opened at/after the send. Ledger success is checked
      // (a failed write must not be reported as "ledgered"), the acceptance counts toward
      // the day's entries, and none of this runs on a validate pass.
      const restingEntries = validate ? [] : liveOrd.filter((o) => !o.ordertype.includes("stop") && o.side === alert.side && o.opentm >= sentAtSec - 2);
      if (restingEntries.length) {
        const ok: string[] = [];
        const bad: string[] = [];
        for (const o of restingEntries) { if (await recordBotEntry(o.txid, pair, { stopFrac: stopPctSent || undefined })) ok.push(o.txid); else bad.push(o.txid); }
        if (dayStateRef) await bumpDayState(dayStateRef);
        await sendNotification(
          bad.length
            ? `🚨 Entry on ${pair} errored after sending; our resting order ${bad.join(", ")} was found but could NOT be ledgered — adopt it via kraken_margin_adopt_txids now. Error: ${String(e).slice(0, 120)}`
            : `⚠️ Entry on ${pair} errored after sending, but our resting order ${ok.join(", ")} was found and ledgered — nothing to adopt. Error: ${String(e).slice(0, 120)}`,
          "margin_urgent").catch(() => {});
        return { executed: false, validated: validate, note: `order errored but our resting entry was found${bad.length ? " (UNLEDGERED — adopt it)" : " and ledgered"} on ${pair}: ${e}` };
      }
      // No resting order: the accepted order may have FILLED. Its txid is still ours to
      // recover — ClosedOrders filtered by our userref in the last few minutes — and that,
      // not a list of positions on the pair (which may be Spencer's), is what gets ledgered.
      // Only THIS order qualifies: opened at/after the moment we sent it, on this pair, in
      // this direction, actually executed. A reduce-only close placed minutes earlier
      // carries the same userref and must never be ledgered as an entry. Nothing to
      // recover on a validate run — nothing could have been placed.
      let recovered: string[] = [];
      if (!validate) {
        try {
          const closed = await krakenPrivate("ClosedOrders", { userref: String(MARGIN_USERREF), start: String(sentAtSec - 2) });
          const entries = Object.entries((closed.closed ?? {}) as Record<string, { descr?: { pair?: string; ordertype?: string; type?: string }; status?: string; opentm?: number; vol_exec?: string }>);
          recovered = entries
            // Filled, or partially filled then cancelled — any executed volume is real exposure.
            .filter(([, o]) => o.descr?.pair && pairBase(o.descr.pair) === pairBase(pair)
              && !(o.descr.ordertype ?? "").includes("stop")
              && o.descr.type === alert.side
              && (o.opentm ?? 0) >= sentAtSec - 2
              && parseFloat(o.vol_exec ?? "0") > 0)
            .map(([txid]) => txid);
          const ledgered: string[] = [];
          for (const txid of recovered) { if (await recordBotEntry(txid, pair, { stopFrac: stopPctSent || undefined })) ledgered.push(txid); }
          recovered = ledgered;
          if (recovered.length && dayStateRef) await bumpDayState(dayStateRef);   // it counts as an entry
        } catch { recovered = []; }
      }
      if (recovered.length) {
        await sendNotification(`⚠️ Entry on ${pair} errored after sending, but Kraken confirms it filled (${recovered.join(", ")}) — ledgered; the guardian will protect it. Error: ${String(e).slice(0, 120)}`, "margin_urgent").catch(() => {});
        return { executed: !validate, validated: validate, txid: recovered[0], note: `order errored but was filled and recovered on ${pair}: ${e}` };
      }
      if (livePos.length) {
        // Last resort. These positions were NOT confirmed as ours — any of them may be
        // Spencer's own. Adoption puts a position under the bot's full container, so the
        // instruction is to VERIFY on Kraken first, not to adopt blindly.
        const ids = livePos.map((p) => p.ordertxid || p.id).filter(Boolean).join(", ");
        await sendNotification(
          `🚨 Order errored on ${pair} and could not be confirmed either way. Kraken shows ${livePos.length} position(s) on the pair (${ids}) — some or all may be YOURS. Check Kraken: if one was opened by the bot just now, adopt ONLY that id via kraken_margin_adopt_txids. Error: ${String(e).slice(0, 140)}`,
          "margin_urgent",
        ).catch(() => {});
        return { executed: false, validated: validate, note: `order errored, unconfirmed; positions exist on ${pair} — verify manually: ${e}` };
      }
    } catch { /* best-effort confirmation only */ }
    return { executed: false, validated: validate, note: `order failed: ${e}` };
  } finally {
    await releaseExecLock(lockToken_);
  }
}
