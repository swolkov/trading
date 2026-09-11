import { prisma } from "@/lib/db";
import { sendNotification } from "@/lib/notifications";
import { pickContractFor, scanTrendSignals } from "@/lib/options-scanner";
import {
  autotrackEnabled, bookStateFor, evaluateOptionsPaper, openOptionPaperTrade, optionsSleeveBreakdown, refEquityFor,
} from "@/lib/options-shadow";
import { EARNINGS_BLACKOUT_DAYS, MAX_BOOK_PCT, OPTIONS_SIM_VERSION, OPTION_SOURCES, dteOf, inEarningsBlackout, isBearishSource, positionBudget } from "@/lib/options-paper-model";
import { getEarningsCalendar } from "@/lib/finnhub";

// THE OPTIONS PAPER BOOK — the run itself, extracted from the cron route so that the
// scheduled Robinhood agent and the Vercel cron execute the SAME code rather than two
// drifting copies. Robinhood quotes arrive through the agent-pushed inbox, so the agent
// needs to be able to trigger a scan locally the moment it has filled a chain request;
// without this extraction it would have to re-implement the entry loop, and the two would
// diverge the first time either changed.
//
// Called from: /api/cron/options-scan (once a day after the close) and
// scripts/options-rh-agent.ts (after the agent pushes fresh quotes).
//
// Originally documented as: once a day after the close (vercel.json: 0 22 * * 1-5, which is
// 6pm ET in summer and 5pm ET in winter, comfortably past 4pm either way).
//
// WHY DAILY AND NOT EVERY 15 MINUTES, like the other books: the measured round-trip spread
// on the tradeable contracts is 2.2-2.9%, roughly 8x the Kraken desk's 0.34%. At 4-6 round
// trips a month, spread alone costs 12-17% of the account monthly and no edge survives it.
// The frequency IS the strategy here, so the schedule enforces it: one look a day, at most
// two entries per sleeve per month, holds of 60-120 days.
//
// This route never places an order anywhere. It reads Yahoo daily bars for the trend
// signal, reads option quotes from the agent-pushed inbox (`options_quote_snapshots` —
// Robinhood has no server credentials, so quotes cannot be fetched from here), writes to
// its own `options_paper_trades` table, and touches nothing belonging to the Kraken margin
// system. When a signal needs a chain that is not in the inbox, this route FILES A REQUEST
// and takes no entry that tick; the scheduled agent fills it and the next run proceeds.
export interface OptionsScanResult {
  ok: true; simVersion: string; scanned: number;
  trendSignals: string[]; freshSignals: string[]; staleSkipped: number;
  resolved: number; opened: string[]; refused: string[]; tracking: boolean;
  sleeves: { key: string; resolved: number; open: number; net: number; verdict: string }[];
  errors: string[];
}

/** ET calendar date, for the staleness check below. */
function etDate(at: Date): string {
  const p = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(at);
  const g = (t: string) => p.find((x) => x.type === t)?.value ?? "";
  return `${g("year")}-${g("month")}-${g("day")}`;
}

export async function runOptionsScan(): Promise<OptionsScanResult> {
  await prisma.agentConfig.upsert({
    where: { key: "options_scan_last_run" },
    update: { value: new Date().toISOString() },
    create: { key: "options_scan_last_run", value: new Date().toISOString() },
  }).catch(() => {});

  const errors: string[] = [];

  // RESOLVE FIRST. Open positions are the record; they get the first slice of the budget so
  // a slow scan can never starve the exits.
  let resolvedCount = 0;
  try {
    const res = await evaluateOptionsPaper();
    resolvedCount = res.length;
    if (res.length) {
      const net = res.reduce((s, r) => s + r.pnl, 0);
      const lines = res.map((r) =>
        `• ${r.symbol} ${r.source}: ${r.pnl >= 0 ? "+" : "−"}$${Math.abs(r.pnl).toFixed(0)} (${(r.pnlPct * 100).toFixed(0)}% of capital at risk, ${r.reason})`).join("\n");
      await sendNotification(
        `🧾 ${res.length} options paper position${res.length === 1 ? "" : "s"} closed — net ${net >= 0 ? "+" : "−"}$${Math.abs(net).toFixed(0)}:\n${lines}\n_Paper record. Entry paid the real ask, exit received the real bid. No money moved._`,
        "options",
      );
    }
  } catch (e) { errors.push(`evaluate: ${String(e).slice(0, 120)}`); }

  const { candidates, scanned, errors: scanErrors } = await scanTrendSignals();
  errors.push(...scanErrors.slice(0, 5));

  // STALENESS GATE, in place of a holiday calendar. The signal reads the last DAILY bar, so
  // on a weekend or a holiday the newest bar is Friday's and the same breakout would fire
  // again every run. Entries are allowed only when the last bar is TODAY in ET — which is
  // self-validating: it uses the data itself rather than a hand-maintained holiday list that
  // silently rots each December.
  const today = etDate(new Date());
  const fresh = candidates.filter((c) => c.bars[c.bars.length - 1]?.t?.slice(0, 10) === today);
  const stale = candidates.length - fresh.length;

  const opened: string[] = [];
  const refused: string[] = [];
  const tracking = await autotrackEnabled();

  // EARNINGS BLACKOUT. One calendar fetch for the whole run (the window is the same for every
  // candidate), then each entry is checked against it. getEarningsCalendar swallows its own
  // errors into [] — and a 14-day window across the US market is never genuinely empty — so
  // an empty result means the FETCH failed, not that nobody reports. The gate then cannot
  // run. This book measures; it does not gamble on a missing feed by refusing every entry
  // for a Finnhub blip, but it must not pretend the gate was applied either. So the run
  // proceeds and records `earningsGate: "unavailable"`, which is visible on the page.
  const now = new Date();
  let earningsCal: { symbol: string; date: string }[] = [];
  if (tracking && fresh.length) {
    const to = new Date(now.getTime() + (EARNINGS_BLACKOUT_DAYS + 1) * 86_400_000).toISOString().slice(0, 10);
    earningsCal = (await getEarningsCalendar(now.toISOString().slice(0, 10), to)).map((e) => ({ symbol: e.symbol, date: e.date }));
  }
  const earningsGate: "applied" | "unavailable" | "not needed" = !tracking || !fresh.length ? "not needed" : earningsCal.length ? "applied" : "unavailable";
  if (earningsGate === "unavailable") errors.push(`earnings calendar returned nothing for the next ${EARNINGS_BLACKOUT_DAYS} days — gate NOT applied this run`);

  if (tracking) {
    for (const source of OPTION_SOURCES) {
      const refEquity = await refEquityFor(source);
      // A sleeve only sees signals of its own direction. The bearish sleeves are a SEPARATE
      // experiment on the mirrored rule; letting a long breakout open a bearish position (or
      // the reverse) would make both records meaningless.
      const wantBearish = isBearishSource(source);
      for (const cand of fresh.filter((c) => (c.direction === "bearish") === wantBearish)) {
        // Spend only what the book can actually commit right now: the per-position budget,
        // capped by the room left under the book premium cap. Selecting against the position
        // budget alone would pick a contract the book then refuses, silently skipping an
        // entry a cheaper qualifying contract could have taken.
        // Do not buy premium into a print. Checked BEFORE the chain request so a blocked name
        // costs no API call. Only meaningful when the calendar actually loaded (see above).
        if (earningsGate === "applied") {
          const eb = inEarningsBlackout(cand.symbol, earningsCal, now);
          if (eb.blocked) { refused.push(`${cand.symbol} ${source}: earnings ${eb.date} inside the ${EARNINGS_BLACKOUT_DAYS}-day blackout`); continue; }
        }
        const book = await bookStateFor(source);
        const spendable = Math.min(positionBudget(refEquity), refEquity * MAX_BOOK_PCT - book.openPremium);
        if (spendable <= 0) { refused.push(`${cand.symbol} ${source}: book premium cap`); continue; }
        let pick;
        try {
          pick = await pickContractFor(cand.symbol, cand.close, spendable, cand.direction);
        } catch (e) { errors.push(`${cand.symbol} chain: ${String(e).slice(0, 80)}`); continue; }
        if (!pick) { refused.push(`${cand.symbol} ${source}: no contract passes filters`); continue; }
        const dte = dteOf(pick.contract.expiry, new Date());
        const r = await openOptionPaperTrade({
          symbol: cand.symbol, source, occ: pick.contract.occ, strike: pick.contract.strike,
          expiry: pick.contract.expiry, ask: pick.contract.ask, bid: pick.contract.bid, delta: pick.contract.delta,
          iv: pick.iv, spreadPct: pick.spreadPct, costUsd: pick.costUsd, underlying: cand.close,
          structure: pick.structure, creditUsd: pick.creditUsd, crossingUsd: pick.crossingUsd,
          shortOcc: pick.short?.occ, shortStrike: pick.short?.strike,
          shortBid: pick.short?.bid, shortAsk: pick.short?.ask, widthUsd: pick.widthUsd,
        });
        if (r.opened) {
          const LABEL: Record<string, string> = {
            call: "call", put: "put",
            call_spread: "call debit spread", put_spread: "put debit spread",
            put_credit_spread: "put credit spread", call_credit_spread: "call credit spread",
          };
          // A credit spread is quoted short-strike-first, the way it is traded.
          const strikes = pick.short
            ? (pick.creditUsd > 0
                ? `$${pick.short.strike}/$${pick.contract.strike}`
                : `$${pick.contract.strike}/$${pick.short.strike}`)
            : `$${pick.contract.strike}`;
          const legs = `${strikes} ${LABEL[pick.structure] ?? pick.structure}`;
          const money = pick.creditUsd > 0
            ? `$${pick.creditUsd.toFixed(0)} credit, $${r.costUsd.toFixed(0)} at risk`
            : `$${r.costUsd.toFixed(0)}${pick.widthUsd ? `, max $${pick.widthUsd.toFixed(0)}` : ""}`;
          opened.push(`${cand.symbol} ${source} ${legs} ${pick.contract.expiry} — ${money}, ${pick.spreadPct.toFixed(1)}% spread, ${dte}d`);
        } else {
          refused.push(`${cand.symbol} ${source}: ${r.reason}`);
        }
      }
    }
  }

  if (opened.length) {
    await sendNotification(
      `📈 Options paper book opened ${opened.length} position${opened.length === 1 ? "" : "s"}:\n${opened.map((o) => `• ${o}`).join("\n")}\n_In-the-money options on a 50-day breakout — long book on new highs, short book on new lows. Paper only — no order was placed._`,
      "options",
    );
  }

  // PERSIST THE RUN, refusals included. Without this the record only ever shows what was
  // BOUGHT — and the single most important output of this experiment is what the $1k sleeve
  // could NOT buy. A refusal that exists only in an HTTP response nobody reads is not a
  // finding, it is a rumour.
  // Built ONCE: the direction tag has to be on the persisted record too, not just the HTTP
  // response. A stored "ON, CCL" that omits "(short)" reads as two bullish breakouts on a day
  // the market was falling — the page would say the opposite of what happened.
  const withDirection = (cs: typeof candidates) =>
    cs.map((c) => `${c.symbol}${c.direction === "bearish" ? " (short)" : ""}`);
  const lastResult = JSON.stringify({
    at: new Date().toISOString(), scanned,
    signals: withDirection(candidates), fresh: withDirection(fresh),
    opened, refused, earningsGate,
  });
  await prisma.agentConfig.upsert({
    where: { key: "options_scan_last_result" },
    update: { value: lastResult },
    create: { key: "options_scan_last_result", value: lastResult },
  }).catch(() => {});

  const sleeves = await optionsSleeveBreakdown().catch(() => []);
  return {
    ok: true, simVersion: OPTIONS_SIM_VERSION, scanned,
    trendSignals: candidates.map((c) => `${c.symbol}${c.direction === "bearish" ? " (short)" : ""}`),
    freshSignals: fresh.map((c) => `${c.symbol}${c.direction === "bearish" ? " (short)" : ""}`), staleSkipped: stale,
    resolved: resolvedCount, opened, refused: refused.slice(0, 20), tracking,
    sleeves: sleeves.map((s) => ({ key: s.key, resolved: s.resolved, open: s.open, net: s.totalPnl, verdict: s.verdict })),
    errors: errors.slice(0, 10),
  };
}
