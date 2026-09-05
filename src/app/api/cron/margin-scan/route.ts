import { prisma } from "@/lib/db";
import { sendNotification } from "@/lib/notifications";
import { scanUniverse, signalKey, scoreConviction, type ScanSignal } from "@/lib/margin-scanner";
import { evaluateShadowSignals, ensureShadowColumns, strategyBreakdown, shadowScore, SIM_VERSION, SIM_COHORT_SQL } from "@/lib/margin-shadow";
import { autoShadowPlans } from "@/lib/margin-auto-plans";
import { isUsMarginSymbol } from "@/lib/kraken-pairs";
import { executeAlert } from "@/lib/margin-executor";
import { isSourceArmed } from "@/lib/margin-live-risk";

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

  // AUTO-SHADOW: directional breakouts → paper trades, scored on real prices + honest
  // fees. Awareness/paper only — nothing here places a real order. Toggle off with
  // kraken_shadow_autotrack="false".
  //
  // Sep 4 2026 policy, tightened after the selective autopsy (59 resolved):
  // HIGH CONVICTION LONGS on 5m/15m, not stretched. Med/low, shorts, 1h/4h/1d, and
  // the retired sleeves do not auto-open. The conviction FORMULA is unchanged.
  //
  // Why longs only: selective buys 47 / 68% / +$6,595; sells 12 / 17% / −$3,187.
  // Why skip stretched: 20 trades, 50%, −$54 — buying the RSI extreme is a coin-flip.
  // Why 5m/15m: that's +$3,754 of the sleeve; 1h+4h is 12 trades −$346.
  // Why not "always profitable": the quality long cut is 19 trades, 79%, +$302 avg —
  // still one stop in five. Paper has to hold for 30+ trades and 7+ days before live.
  //
  // RETIRED — stop opening; exitParams stay so open trades resolve:
  //   'fast-tight'      Sep 1 — 2% stop, t=−4.2
  //   'sweep-fade'      Sep 3 — ICT/SMC fade, two cohorts, both losers
  //   'scanner'         Sep 4 — wide 6% spray, t=−2.0
  //   'selective-swing' Sep 4 — 5%/4d A/B, t=−3.8, give-back
  // PAUSED (not retired — sample too thin to call a loser, not the live candidate):
  //   'swing-lev' / 'swing-spot' — gathering, slightly negative; 4h is not this container.
  const opened: { symbol: string; side: string; tier: string }[] = [];
  const live: string[] = [];
  const armedSources = await prisma.agentConfig.findUnique({ where: { key: "kraken_margin_live_sources" } }).then((r) => r?.value ?? "").catch(() => "");
  try {
    const flag = await prisma.agentConfig.findUnique({ where: { key: "kraken_shadow_autotrack" } }).catch(() => null);
    if (flag?.value !== "false") {
      const levRow = await prisma.agentConfig.findUnique({ where: { key: "kraken_shadow_lev" } }).catch(() => null);
      const lev = Math.max(2, Math.min(20, levRow?.value ? parseFloat(levRow.value) : 5));
      // ensureShadowColumns creates the table AND the shadow_*/conviction columns read below.
      await ensureShadowColumns();
      for (const s of fresh) {
        if (!(s.price > 0)) continue;
        if (s.kind !== "breakout" && s.kind !== "breakdown") continue;
        const conv = scoreConviction(s, signals);
        const plans = autoShadowPlans(s.kind, s.timeframe, conv, lev);
        if (plans.length === 0) continue;
        const side: "buy" | "sell" = s.kind === "breakout" ? "buy" : "sell";
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
          // LIVE — only for a sleeve explicitly ARMED in kraken_margin_live_sources (the
          // go-live plan's "arm ONE strategy"). The executor applies every guard (arm
          // switch, validate-only, breaker, guardian freshness, universe, netting, sizing);
          // the paper row above is unaffected either way — paper keeps measuring.
          if (armedSources && isSourceArmed(armedSources, plan.source)) {
            try {
              const r = await executeAlert({ symbol: s.symbol, side, note, source: plan.source });
              live.push(`${s.symbol} ${plan.source}: ${r.executed ? "EXECUTED" : r.validated ? "validated" : "not sent"} — ${r.note.slice(0, 140)}`);
            } catch (e) { live.push(`${s.symbol} ${plan.source}: executor error ${String(e).slice(0, 100)}`); }
          }
        }
      }
    }
  } catch (e) {
    errors.push(`autoshadow: ${String(e).slice(0, 80)}`);
  }
  const autoOpened = opened.length;
  if (live.length) await sendNotification(`💸 LIVE executor (armed sources: ${armedSources}):\n${live.map((l) => `• ${l}`).join("\n")}`, "margin_urgent").catch(() => {});

  await saveState(state);

  // Resolve any tracked TradingView signals that hit their stop/target/time limit, and
  // notify the would-be result — "that ETH long would have made +$X / stopped −$Y".
  let shadowResolved = 0;
  try {
    const resolutions = await evaluateShadowSignals();   // risk-based sizing read from config inside
    shadowResolved = resolutions.length;
    // Every open trade resolves (including the winding-down non-US ones), but the Slack
    // tally must describe the RECORD the scoreboard keeps — the cloud routines read these
    // posts as the record. So the headline counts and net cover US-tradeable pairs only;
    // non-US results are listed separately and labelled, never folded into the total.
    const counted = resolutions.filter((r) => isUsMarginSymbol(r.symbol));
    const setAside = resolutions.filter((r) => !isUsMarginSymbol(r.symbol));
    const fmtLine = (r: (typeof resolutions)[number]) =>
      `• ${r.symbol} ${r.side.toUpperCase()} ${r.leverage}x${r.conviction ? ` [${r.conviction}]` : ""}: ${r.pnl >= 0 ? "+" : "−"}$${Math.abs(r.pnl).toFixed(2)} (${r.reason})`;
    if (resolutions.length > 10) {
      // A burst (market-wide move stopping many trades at once) becomes ONE message —
      // per-trade posts at this volume risk Slack rate limits and eat the cron's budget.
      const total = counted.reduce((s, r) => s + r.pnl, 0);
      const wins = counted.filter((r) => r.pnl >= 0).length;
      const lines = counted.slice(0, 12).map(fmtLine).join("\n");
      const more = counted.length > 12 ? `\n…and ${counted.length - 12} more` : "";
      const aside = setAside.length > 0
        ? `\n_Set aside (non-US pairs, not in the record): ${setAside.length} resolved, net ${setAside.reduce((s, r) => s + r.pnl, 0) >= 0 ? "+" : "−"}$${Math.abs(setAside.reduce((s, r) => s + r.pnl, 0)).toFixed(0)}._`
        : "";
      await sendNotification(
        `📊 ${counted.length} paper trades resolved this run (US-tradeable pairs) — ${wins} green, net ${total >= 0 ? "+" : "−"}$${Math.abs(total).toFixed(0)}:\n${lines}${more}${aside}\n` +
        `Estimate — fees+rollover modeled; no real money moved.`,
        "margin_results",
      );
    } else {
      for (const r of resolutions) {
        const win = r.pnl >= 0;
        const conv = r.conviction ? ` [${r.conviction} conviction]` : "";
        const tag = isUsMarginSymbol(r.symbol) ? "" : " ⚠️ non-US pair — winding down, NOT in the record";
        await sendNotification(
          `📊 Tracked ${r.symbol} ${r.side.toUpperCase()} ${r.leverage}x${conv} from $${r.entry.toLocaleString()} → ` +
          `${win ? "✅ WOULD PROFIT" : "❌ WOULD LOSE"} ~${win ? "+" : "−"}$${Math.abs(r.pnl).toFixed(2)} ` +
          `(${(r.pnlPct * 100).toFixed(1)}%, ${r.reason}).${tag} Estimate — fees+rollover modeled; no real money moved.`,
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
      `👁 Opened ${autoOpened} tracked paper trade${autoOpened > 1 ? "s" : ""} from high-conviction 5m/15m longs:\n${lines}\n` +
      `Longs only, not stretched. Paper only, no money moved.`,
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
      // Keyed per measurement cohort AND per universe revision: v2 restarted the counters,
      // and the Sep 5 US-universe fix shrank the record from 266 to 96 resolved — the old
      // `margin_milestone_v2_100_reported` flag had already fired on the pooled count, so
      // without the `us` revision the corrected 100-trade report could never send.
      const flagKey = `margin_milestone_${SIM_VERSION}_us_${milestone}_reported`;
      const flag = await prisma.agentConfig.findUnique({ where: { key: flagKey } }).catch(() => null);
      if (flag?.value === "true") continue;
      const strats = await strategyBreakdown();
      const lines = strats.filter((s) => s.resolved > 0).map((s) => {
        const net = s.totalPnl;
        return `${s.label}: ${s.resolved} res, ${s.hitRate != null ? (s.hitRate * 100).toFixed(0) : "—"}% win · GROSS ${s.grossPnl >= 0 ? "+" : ""}$${s.grossPnl.toFixed(0)} − fees $${s.fees.toFixed(0)} = NET ${net >= 0 ? "+" : ""}$${net.toFixed(0)} → *${s.verdict}*`;
      }).join("\n");
      await sendNotification(
        `📊 *MILESTONE — ${score.resolved} resolved paper trades* (US-tradeable pairs only — the universe live can run). Verdict per strategy (net of fees, statistically judged):\n${lines}\n\n` +
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
