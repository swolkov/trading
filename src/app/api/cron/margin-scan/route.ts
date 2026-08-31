import { prisma } from "@/lib/db";
import { sendNotification } from "@/lib/notifications";
import { scanUniverse, signalKey, scoreConviction, type ScanSignal } from "@/lib/margin-scanner";
import { evaluateShadowSignals, ensureShadowColumns } from "@/lib/margin-shadow";

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
        const side = s.kind === "breakout" ? "buy" : s.kind === "breakdown" ? "sell" : null;
        if (!side || !(s.price > 0)) continue;
        // Route by timeframe. Intraday breaks (5m/15m/1h) → the FAST strategy (leverage,
        // ≤2-day hold). Higher-timeframe breaks (4h/1d) are slower, bigger moves → open TWO
        // swings to compare: leveraged (rides a few days) and spot (1x, no carry, holds for
        // weeks). The evaluator applies each strategy's own stop/hold/carry profile.
        const higher = s.timeframe === "4h" || s.timeframe === "1d";
        // Intraday breaks run the fast A/B (wide 6% vs tight 2% stop) so the scoreboard can
        // pick the more profitable exit. Higher-TF breaks run the two swings (lev vs spot).
        const plans = higher
          ? [{ source: "swing-lev", lev }, { source: "swing-spot", lev: 1 }]
          : [{ source: "scanner", lev }, { source: "fast-tight", lev }];
        // Conviction from confluence across ALL signals this run (not just fresh) — how many
        // independent things agree behind this break. Tested, not assumed. Same for each plan.
        const conv = scoreConviction(s, signals);
        for (const plan of plans) {
          // One open trade per (strategy, coin) so entries can't stack within a strategy.
          const [{ n }] = await prisma.$queryRawUnsafe<{ n: bigint }[]>(
            `SELECT count(*)::bigint AS n FROM tradingview_alerts
             WHERE symbol=$1 AND source=$2 AND COALESCE(shadow_status,'open')='open'`,
            s.symbol, plan.source,
          );
          if (Number(n) > 0) continue;
          const note = `auto: ${plan.source} ${s.kind} ${s.timeframe} [${conv.tier}${conv.factors.length ? ` — ${conv.factors.join(", ")}` : ""}]`;
          await prisma.$executeRawUnsafe(
            `INSERT INTO tradingview_alerts (symbol, side, leverage, note, mark_price, executed, validated, conviction, conviction_score, source)
             VALUES ($1,$2,$3,$4,$5,false,false,$6,$7,$8)`,
            s.symbol, side, plan.lev, note, s.price, conv.tier, conv.score, plan.source,
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
    const perTrade = await prisma.agentConfig.findUnique({ where: { key: "kraken_margin_per_trade_usd" } })
      .then((r) => (r?.value ? parseFloat(r.value) : 100)).catch(() => 100);
    const resolutions = await evaluateShadowSignals(Number.isFinite(perTrade) ? perTrade : 100);
    shadowResolved = resolutions.length;
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

  if (errors.length) console.error("[/api/cron/margin-scan]", errors.slice(0, 5));
  return Response.json({ ok: errors.length === 0, scanned: signals.length, fresh: fresh.length, autoOpened, shadowResolved, errors: errors.slice(0, 5) });
}
