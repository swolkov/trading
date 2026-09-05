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
 *   ~$5k  → 2×   US-retail margin, the live book
 *   ~$10k → 3×   after the account has actually grown
 *   ~$20k → 5×   still well inside Kraken's 5–20× pair limits
 *
 * Unreadable / non-positive equity fails closed to 2× — never "treat missing
 * as large." The operator key kraken_margin_max_leverage is a CEILING on this
 * ladder (default 5 so growth is possible); it cannot raise leverage above
 * the rung the equity has earned.
 */
export const LEV_CAP_AT_5K = 2;
export const LEV_CAP_AT_10K = 3;
export const LEV_CAP_AT_20K = 5;
export const LEV_EQUITY_10K = 10_000;
export const LEV_EQUITY_20K = 20_000;
export const DEFAULT_MAX_LEVERAGE = 5; // operator ceiling; ladder still holds $5k at 2×

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
export const LIVE_STOP_RATCHET_MIN_FRAC = 0.0005;   // move a resting stop only for ≥0.05% of price

/**
 * Notional exactly as paper's positionNotional: risk × equity ÷ stop distance, capped at
 * leverage × equity. `perTradeCapUsd` > 0 is an optional operator ceiling on margin
 * committed per entry (× leverage = notional); 0 means none — the default, because a
 * $100 cap silently turned 3% risk into ~0.6% and made the scoreboard's "At LIVE sizing"
 * column describe a trade the executor would never have placed.
 */
export function liveNotional(equity: number, riskFrac: number, stopFrac: number, leverage: number, perTradeCapUsd = 0): number {
  if (!(equity > 0) || !(riskFrac > 0) || !(stopFrac > 0) || !(leverage >= 1)) return 0;
  let notional = Math.min((riskFrac * equity) / stopFrac, equity * leverage);
  if (perTradeCapUsd > 0) notional = Math.min(notional, perTradeCapUsd * leverage);
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
