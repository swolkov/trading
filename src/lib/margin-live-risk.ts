// Shared LIVE risk math — paper scoreboard and the Kraken executor MUST use this
// module so the "At LIVE sizing" column cannot drift from what would actually be risked.
// Defaults match the agreed policy: 3% base, conviction 2×/0.5×, 6% ceiling.

export const LIVE_RISK_DEFAULT_PCT = 3;
export const LIVE_RISK_CEILING_PCT = 6;
export const LIVE_RISK_FLOOR_PCT = 0.1;

export type ConvictionTier = "low" | "med" | "high";

export function convictionMultiplier(tier: string | null | undefined): number {
  if (tier === "high") return 2;
  if (tier === "low") return 0.5;
  return 1; // med, null, unknown — never treat unverified as high
}

export function parseLiveRiskBasePct(raw: number | null | undefined): number {
  if (raw == null || !Number.isFinite(raw) || raw <= 0) return LIVE_RISK_DEFAULT_PCT;
  return Math.min(LIVE_RISK_CEILING_PCT, Math.max(LIVE_RISK_FLOOR_PCT, raw));
}

/** Percent of equity risked on this trade (e.g. 3, 6, 1.5). */
export function liveRiskPct(basePct: number, tier: string | null | undefined): number {
  return Math.min(LIVE_RISK_CEILING_PCT, parseLiveRiskBasePct(basePct) * convictionMultiplier(tier));
}

/** Same as liveRiskPct but as a fraction (0.03). Used by both sizers. */
export function liveRiskFraction(basePct: number, tier: string | null | undefined): number {
  return liveRiskPct(basePct, tier) / 100;
}

/**
 * Leverage CAP grows with the account. Risk % does not.
 *
 * Dollar risk is always equity × 3% (6% high-conviction ceiling). A larger book
 * therefore takes larger dollar bets at the same percentage — that is how a $5k
 * account becomes a $50k account without changing the risk model. The cap only
 * decides how much notional that dollar-risk is allowed to buy (tighter stops
 * need more leverage to spend the same risk budget).
 *
 *   ~$5k  → 5×   raised from 2× on 2026-09-09 (Spencer's decision, see below)
 *   ~$10k → 5×
 *   ~$20k → 5×   still well inside Kraken's 5–20× pair limits
 *
 * Unreadable / non-positive equity fails closed to LEV_CAP_AT_5K — never "treat
 * missing as large." The operator key kraken_margin_max_leverage is a CEILING on
 * this ladder (default 5); it cannot raise leverage above the rung the equity has
 * earned.
 *
 * ⚠️ WHY THE $5k RUNG WENT 2× → 5× (2026-09-09, Spencer's call, logged to the arm log).
 * Leverage does NOT change dollar risk here: notional = risk × equity ÷ stop, so the
 * SAME position is placed either way and the stop still bounds the loss at 3%/6% of
 * equity. What leverage changes is the MARGIN POSTED for that notional — at 2× a
 * paper-sized trade posts half its notional, and two of them consume the whole account,
 * which is why the second slot was being clipped and a third was impossible. At 5× the
 * same trades post 20%, so three run at full size with the account margin level HIGHER
 * (222%) than two did at 2× (133%). Kraken calls at 80% and liquidates at 40% on the
 * ACCOUNT level, so this is not the riskier configuration by that measure.
 * The genuine cost: 3 slots is ~50% more gross exposure than 2, and crypto longs
 * correlate in a selloff — a gap through three 4% stops loses more than through two.
 * That is the trade Spencer accepted; the stop, the daily loss cap and the 15%
 * drawdown breaker are all unchanged and still bound the downside.
 */
export const LEV_CAP_AT_5K = 5;
export const LEV_CAP_AT_10K = 5;
export const LEV_CAP_AT_20K = 5;
export const LEV_EQUITY_10K = 10_000;
export const LEV_EQUITY_20K = 20_000;
export const DEFAULT_MAX_LEVERAGE = 5; // operator ceiling on the ladder

/**
 * How many live positions the executor will ever hold at once.
 *
 * The arm switch already clamped its input to 3 (`Math.min(3, …)`) but the EXECUTOR had
 * no upper clamp at all — `Math.max(1, cfgNum("kraken_margin_max_positions", 3))` honours
 * whatever is in AgentConfig, so a fat-fingered "30" written directly to the key would
 * have been obeyed by the one gate that actually places orders. The two sites now read
 * the same constant, so the ceiling cannot be raised in one place and refused in another.
 */
export const MAX_LIVE_POSITIONS = 3;

/**
 * The account margin level a new entry must LEAVE BEHIND, in percent.
 *
 * 150 is not a new number — it is the line the guardian already calls "getting close to
 * the 80% margin-call line" (margin-watch step 3). Until now nothing stopped the executor
 * from opening the position that crossed it: size was capped at 90% of FREE margin, which
 * prevents a Kraken rejection but says nothing about the health of the book afterwards.
 *
 * This matters much more at 3 slots than it did at 2. Slot count and risk % multiply:
 * at 5× leverage and a 4% stop, three trades at 3% of equity each leave the account at
 * ~222%, while three at 6% each leave it at ~111% — a 6% adverse move from a margin call,
 * which crypto does on an ordinary Tuesday. Rather than pick a slot count and a risk %
 * that happen to be compatible and hope nobody edits one of them, the executor now refuses
 * the entry that would breach the floor. The account decides how many slots it can carry.
 *
 * Override with kraken_margin_min_margin_level (0 disables, for a deliberate operator).
 */
export const MIN_ENTRY_MARGIN_LEVEL = 150;

/**
 * Account margin level (equity ÷ margin used, in percent) AFTER adding a position of
 * `notional` at `leverage`. Infinity when the resulting book posts no margin at all.
 * Mirrors Kraken's own TradeBalance ml, which is the number it liquidates on.
 */
export function projectedMarginLevel(equity: number, marginUsedNow: number, notional: number, leverage: number): number {
  // Every input must be a real number. An Infinity equity (Kraken can hand back "1e309",
  // and TradeBalance's `parseFloat(...) || 0` preserves it) would otherwise return Infinity
  // and clear any floor — a bad read switching the guard OFF at the moment it is needed.
  // 0 = refuse, which is the safe direction for a gate that only ever blocks entries.
  if (!Number.isFinite(equity) || !Number.isFinite(marginUsedNow) || !Number.isFinite(notional) || !Number.isFinite(leverage)) return 0;
  if (!(leverage >= 1) || !(equity > 0) || !(notional > 0)) return 0;
  const after = Math.max(0, marginUsedNow) + notional / leverage;
  return after > 0 ? (equity / after) * 100 : 0;
}

/**
 * The most leverage at which a container's stop still fits inside clampLiveStopFrac.
 *
 * clampLiveStopFrac caps a stop at 0.6 × the liquidation cushion (0.6/leverage), so the
 * allowance is 0.36/leverage: 18% at 2×, 7.2% at 5×. Raising the ladder to 5× therefore
 * SILENTLY SHRINKS any container whose stop is wider than 7.2% — tsmom and tsmom-short
 * are 8%, so live would have run a 7.2% stop against a paper record scored at 8%. That is
 * precisely the live-vs-paper container drift the Sep 5 audit was written to end, arriving
 * through the leverage door instead of the stop door.
 *
 * So leverage yields to the container, never the other way round: a sleeve is run at the
 * highest leverage that still honours the stop it was scored with (floored at Kraken's
 * margin minimum of 2, which allows stops up to 18% and so binds for nothing we run).
 * 4% → 9×, 8% → 4×, 3% → 12×.
 */
export function leverageThatFitsStop(stopPct: number, leverage: number): number {
  const stopFrac = Number.isFinite(stopPct) && stopPct > 0 ? stopPct / 100 : LIVE_STOP_DEFAULT_PCT / 100;
  const fits = Math.floor(0.36 / stopFrac);
  return Math.max(2, Math.min(leverage, fits));
}

/**
 * The daily loss cap, DERIVED from equity and the current risk setting rather than frozen.
 *
 * Everything else on this desk scales with the account by construction: dollar risk is a
 * percentage of equity, position size is risk ÷ stop, and the drawdown breaker's peak
 * ratchets up as equity grows. The daily loss cap was the exception — the arm script
 * computed "two full high-conviction losses" ONCE and wrote the dollars to AgentConfig, so
 * it froze at the equity of the day it was armed. Double the account and the same two
 * losses no longer reach the cap; halve it and the cap stops protecting anything.
 *
 * So it is computed live from the same rule the arm script used: two full losses at the
 * risk currently configured, floored at $200.
 *
 * ⚠️ `overrideUsd` is `number | null`, and null — not 0 — is what means "derive". An
 * explicit 0 is HONOURED as a real zero cap, which blocks every new entry. That is the
 * documented behaviour of kraken_margin_daily_loss_cap (see the note above isBotPosition
 * in margin-executor.ts: `parseFloat(...) || default` once turned "daily_loss_cap=0" into
 * $200, and it was fixed deliberately). Treating 0 as "unset" here would re-introduce that
 * exact bug and quietly re-open a desk someone had switched off. Callers must pass null
 * when the key is missing, never 0.
 */
export const DAILY_LOSS_CAP_FLOOR_USD = 200;
export const DAILY_LOSS_CAP_FULL_LOSSES = 2;
export function dailyLossCapUsd(equity: number, baseRiskPct: number, overrideUsd: number | null = null): number {
  if (overrideUsd != null && Number.isFinite(overrideUsd)) return Math.max(0, overrideUsd);
  // Number.isFinite, not `> 0`: TradeBalance's parser preserves an absurd "1e309" as
  // Infinity, which sails past a `> 0` check and would make the cap Infinity — no cap at
  // all, on the one guard whose whole job is to stop a bad day.
  if (!Number.isFinite(equity) || !(equity > 0)) return DAILY_LOSS_CAP_FLOOR_USD;
  const highFrac = liveRiskFraction(baseRiskPct, "high");
  return Math.max(DAILY_LOSS_CAP_FLOOR_USD, Math.round(equity * highFrac * DAILY_LOSS_CAP_FULL_LOSSES));
}

/** True when the entry may proceed. floorPct <= 0 disables the check. */
export function entryKeepsMarginLevel(equity: number, marginUsedNow: number, notional: number, leverage: number, floorPct: number): boolean {
  if (!(floorPct > 0)) return true;
  return projectedMarginLevel(equity, marginUsedNow, notional, leverage) >= floorPct;
}

export function leverageCapForEquity(equity: number): number {
  if (!Number.isFinite(equity) || equity <= 0) return LEV_CAP_AT_5K;
  if (equity < LEV_EQUITY_10K) return LEV_CAP_AT_5K;
  if (equity < LEV_EQUITY_20K) return LEV_CAP_AT_10K;
  return LEV_CAP_AT_20K;
}

/** min(operator ceiling, equity ladder). cfgMax < 2 means "entries disabled" — returned as-is. */
export function effectiveMaxLeverage(cfgMax: number, equity: number): number {
  if (!(cfgMax >= 2)) return cfgMax;
  return Math.min(20, cfgMax, leverageCapForEquity(equity));
}

/**
 * Kraken OpenPositions can return [] during degradation while margin is still in use.
 * Treating that as "no conflict" would wave through an opposing entry that nets against
 * a hidden manual position. Fail closed.
 */
/**
 * An OpenPositions read that comes back EMPTY while the guardian's last run was still
 * managing a book is what a degraded Kraken read looks like, not a flat account. The admin
 * "live now" line must say "unconfirmed" in that case, never "no open position" (seen live
 * Sep 7 2026: Road to Live showed no position while a RENDER long was open at the broker).
 */
export function emptyReadIsUnconfirmed(openCount: number, guardianManagedCount: number): boolean {
  return openCount === 0 && guardianManagedCount > 0;
}

export function failClosedOnEmptyPositions(
  openCount: number,
  marginUsedRaw: number | null | undefined,
): boolean {
  return openCount === 0 && (marginUsedRaw == null || marginUsedRaw > 0);
}

export function pairHasExposure(
  symbol: string,
  openPairs: string[],
  restingPairs: string[],
  pairMatches: (a: string, b: string) => boolean,
): boolean {
  return openPairs.some((p) => pairMatches(p, symbol))
    || restingPairs.some((p) => pairMatches(p, symbol));
}

// ---------- THE CONTAINER — live mirrors the paper record's `selective` sleeve ----------
// Paper's live candidate: 3% initial stop, breakeven once +1R, then a 1R trail behind the
// peak, 48h time stop, notional = risk × equity ÷ stop (capped at leverage × equity).
// Until Sep 5 2026 the executor defaulted to a 15% stop (0.3/leverage), no trail, and a
// $100 per-trade cap — the same signal in a different container, which is exactly the
// class of gap the Sep 3 conviction fix closed one layer up. These constants are the
// single source both the executor and the guardian's managed exit read.
export const LIVE_STOP_DEFAULT_PCT = 3;      // = paper selective's oneR (entry × 0.03)
export const LIVE_MAX_HOLD_H = 48;           // = paper MAX_HOLD_H

/**
 * PER-SLEEVE LIVE CONTAINERS (Sep 8 2026). Live must reproduce the container each paper
 * sleeve was scored with — stop distance, time stop, entry style — or its record does not
 * transfer (the Sep 5 audit's live ≠ paper gap, found again when the two-slot desk needed a
 * slow sleeve in a 4% / 4-day container beside the fast 3% / 48h one). Keyed by source; an
 * unlisted source has NO live container and cannot be armed. Sleeves whose paper EXIT
 * differs from the guardian's (selective-tight's 0.5R trail, selective-launch's 8h close)
 * are deliberately absent until the guardian mirrors them. The values here are pinned by
 * test to margin-shadow's exitParams, so paper and live cannot drift apart silently.
 */
export interface LiveContainer { stopPct: number; maxHoldH: number; makerEntries: boolean | null }   // null = kraken_margin_maker_entries decides
const FAST: LiveContainer = { stopPct: 3, maxHoldH: 48, makerEntries: false };   // market entries: a post-only bid rarely fills a breakout
export const LIVE_CONTAINERS: Record<string, LiveContainer> = {
  selective: FAST, "selective-btc": FAST, "selective-majors": FAST, "selective-short": FAST, roundtrip: FAST,
  // "manual" (raw webhook alerts) is deliberately absent: paper scores it in the default
  // 0.3/leverage container, which the guardian does not mirror — so it cannot be armed.
  "swing-lev": { stopPct: 4, maxHoldH: 24 * 4, makerEntries: null },
  tsmom: { stopPct: 8, maxHoldH: 24 * 14, makerEntries: null },
  "tsmom-short": { stopPct: 8, maxHoldH: 24 * 14, makerEntries: null },
};
export function liveContainerFor(source: string | null | undefined): LiveContainer | null {
  if (!source) return null;
  if (source.startsWith("tv:")) return FAST;
  // Own properties only: "constructor" / "__proto__" pass the arm route's source regex and
  // would otherwise resolve to Object.prototype members and read as armable.
  return Object.hasOwn(LIVE_CONTAINERS, source) ? LIVE_CONTAINERS[source] : null;
}
/**
 * A book's time stop = the shortest hold across its tranches, where a tranche with no
 * ledgered hold (every position entered before Sep 8 2026) counts as the global config.
 * So a legacy 48h position stacked with a new 96h one keeps its 48h — a tranche can never
 * be held LONGER than its own rule because a neighbour arrived with a longer one.
 */
export function bookMaxHoldH(hours: (number | null | undefined)[], fallback: number): number {
  const each = hours.map((h) => (h != null && Number.isFinite(h) && h > 0 ? h : fallback));
  return each.length ? Math.min(...each) : fallback;
}
export const LIVE_STOP_RATCHET_MIN_FRAC = 0.0005;   // move a resting stop only for ≥0.05% of price

/**
 * Notional exactly as paper's positionNotional: risk × equity ÷ stop distance, capped at
 * leverage × equity. `perTradeCapUsd` > 0 is an optional operator ceiling on margin
 * committed per entry (× leverage = notional); 0 means none — the default, because a
 * $100 cap silently turned 3% risk into ~0.6% and made the scoreboard's "At LIVE sizing"
 * column describe a trade the executor would never have placed.
 */
// Kraken's real limit is FREE margin, not equity: fees, spread and any open position
// eat into it. An order sized to exactly equity × leverage is rejected ("Insufficient
// margin") or fills at a ~100% margin level. So the size is also capped at
// MARGIN_HEADROOM of the free margin × leverage — a 6% trade on a $5k account at 2× asks
// for the whole account and gets ~90% of it instead of a rejection.
export const MARGIN_HEADROOM = 0.9;
export function liveNotional(equity: number, riskFrac: number, stopFrac: number, leverage: number, perTradeCapUsd = 0, freeMarginUsd: number | null = null): number {
  if (!(equity > 0) || !(riskFrac > 0) || !(stopFrac > 0) || !(leverage >= 1)) return 0;
  let notional = Math.min((riskFrac * equity) / stopFrac, equity * leverage);
  if (perTradeCapUsd > 0) notional = Math.min(notional, perTradeCapUsd * leverage);
  if (freeMarginUsd != null && Number.isFinite(freeMarginUsd)) notional = Math.min(notional, Math.max(0, freeMarginUsd) * MARGIN_HEADROOM * leverage);
  return notional;
}

/**
 * Paper's managed exit, as a pure function the guardian can apply to a real resting stop:
 * once the best price reached is ≥ +1R, the stop is at least breakeven and trails 1R
 * behind the peak; it only ever ratchets in the trade's favour. Returns the stop level
 * that should be resting now (unchanged when no ratchet is due).
 */
export function managedStopTarget(side: "long" | "short", entry: number, peak: number, currentStop: number, oneR: number): number {
  if (!(entry > 0) || !(oneR > 0) || !Number.isFinite(peak) || !Number.isFinite(currentStop)) return currentStop;
  const dir = side === "long" ? 1 : -1;
  const peakR = (dir * (peak - entry)) / oneR;
  if (peakR < 1) return currentStop;
  const trail = peak - dir * oneR;
  const candidate = dir > 0 ? Math.max(entry, trail) : Math.min(entry, trail);
  return dir > 0 ? Math.max(currentStop, candidate) : Math.min(currentStop, candidate);
}

/**
 * The ONE stop-distance clamp, shared by the executor (sizing + attached stop) and the
 * guardian (rescue stops, 1R seed). An explicit stop wider than 60% of the liquidation
 * cushion (0.6 × 0.6/leverage) could never fire — the position would liquidate first —
 * so it is held inside it: 18% at 2×, 12% at 3×, 7.2% at 5×. Floor 0.1%. The 3% default
 * survives every rung the ladder allows. Returns a FRACTION.
 */
export function clampLiveStopFrac(cfgPct: number, leverage: number): number {
  const liqDistance = 0.6 / Math.max(1, leverage);
  const raw = Number.isFinite(cfgPct) && cfgPct > 0 ? cfgPct / 100 : LIVE_STOP_DEFAULT_PCT / 100;
  return Math.min(0.5, 0.6 * liqDistance, Math.max(0.001, raw));
}

/**
 * A stop order must rest on the safe side of the CURRENT price by a real margin, AFTER
 * rounding to the pair's price decimals — a target that passes unrounded and rounds onto
 * the market price fires instantly as a market close. Returns the string to submit.
 */
export function roundedStopIsSafe(side: "long" | "short", target: number, px: number, decimals: number): { ok: boolean; priceStr: string } {
  const priceStr = target.toFixed(Math.max(0, decimals));
  const r = parseFloat(priceStr);
  if (!(px > 0) || !Number.isFinite(r) || !(r > 0)) return { ok: false, priceStr };
  const gap = side === "long" ? px - r : r - px;
  return { ok: gap >= px * LIVE_STOP_RATCHET_MIN_FRAC, priceStr };
}

/**
 * One order can fill in several tranches that Kraken reports as SEPARATE positions
 * sharing one ordertxid (115 real fills came from 72 orders). The container applies to
 * the ORDER: one stop for the whole volume, one 1R, one peak, one time stop. Volume is
 * summed, entry is volume-weighted, the age is the oldest fill's.
 */
export interface PositionLike { id: string; ordertxid: string; pair: string; side: "long" | "short"; vol: number; entryPrice: number; openedAt: string; leverage: number }
export interface PositionGroup { ordertxid: string; pair: string; side: "long" | "short"; vol: number; entryPrice: number; openedAt: string; newestOpenedAt: string; leverage: number; ids: string[] }
export function groupPositionsByOrder<T extends PositionLike>(positions: T[]): PositionGroup[] {
  const byOrder = new Map<string, PositionGroup>();
  for (const p of positions) {
    const key = `${p.ordertxid}|${p.pair}|${p.side}`;
    const g = byOrder.get(key);
    if (!g) {
      byOrder.set(key, { ordertxid: p.ordertxid, pair: p.pair, side: p.side, vol: p.vol, entryPrice: p.entryPrice, openedAt: p.openedAt, newestOpenedAt: Number.isFinite(new Date(p.openedAt || "").getTime()) ? p.openedAt : "", leverage: p.leverage, ids: [p.id] });
      continue;
    }
    const vol = g.vol + p.vol;
    g.entryPrice = vol > 0 ? (g.entryPrice * g.vol + p.entryPrice * p.vol) / vol : g.entryPrice;
    g.vol = vol;
    g.leverage = Math.max(g.leverage, p.leverage);
    if (p.openedAt && (!g.openedAt || new Date(p.openedAt).getTime() < new Date(g.openedAt).getTime())) g.openedAt = p.openedAt;
    // FIFO is per tranche: a manual fill that landed BETWEEN two of ours is older than the
    // second, so the group's close would hit it. The newest tranche's time is what the
    // FIFO guard must compare against.
    // Any tranche with an UNKNOWN time makes the group's ordering unknown ("" fails closed
    // in fifoWouldHitManual) — a silently dropped timestamp would defeat the FIFO guard.
    const pt = new Date(p.openedAt || "").getTime();
    const gt = new Date(g.newestOpenedAt || "").getTime();
    if (!Number.isFinite(pt) || !Number.isFinite(gt)) g.newestOpenedAt = "";
    else if (pt > gt) g.newestOpenedAt = p.openedAt;
    g.ids.push(p.id);
  }
  return [...byOrder.values()];
}

/**
 * Kraken spot margin nets FIFO: a reduce-only close on a pair reduces the OLDEST position
 * on that side first, whoever opened it. So a bot close must be refused when a NON-bot
 * position on the same pair and side is OLDER than the one being closed — the order would
 * hit Spencer's book, not the bot's. (A newer manual position is safe: the bot's is oldest.)
 */
export function fifoWouldHitManual(
  target: { pair: string; side: string; openedAt: string },
  all: { pair: string; side: string; openedAt: string }[],
  isOurs: (p: { pair: string; side: string; openedAt: string }) => boolean,
  samePair: (a: string, b: string) => boolean,
): boolean {
  // Fails CLOSED: an unparseable or equal timestamp on either side counts as "older" —
  // when we cannot prove the bot's position is the oldest, we do not send the order.
  const t = new Date(target.openedAt).getTime();
  return all.some((m) => {
    if (isOurs(m) || m.side !== target.side || !samePair(m.pair, target.pair)) return false;
    const mt = new Date(m.openedAt).getTime();
    return !Number.isFinite(t) || !Number.isFinite(mt) || mt <= t;
  });
}

/** True when `target` improves on `currentStop` by at least the ratchet threshold. */
export function stopNeedsRatchet(side: "long" | "short", currentStop: number, target: number, price: number): boolean {
  if (!(price > 0) || !Number.isFinite(target) || !Number.isFinite(currentStop)) return false;
  const improvement = side === "long" ? target - currentStop : currentStop - target;
  return improvement >= price * LIVE_STOP_RATCHET_MIN_FRAC;
}

/** Lock value is `${iso}#token`. Health UI must parse the iso, not Date(fullstring). */
export const EXEC_LOCK_TTL_MS = 330_000;

export function execLockHeldSince(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const iso = raw.split("#")[0]?.trim();
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? iso : null;
}

// ---------- SOURCE ARMING — the switch that lets a paper sleeve trade live ----------
// Every entry carries a SOURCE: "manual" (a hand-drawn TradingView alert), "tv:<name>" (a
// named TradingView strategy), or a scanner sleeve like "selective". Only sources listed in
// kraken_margin_live_sources (comma-separated) may place a real order; everything else is
// tracked on paper even when the executor is armed. Default: NOTHING is armed. This is the
// per-strategy gate the go-live plan calls "arm ONE strategy".
export function isSourceArmed(liveSourcesRaw: string | null | undefined, source: string | null | undefined): boolean {
  const src = (source ?? "manual").trim().toLowerCase();
  const list = (liveSourcesRaw ?? "").split(",").map((x) => x.trim().toLowerCase()).filter(Boolean);
  return src.length > 0 && list.includes(src);
}

/** A TradingView strategy name → source "tv:<name>", or null when absent/invalid. */
export function tvSource(strategyRaw: unknown): string | null {
  const s = String(strategyRaw ?? "").trim().toLowerCase();
  return /^[a-z0-9][a-z0-9_-]{0,31}$/.test(s) ? `tv:${s}` : null;
}
