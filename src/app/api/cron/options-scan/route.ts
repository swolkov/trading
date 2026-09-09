import { prisma } from "@/lib/db";
import { sendNotification } from "@/lib/notifications";
import { pickContractFor, scanTrendSignals } from "@/lib/options-scanner";
import {
  autotrackEnabled, bookStateFor, evaluateOptionsPaper, openOptionPaperTrade, optionsSleeveBreakdown, refEquityFor,
} from "@/lib/options-shadow";
import { MAX_BOOK_PCT, OPTIONS_SIM_VERSION, OPTION_SOURCES, dteOf, positionBudget } from "@/lib/options-paper-model";

// THE OPTIONS PAPER BOOK — once a day after the close (vercel.json: 0 22 * * 1-5, which is
// 6pm ET in summer and 5pm ET in winter, comfortably past 4pm either way).
//
// WHY DAILY AND NOT EVERY 15 MINUTES, like the other books: the measured round-trip spread
// on the tradeable contracts is 2.2-2.9%, roughly 8x the Kraken desk's 0.34%. At 4-6 round
// trips a month, spread alone costs 12-17% of the account monthly and no edge survives it.
// The frequency IS the strategy here, so the schedule enforces it: one look a day, at most
// two entries per sleeve per month, holds of 60-120 days.
//
// This route never places an order anywhere. It reads Alpaca market data with the PAPER
// key, writes to its own `options_paper_trades` table, and touches nothing belonging to the
// Kraken margin system.
export const maxDuration = 300;
export const dynamic = "force-dynamic";

/** ET calendar date, for the staleness check below. */
function etDate(at: Date): string {
  const p = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(at);
  const g = (t: string) => p.find((x) => x.type === t)?.value ?? "";
  return `${g("year")}-${g("month")}-${g("day")}`;
}

export async function GET(request: Request) {
  const authHeader = request.headers.get("authorization");
  if (!process.env.CRON_SECRET || authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }
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
        `• ${r.symbol} ${r.source}: ${r.pnl >= 0 ? "+" : "−"}$${Math.abs(r.pnl).toFixed(0)} (${(r.pnlPct * 100).toFixed(0)}% of premium, ${r.reason})`).join("\n");
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

  if (tracking) {
    for (const source of OPTION_SOURCES) {
      const refEquity = await refEquityFor(source);
      for (const cand of fresh) {
        // Spend only what the book can actually commit right now: the per-position budget,
        // capped by the room left under the book premium cap. Selecting against the position
        // budget alone would pick a contract the book then refuses, silently skipping an
        // entry a cheaper qualifying contract could have taken.
        const book = await bookStateFor(source);
        const spendable = Math.min(positionBudget(refEquity), refEquity * MAX_BOOK_PCT - book.openPremium);
        if (spendable <= 0) { refused.push(`${cand.symbol} ${source}: book premium cap`); continue; }
        let pick;
        try {
          pick = await pickContractFor(cand.symbol, cand.close, spendable);
        } catch (e) { errors.push(`${cand.symbol} chain: ${String(e).slice(0, 80)}`); continue; }
        if (!pick) { refused.push(`${cand.symbol} ${source}: no contract passes filters`); continue; }
        const dte = dteOf(pick.contract.expiry, new Date());
        const r = await openOptionPaperTrade({
          symbol: cand.symbol, source, occ: pick.contract.occ, strike: pick.contract.strike,
          expiry: pick.contract.expiry, ask: pick.contract.ask, bid: pick.contract.bid, delta: pick.contract.delta,
          iv: pick.iv, spreadPct: pick.spreadPct, costUsd: pick.costUsd, underlying: cand.close,
        });
        if (r.opened) {
          opened.push(`${cand.symbol} ${source} $${pick.contract.strike} ${pick.contract.expiry} — $${r.costUsd.toFixed(0)}, ${pick.spreadPct.toFixed(1)}% spread, ${pick.contract.delta.toFixed(2)} delta, ${dte}d`);
        } else {
          refused.push(`${cand.symbol} ${source}: ${r.reason}`);
        }
      }
    }
  }

  if (opened.length) {
    await sendNotification(
      `📈 Options paper book opened ${opened.length} position${opened.length === 1 ? "" : "s"}:\n${opened.map((o) => `• ${o}`).join("\n")}\n_In-the-money calls on a 50-day breakout. Paper only — no order was placed._`,
      "options",
    );
  }

  const sleeves = await optionsSleeveBreakdown().catch(() => []);
  return Response.json({
    ok: true, simVersion: OPTIONS_SIM_VERSION, scanned,
    trendSignals: candidates.map((c) => c.symbol), freshSignals: fresh.map((c) => c.symbol), staleSkipped: stale,
    resolved: resolvedCount, opened, refused: refused.slice(0, 20), tracking,
    sleeves: sleeves.map((s) => ({ key: s.key, resolved: s.resolved, open: s.open, net: s.totalPnl, verdict: s.verdict })),
    errors: errors.slice(0, 10),
  });
}
