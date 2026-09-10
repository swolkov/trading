// ROBINHOOD ASSIGNMENT AND EXERCISE RISK. PURE: no database, no network, no clock.
//
// WHY THIS EXISTS (Sep 10 2026). Until Level 3 this book only ever bought single calls, where
// the worst case is the premium and the broker's behaviour barely matters. Short legs change
// that. An American equity option can be assigned on ANY day, not just at expiry; Robinhood
// automatically exercises long options that finish $0.01 or more in the money; and it may
// force-close positions near expiry when it judges the account cannot cover them.
//
// THE RULE THIS MODULE ENFORCES IN SPIRIT: never let "the broker will probably handle it" be
// the risk-management plan. Every one of these outcomes is foreseeable from data we already
// have, so it gets checked and surfaced rather than discovered.
//
// THE ONE THAT MATTERS MOST ON A SMALL ACCOUNT is not assignment at all — it is EXERCISE. A
// $500 account holding one in-the-money $85 call is holding a claim on $8,500 of stock. If
// that call is auto-exercised the account cannot pay for the shares, and the position is
// liquidated on the broker's terms rather than ours. The book's 21-day floor is what
// normally prevents this; these checks are what notice when something has gone wrong with
// that, which on this desk means the scheduled agent stopped running.

export type RiskLevel = "none" | "watch" | "high";
export interface AssignmentRisk {
  level: Exclude<RiskLevel, "none">;
  code:
    | "exercise_capital"        // a long leg finishing ITM would need capital we do not have
    | "short_extrinsic_thin"    // the short leg has nothing left to lose by being exercised early
    | "ex_dividend_short_call"  // a dividend is worth more than the short call's remaining time value
    | "pin_risk"                // settling right at the short strike — assignment is a coin flip
    | "forced_close_window";    // inside the broker's own sellout window
  message: string;
}

/** Robinhood auto-exercises a long option finishing at least this far in the money. */
export const AUTO_EXERCISE_ITM = 0.01;
/** Below this much time value, a short leg's holder loses nothing by exercising early. */
export const THIN_EXTRINSIC = 0.10;
/** Within this fraction of the short strike at expiry, assignment is genuinely unpredictable. */
export const PIN_BAND = 0.01;
/** Robinhood begins closing positions it judges uncoverable inside roughly this many days. */
export const FORCED_CLOSE_DTE = 1;
/** Exercise capital is only worth raising once expiry is actually near. The book closes at a
 *  21-day floor, so warning from 30 days out catches the case this check exists for — the
 *  floor did NOT fire, which on this desk means the scheduled agent stopped — while staying
 *  silent through the 60-120 day hold where it would just be noise on every position. */
export const EXERCISE_WARN_DTE = 30;

export interface AssignmentInput {
  /** Long leg — always present. */
  longStrike: number;
  longIsCall: boolean;
  /** Short leg, when the position is a spread. */
  shortStrike?: number | null;
  /** Mid price of the short leg, used to derive its remaining time value. */
  shortMid?: number | null;
  spot: number;
  dte: number;
  contracts: number;
  accountEquityUsd: number;
  /** Days until the underlying trades ex-dividend, and the amount, when known. */
  daysToExDiv?: number | null;
  dividendAmount?: number | null;
}

/** Time value left in an option — its price minus what it is worth if exercised right now. */
export function extrinsicOf(mid: number, spot: number, strike: number, isCall: boolean): number {
  const intrinsic = isCall ? Math.max(0, spot - strike) : Math.max(0, strike - spot);
  return Math.max(0, mid - intrinsic);
}

/**
 * Every foreseeable assignment or exercise problem with this position, worst first.
 *
 * Returns an empty array when there is nothing to flag — which for a 60-120 day in-the-money
 * call held to a 21-day floor is the normal, expected answer.
 */
export function assessAssignment(p: AssignmentInput): AssignmentRisk[] {
  const out: AssignmentRisk[] = [];
  const hasShort = p.shortStrike != null;

  // ---- Exercise capital. The small-account killer. ----
  // A long call finishing in the money is exercised into 100 shares per contract. A spread's
  // short leg is assigned at the same time and offsets it, so the exposure there is the width
  // rather than the whole strike — but a NAKED long call on a $500 account is a claim on tens
  // of thousands of dollars of stock.
  const longItm = p.longIsCall ? p.spot > p.longStrike + AUTO_EXERCISE_ITM : p.spot < p.longStrike - AUTO_EXERCISE_ITM;
  if (longItm && !hasShort && p.longIsCall && p.dte <= EXERCISE_WARN_DTE) {
    const needed = p.longStrike * 100 * p.contracts;
    if (needed > p.accountEquityUsd) {
      out.push({
        level: p.dte <= 5 ? "high" : "watch",
        code: "exercise_capital",
        message:
          `In the money with ${p.dte}d left. If it is still ITM at expiry Robinhood exercises it automatically, ` +
          `which needs $${needed.toLocaleString()} to buy the shares against $${Math.round(p.accountEquityUsd).toLocaleString()} of equity. ` +
          `Close it before expiry — do not rely on the broker's forced-close to do it for you.`,
      });
    }
  }

  // ---- Early assignment on the short leg ----
  if (hasShort && p.shortMid != null) {
    const shortItm = p.longIsCall ? p.spot > (p.shortStrike as number) : p.spot < (p.shortStrike as number);
    const extrinsic = extrinsicOf(p.shortMid, p.spot, p.shortStrike as number, p.longIsCall);
    if (shortItm && extrinsic <= THIN_EXTRINSIC) {
      out.push({
        level: "high",
        code: "short_extrinsic_thin",
        message:
          `The short $${p.shortStrike} leg is in the money with only $${extrinsic.toFixed(2)} of time value left. ` +
          `Whoever owns it gives up almost nothing by exercising early, so assignment can land any day. ` +
          `Max loss still holds if both legs settle together, but the shares can arrive first.`,
      });
    }
    // A short CALL that is in the money before an ex-dividend date is the classic early
    // assignment: the holder exercises to capture the dividend whenever it exceeds the time
    // value they give up.
    if (p.longIsCall && shortItm && p.daysToExDiv != null && p.dividendAmount != null &&
        p.daysToExDiv >= 0 && p.daysToExDiv <= p.dte && p.dividendAmount > extrinsic) {
      out.push({
        level: "high",
        code: "ex_dividend_short_call",
        message:
          `Ex-dividend in ${p.daysToExDiv}d pays $${p.dividendAmount.toFixed(2)} against $${extrinsic.toFixed(2)} of time value ` +
          `left in the short $${p.shortStrike} call. Exercising early is worth more than holding it, so expect assignment.`,
      });
    }
    // ---- Pin risk ----
    if (p.dte <= 2 && Math.abs(p.spot - (p.shortStrike as number)) / p.spot <= PIN_BAND) {
      out.push({
        level: "high",
        code: "pin_risk",
        message:
          `Trading within ${(PIN_BAND * 100).toFixed(0)}% of the short $${p.shortStrike} strike with ${p.dte}d left. ` +
          `Whether that leg is assigned is close to a coin flip, and an unassigned short leaves an unhedged long overnight.`,
      });
    }
  }

  // ---- The broker's own window ----
  if (p.dte <= FORCED_CLOSE_DTE) {
    out.push({
      level: "watch",
      code: "forced_close_window",
      message:
        `${p.dte}d to expiry — inside the window where Robinhood may close this itself, at its timing and its price. ` +
        `Any exit worth having should already have happened.`,
    });
  }

  const rank = { high: 0, watch: 1 } as const;
  return out.sort((a, b) => rank[a.level] - rank[b.level]);
}

/** The single worst level across all findings — what a badge on the page shows. */
export function worstLevel(risks: AssignmentRisk[]): RiskLevel {
  if (risks.some((r) => r.level === "high")) return "high";
  if (risks.length) return "watch";
  return "none";
}
