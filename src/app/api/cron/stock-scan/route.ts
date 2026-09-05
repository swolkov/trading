import { prisma } from "@/lib/db";
import { sendNotification } from "@/lib/notifications";
import { isRTH } from "@/lib/session-time";
import { scanStockUniverse, scoreConviction, stockSignalKey, type ScanSignal } from "@/lib/stock-scanner";
import { ensureStockPaperTable, evaluateStockPaper, openStockPaperTrade, stockScore, stockStrategyBreakdown } from "@/lib/stock-shadow";
import { STOCK_SIM_VERSION, STOCK_UNIVERSE, stockPaperPlans } from "@/lib/stock-paper-model";

// THE STOCK PAPER BOOK — every 15 minutes during regular hours (vercel.json), Mon–Fri.
// Scans 30 liquid, marginable US names on 5m/15m/1h/1d with the crypto desk's signal
// detectors, posts fresh signals to Slack, opens PAPER longs on high-conviction breakouts,
// walks open paper trades over 1-minute bars, and reports outcomes. It never touches
// Robinhood: there is no official way to place a margin stock order from code (Agentic
// Trading is cash-only, long-only today), so this book is the record that decides whether
// there is anything worth wiring up if and when Robinhood enables it. Spencer can take any
// signal by hand in his own margin account; that is his call, trade by trade.
export const maxDuration = 300;
export const dynamic = "force-dynamic";

const STATE_KEY = "stock_scan_state";
interface State { fired: Record<string, string> }

async function loadState(): Promise<State> {
  try {
    const row = await prisma.agentConfig.findUnique({ where: { key: STATE_KEY } });
    if (row?.value) return JSON.parse(row.value) as State;
  } catch { /* fresh */ }
  return { fired: {} };
}
async function saveState(state: State): Promise<void> {
  const cutoff = Date.now() - 3 * 24 * 3600_000;
  for (const [k, v] of Object.entries(state.fired)) if (new Date(v).getTime() < cutoff) delete state.fired[k];
  const value = JSON.stringify(state);
  await prisma.agentConfig.upsert({ where: { key: STATE_KEY }, update: { value }, create: { key: STATE_KEY, value } }).catch(() => {});
}

export async function GET(request: Request) {
  const authHeader = request.headers.get("authorization");
  if (!process.env.CRON_SECRET || authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }
  await prisma.agentConfig.upsert({
    where: { key: "stock_scan_last_run" },
    update: { value: new Date().toISOString() },
    create: { key: "stock_scan_last_run", value: new Date().toISOString() },
  }).catch(() => {});

  // Regular session only. The cron's UTC window covers both DST offsets; this is the
  // exact gate (9:30–16:00 ET, weekdays, not a holiday). Outside it there are no new
  // bars, no fills, and nothing to score — a Robinhood stop rests in the session too.
  if (!isRTH()) return Response.json({ ok: true, skipped: "market closed" });

  const errors: string[] = [];
  const state = await loadState();
  const { signals, errors: scanErrors } = await scanStockUniverse();
  errors.push(...scanErrors);

  // Re-alert dedupe per (symbol, timeframe, kind), same as the crypto scan.
  const fresh: ScanSignal[] = [];
  for (const s of signals) {
    const key = stockSignalKey(s);
    const last = state.fired[key];
    if (!last || Date.now() - new Date(last).getTime() > s.realertMs) {
      fresh.push(s);
      state.fired[key] = new Date().toISOString();
    }
  }

  if (fresh.length) {
    try {
      await ensureStockPaperTable();
      for (const s of fresh) {
        await prisma.$executeRawUnsafe(
          `INSERT INTO stock_scan_signals (symbol, timeframe, kind, detail, price) VALUES ($1,$2,$3,$4,$5)`,
          s.coin, s.timeframe, s.kind, s.detail, s.price,
        );
      }
    } catch (e) { errors.push(`log: ${String(e).slice(0, 80)}`); }
  }

  // Paper entries: high-conviction breakouts, longs only, not stretched — the sleeve is
  // chosen by the timeframe that fired. One open trade per (sleeve, symbol).
  const opened: { symbol: string; source: string; tier: string; tf: string }[] = [];
  try {
    const flag = await prisma.agentConfig.findUnique({ where: { key: "stock_paper_autotrack" } }).catch(() => null);
    if (flag?.value !== "false") {
      for (const s of fresh) {
        if (!(s.price > 0) || s.kind !== "breakout") continue;
        const conv = scoreConviction(s, signals);
        for (const source of stockPaperPlans(s.kind, s.timeframe, conv)) {
          const ok = await openStockPaperTrade({ symbol: s.coin, source, timeframe: s.timeframe, conviction: conv.tier, score: conv.score, signalPrice: s.price });
          if (ok) opened.push({ symbol: s.coin, source, tier: conv.tier, tf: s.timeframe });
        }
      }
    }
  } catch (e) { errors.push(`paper: ${String(e).slice(0, 80)}`); }

  await saveState(state);

  // One Slack post per run for signals; paper entries are the actionable line at the top
  // (these are the ones he might take by hand — the record will say whether he should).
  if (fresh.length || opened.length) {
    const openedLines = opened.map((o) => `▶ PAPER LONG ${o.symbol} (${o.source}, ${o.tf}, ${o.tier} conviction)`).join("\n");
    const lines = fresh.slice(0, 20).map((s) => `• ${s.coin} ${s.timeframe}: ${s.detail} ($${s.price.toLocaleString()})`).join("\n");
    const more = fresh.length > 20 ? `\n…and ${fresh.length - 20} more` : "";
    await sendNotification(
      `📈 Stock scan — ${fresh.length} new signal${fresh.length === 1 ? "" : "s"}${opened.length ? `, ${opened.length} paper entr${opened.length === 1 ? "y" : "ies"}` : ""}:\n${openedLines ? openedLines + "\n" : ""}${lines}${more}\n_Paper only — nothing is placed at Robinhood. Awareness for your own margin account._`,
      "stocks",
    );
  }

  // Resolve open paper trades and report outcomes.
  let resolvedCount = 0;
  try {
    const res = await evaluateStockPaper();
    resolvedCount = res.length;
    if (res.length) {
      const total = res.reduce((s, r) => s + r.pnl, 0);
      const wins = res.filter((r) => r.pnl >= 0).length;
      const lines = res.slice(0, 12).map((r) =>
        `• ${r.symbol} ${r.source}${r.conviction ? ` [${r.conviction}]` : ""}: ${r.pnl >= 0 ? "+" : "−"}$${Math.abs(r.pnl).toFixed(2)} (${(r.pnlPct * 100).toFixed(1)}%, ${r.reason})`).join("\n");
      await sendNotification(
        `📊 ${res.length} stock paper trade${res.length === 1 ? "" : "s"} resolved — ${wins} green, net ${total >= 0 ? "+" : "−"}$${Math.abs(total).toFixed(0)}:\n${lines}${res.length > 12 ? `\n…and ${res.length - 12} more` : ""}\n_Estimate — slippage + margin interest modeled; no real money moved._`,
        "stocks",
      );
    }
  } catch (e) { errors.push(`evaluate: ${String(e).slice(0, 80)}`); }

  // Milestone check-ins at 30 and 100 resolved, once each per cohort.
  try {
    const score = await stockScore();
    for (const milestone of [30, 100]) {
      if (score.resolved < milestone) continue;
      const flagKey = `stock_milestone_${STOCK_SIM_VERSION}_${milestone}_reported`;
      const flag = await prisma.agentConfig.findUnique({ where: { key: flagKey } }).catch(() => null);
      if (flag?.value === "true") continue;
      const strats = await stockStrategyBreakdown();
      const lines = strats.filter((s) => s.resolved > 0).map((s) =>
        `${s.label}: ${s.resolved} res, ${s.hitRate != null ? (s.hitRate * 100).toFixed(0) : "—"}% win · GROSS ${s.grossPnl >= 0 ? "+" : ""}$${s.grossPnl.toFixed(0)} − costs $${s.fees.toFixed(0)} = NET ${s.totalPnl >= 0 ? "+" : ""}$${s.totalPnl.toFixed(0)} → *${s.verdict}*`).join("\n");
      await sendNotification(
        `📊 *STOCK PAPER MILESTONE — ${score.resolved} resolved.* Verdict per sleeve (net of costs, statistically judged):\n${lines}\n\nSame ladder as the crypto desk: "REAL EDGE" = positive net, t≥2, 7+ distinct days. Still 100% paper — nothing at Robinhood.`,
        "stocks",
      );
      await prisma.agentConfig.upsert({ where: { key: flagKey }, update: { value: "true" }, create: { key: flagKey, value: "true" } }).catch(() => {});
    }
  } catch (e) { errors.push(`milestone: ${String(e).slice(0, 60)}`); }

  if (errors.length) console.error("[/api/cron/stock-scan]", errors.slice(0, 5));
  return Response.json({ ok: errors.length === 0, universe: STOCK_UNIVERSE.length, scanned: signals.length, fresh: fresh.length, opened: opened.length, resolved: resolvedCount, errors: errors.slice(0, 5) });
}
