import { prisma } from "@/lib/db";
import { sendNotification } from "@/lib/notifications";
import { scanUniverse, signalKey, scoreConviction, type ScanSignal } from "@/lib/margin-scanner";
import { evaluateShadowSignals, ensureShadowColumns, strategyBreakdown, shadowScore, SIM_VERSION, SIM_COHORT_SQL } from "@/lib/margin-shadow";

// The margin opportunity scanner — every 15 minutes (vercel.json), 24/7. Watches every
// liquid margin coin across 15m/1h/4h/daily and pushes NEW notable technical events to
// Slack + a log the cockpit reads. Awareness only: it never places an order.
export const maxDuration = 300;
export const dynamic = "force-dynamic";

const STATE_KEY = "margin_scan_state";
const TABLE_SQL = `CREATE TABLE IF NOT EXISTS margin_scan_signals (
  id serial PRIMARY KEY,
  ts timestamptz DEFAULT now(),
  coin text,
  timeframe text,
  kind text,
  detail text,
  price double precision
)`;

interface State { fired: Record<string, string> }

async function loadState(): Promise<State> {
  try {
    const row = await prisma.agentConfig.findUnique({ where: { key: STATE_KEY } });
    if (row?.value) return JSON.parse(row.value) as State;
  } catch { /* fresh */ }
  return { fired: {} };
}

async function saveState(state: State): Promise<void> {
  // Prune entries older than 3 days so the map can't grow without bound.
  const cutoff = Date.now() - 3 * 24 * 3600_000;
  for (const [k, v] of Object.entries(state.fired)) {
    if (new Date(v).getTime() < cutoff) delete state.fired[k];
  }
  const value = JSON.stringify(state);
  await prisma.agentConfig.upsert({
    where: { key: STATE_KEY },
    update: { value },
    create: { key: STATE_KEY, value },
  }).catch(() => {});
}

export async function GET(request: Request) {
  const authHeader = request.headers.get("authorization");
  if (!process.env.CRON_SECRET || authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  await prisma.agentConfig.upsert({
    where: { key: "margin_scan_last_run" },
    update: { value: new Date().toISOString() },
    create: { key: "margin_scan_last_run", value: new Date().toISOString() },
  }).catch(() => {});

  const state = await loadState();
  const { signals, errors } = await scanUniverse();

  // Keep only signals whose exact (coin, timeframe, kind) has not fired inside its
  // re-alert window — so a persistent condition pings once, not every 15 minutes.
  const fresh: ScanSignal[] = [];
  for (const s of signals) {
    const key = signalKey(s);
    const last = state.fired[key];
    if (!last || Date.now() - new Date(last).getTime() > s.realertMs) {
      fresh.push(s);
      state.fired[key] = new Date().toISOString();
    }
  }

  // Log fresh signals for the cockpit.
  if (fresh.length) {
    try {
      await prisma.$executeRawUnsafe(TABLE_SQL);
      for (const s of fresh) {
        await prisma.$executeRawUnsafe(
          `INSERT INTO margin_scan_signals (coin, timeframe, kind, detail, price) VALUES ($1,$2,$3,$4,$5)`,
          s.coin, s.timeframe, s.kind, s.detail, s.price,
        );
      }
    } catch (e) {
      errors.push(`log: ${String(e).slice(0, 80)}`);
    }
  }

  // One batched Slack message per run, not one ping per signal.
  if (fresh.length) {
    const lines = fresh
      .slice(0, 20)
      .map((s) => `• ${s.coin} ${s.timeframe}: ${s.detail} ($${s.price.toLocaleString()})`)
      .join("\n");
    const more = fresh.length > 20 ? `\n…and ${fresh.length - 20} more` : "";
    await sendNotification(`🔎 Margin scan — ${fresh.length} new signal${fresh.length > 1 ? "s" : ""}:\n${lines}${more}`, "margin_signals");
  }

  // AUTO-SHADOW: turn the scanner's DIRECTIONAL breakouts into paper trades so the
  // scoreboard fills itself — a defined, consistent strategy ("trade scanner breakouts
  // with managed exits") scored on real prices + honest fees, no manual alerts needed.
  // Only breakout→buy / breakdown→sell (a coherent momentum thesis); RSI/volume/near-
  // extreme signals are context, not entries. One open auto-trade per coin at a time so
  // it can't stack. Awareness/paper only — nothing here places a real order; these rows
  // land with executed=false and are scored by evaluateShadowSignals exactly like a
  // tracked TradingView alert. Toggle off with kraken_shadow_autotrack="false".
  const opened: { symbol: string; side: string; tier: string }[] = [];
  try {
    const flag = await prisma.agentConfig.findUnique({ where: { key: "kraken_shadow_autotrack" } }).catch(() => null);
    if (flag?.value !== "false") {
      const levRow = await prisma.agentConfig.findUnique({ where: { key: "kraken_shadow_lev" } }).catch(() => null);
      const lev = Math.max(2, Math.min(20, levRow?.value ? parseFloat(levRow.value) : 5));
      // ensureShadowColumns creates the table AND the shadow_*/conviction columns read below.
      await ensureShadowColumns();
      for (const s of fresh) {
        let side: "buy" | "sell" | null = null;
        let plans: { source: string; lev: number }[] = [];
        const higher = s.timeframe === "4h" || s.timeframe === "1d";
        if (s.kind === "breakout" || s.kind === "breakdown") {
          // Momentum. Intraday breaks → fast (wide 6% stop). Higher-TF breaks → the two
          // swings (leveraged vs spot). Each strategy applies its own exit profile.
          // 'fast-tight' (2% stop) RETIRED Sep 1 2026 by verdict: 32 resolved, net −$4.1k,
          // t=−4.2 — statistically a loser (tight stops + high frequency = fee/whipsaw bleed).
          // Its exit profile stays in exitParams so already-open trades resolve and its
          // record remains on the scoreboard as evidence. Do not re-add without a new thesis.
          side = s.kind === "breakout" ? "buy" : "sell";
          plans = higher
            ? [{ source: "swing-lev", lev }, { source: "swing-spot", lev: 1 }]
            : [{ source: "scanner", lev }];
        }
        // 'sweep-fade' (the ICT/SMC liquidity-sweep test) RETIRED Sep 3 2026 by verdict,
        // on BOTH measurement cohorts independently: v1 78 resolved, net −$3.9k, t=−3.4;
        // v2 44 resolved, net −$4.2k, t=−6.0. 122 trades, two simulators, same answer —
        // fading swept levels does not pay on crypto margin either. This closes the SMC
        // question that futures already answered (see the SMC-is-a-coin-flip finding):
        // liq-sweep signals are still SCANNED and logged as context, they just no longer
        // open paper trades. Do not re-add without a genuinely new thesis, not a reskin.
        if (!side || plans.length === 0 || !(s.price > 0)) continue;
        // Conviction from confluence across ALL signals this run (not just fresh) — how many
        // independent things agree. Tested, not assumed. Same for each plan.
        const conv = scoreConviction(s, signals);
        // SELECTIVE — only the HIGHEST-conviction breakouts (the "really good ones"). Far fewer
        // entries → far less fee drag, so the small greens survive. The fee-drag view will show
        // whether trading ONLY the best beats trading everything, at Spencer's real fees — the
        // exact "fewer, better trades vs 20-30/day" question. Momentum only, not sweeps.
        if ((s.kind === "breakout" || s.kind === "breakdown") && conv.tier === "high") {
          plans.push({ source: "selective", lev });
        }
        for (const plan of plans) {
          // One open trade per (strategy, coin) so entries can't stack within a strategy.
          // Cohort-scoped: a winding-down v1 trade must not block the v2 cohort's first
          // entry on that coin for days — that would seed the new sample in a non-random
          // order (whichever v1 trades resolve first, which correlates with volatility).
          // The two simulations share no state; coexisting paper trades are harmless.
          const [{ n }] = await prisma.$queryRawUnsafe<{ n: bigint }[]>(
            `SELECT count(*)::bigint AS n FROM tradingview_alerts
             WHERE symbol=$1 AND source=$2 AND COALESCE(shadow_status,'open')='open' AND ${SIM_COHORT_SQL}`,
            s.symbol, plan.source,
          );
          if (Number(n) > 0) continue;
          const note = `auto: ${plan.source} ${s.kind} ${s.timeframe} [${conv.tier}${conv.factors.length ? ` — ${conv.factors.join(", ")}` : ""}]`;
          // ENTRY CHASE (realism): a 5-min scan spots a break late, and a live order
          // chases it — so every paper entry pays 0.1% of adverse price, instead of
          // pretending to fill instantly at the signal price (the classic paper-trading
          // flattery). Sweep-fades pay it too: a passive limit into a rejection has the
          // opposite problem (adverse selection — it fills most reliably when the fade
          // is failing), and exempting one strategy from the cost would bias the exact
          // head-to-head comparison the scoreboard exists to make.
          const chase = 0.001;
          const entryPx = side === "buy" ? s.price * (1 + chase) : s.price * (1 - chase);
          await prisma.$executeRawUnsafe(
            `INSERT INTO tradingview_alerts (symbol, side, leverage, note, mark_price, executed, validated, conviction, conviction_score, source, sim_version)
             VALUES ($1,$2,$3,$4,$5,false,false,$6,$7,$8,$9)`,
            s.symbol, side, plan.lev, note, entryPx, conv.tier, conv.score, plan.source, SIM_VERSION,
          );
          opened.push({ symbol: s.symbol, side, tier: conv.tier });
        }
      }
    }
  } catch (e) {
    errors.push(`autoshadow: ${String(e).slice(0, 80)}`);
  }
  const autoOpened = opened.length;

  await saveState(state);

  // Resolve any tracked TradingView signals that hit their stop/target/time limit, and
  // notify the would-be result — "that ETH long would have made +$X / stopped −$Y".
  let shadowResolved = 0;
  try {
    const resolutions = await evaluateShadowSignals();   // risk-based sizing read from config inside
    shadowResolved = resolutions.length;
    if (resolutions.length > 10) {
      // A burst (market-wide move stopping many trades at once) becomes ONE message —
      // per-trade posts at this volume risk Slack rate limits and eat the cron's budget.
      const total = resolutions.reduce((s, r) => s + r.pnl, 0);
      const wins = resolutions.filter((r) => r.pnl >= 0).length;
      const lines = resolutions.slice(0, 12).map((r) =>
        `• ${r.symbol} ${r.side.toUpperCase()} ${r.leverage}x${r.conviction ? ` [${r.conviction}]` : ""}: ${r.pnl >= 0 ? "+" : "−"}$${Math.abs(r.pnl).toFixed(2)} (${r.reason})`,
      ).join("\n");
      const more = resolutions.length > 12 ? `\n…and ${resolutions.length - 12} more` : "";
      await sendNotification(
        `📊 ${resolutions.length} paper trades resolved this run — ${wins} green, net ${total >= 0 ? "+" : "−"}$${Math.abs(total).toFixed(0)}:\n${lines}${more}\n` +
        `Estimate — fees+rollover modeled; no real money moved.`,
        "margin_results",
      );
    } else {
      for (const r of resolutions) {
        const win = r.pnl >= 0;
        const conv = r.conviction ? ` [${r.conviction} conviction]` : "";
        await sendNotification(
          `📊 Tracked ${r.symbol} ${r.side.toUpperCase()} ${r.leverage}x${conv} from $${r.entry.toLocaleString()} → ` +
          `${win ? "✅ WOULD PROFIT" : "❌ WOULD LOSE"} ~${win ? "+" : "−"}$${Math.abs(r.pnl).toFixed(2)} ` +
          `(${(r.pnlPct * 100).toFixed(1)}%, ${r.reason}). Estimate — fees+rollover modeled; no real money moved.`,
          "margin_results",
        );
      }
    }
  } catch (e) {
    errors.push(`shadow: ${String(e).slice(0, 80)}`);
  }

  if (autoOpened) {
    const lines = opened
      .map((o) => `• ${o.symbol} ${o.side.toUpperCase()} — ${o.tier} conviction`)
      .join("\n");
    await sendNotification(
      `👁 Opened ${autoOpened} tracked paper trade${autoOpened > 1 ? "s" : ""} from scanner breakouts:\n${lines}\n` +
      `Scored to a win/loss automatically — conviction = how many signals agree. Paper only, no money moved.`,
      "margin_results",
    );
  }

  // MILESTONE CHECK-IN: when the resolved count crosses a threshold (30 = first readable
  // signal, 100 = the arming-gate sample), post the Gross-vs-Fees-vs-Net scoreboard to Slack
  // ONCE per milestone (flagged in agentConfig so it never repeats). This is the "report it to
  // me when there's real data" — the answer comes to Spencer instead of him having to check.
  try {
    const score = await shadowScore();
    for (const milestone of [30, 100]) {
      if (score.resolved < milestone) continue;
      // Keyed per measurement cohort: v2 restarted the counters, so it earns its own
      // 30/100 check-ins instead of inheriting v1's already-fired flags.
      const flagKey = `margin_milestone_${SIM_VERSION}_${milestone}_reported`;
      const flag = await prisma.agentConfig.findUnique({ where: { key: flagKey } }).catch(() => null);
      if (flag?.value === "true") continue;
      const strats = await strategyBreakdown();
      const lines = strats.filter((s) => s.resolved > 0).map((s) => {
        const net = s.totalPnl;
        return `${s.label}: ${s.resolved} res, ${s.hitRate != null ? (s.hitRate * 100).toFixed(0) : "—"}% win · GROSS ${s.grossPnl >= 0 ? "+" : ""}$${s.grossPnl.toFixed(0)} − fees $${s.fees.toFixed(0)} = NET ${net >= 0 ? "+" : ""}$${net.toFixed(0)} → *${s.verdict}*`;
      }).join("\n");
      await sendNotification(
        `📊 *MILESTONE — ${score.resolved} resolved paper trades.* Verdict per strategy (net of fees, statistically judged):\n${lines}\n\n` +
        `Verdicts: "REAL EDGE" = positive net + statistically significant (t≥2, not luck). "promising" = positive but could be luck — needs more. ` +
        `Overall net $${score.totalPnl.toFixed(0)}. Still 100% paper. Arming only when a strategy hits REAL EDGE over a large sample — never on luck.`,
        "margin_results",
      );
      await prisma.agentConfig.upsert({ where: { key: flagKey }, update: { value: "true" }, create: { key: flagKey, value: "true" } }).catch(() => {});
    }
  } catch (e) {
    errors.push(`milestone: ${String(e).slice(0, 60)}`);
  }

  if (errors.length) console.error("[/api/cron/margin-scan]", errors.slice(0, 5));
  return Response.json({ ok: errors.length === 0, scanned: signals.length, fresh: fresh.length, autoOpened, shadowResolved, errors: errors.slice(0, 5) });
}
