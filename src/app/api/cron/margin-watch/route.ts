import { prisma } from "@/lib/db";
import { sendNotification } from "@/lib/notifications";
import { krakenConfigured, krakenOpenOrders, krakenCancelOrder } from "@/lib/kraken";
import {
  getKrakenMarginHealth,
  getKrakenMarginPositions,
  getKrakenOHLC,
  liquidationEstimate,
  syncKrakenTrades,
} from "@/lib/kraken-margin";
import { pairBase } from "@/lib/kraken-pairs";
import { macroEventWindows } from "@/lib/macro-events";
import { MARGIN_USERREF } from "@/lib/margin-executor";

// The margin guardian — runs every 5 minutes (vercel.json), 24/7.
//
// Spencer margin-trades by hand at up to 20x, where the liquidation line sits 3% away.
// This cron watches that line while he sleeps: it reads state and alerts, tracks the
// account drawdown circuit breaker, and reconciles the executor's OWN orders (cancels
// orphaned stops and stale unfilled entries — scoped strictly to MARGIN_USERREF, so it
// never touches a manual order). Kraken margin-calls at margin level 80%, liquidates at 40%.
export const maxDuration = 300;
export const dynamic = "force-dynamic";

// Alert throttling: each alert key re-fires at most once per hour, EXCEPT "urgent"
// margin-level alerts which re-fire every run — you want to be nagged at 3am when a
// position is about to liquidate.
const REALERT_MS = 60 * 60 * 1000;
const STATE_KEY = "margin_watch_state";

type WatchState = { alerts: Record<string, string> };

async function cfg(key: string): Promise<string | null> {
  const row = await prisma.agentConfig.findUnique({ where: { key } }).catch(() => null);
  return row?.value ?? null;
}
async function cfgNum(key: string, fallback: number): Promise<number> {
  const raw = await cfg(key);
  if (raw == null || raw.trim() === "") return fallback;
  const n = parseFloat(raw);
  return Number.isFinite(n) ? n : fallback;
}

async function loadState(): Promise<WatchState> {
  try {
    const row = await prisma.agentConfig.findUnique({ where: { key: STATE_KEY } });
    if (row?.value) return JSON.parse(row.value) as WatchState;
  } catch { /* fresh state */ }
  return { alerts: {} };
}

async function saveState(state: WatchState): Promise<void> {
  // Prune throttle entries older than 7 days so per-position keys don't accumulate
  // forever inside one AgentConfig row.
  const cutoff = Date.now() - 7 * 24 * 3600_000;
  for (const [k, v] of Object.entries(state.alerts)) {
    if (new Date(v).getTime() < cutoff) delete state.alerts[k];
  }
  const value = JSON.stringify(state);
  await prisma.agentConfig.upsert({
    where: { key: STATE_KEY },
    update: { value },
    create: { key: STATE_KEY, value },
  }).catch(() => {});
}

function shouldFire(state: WatchState, key: string, always = false): boolean {
  if (always) return true;
  const last = state.alerts[key];
  return !last || Date.now() - new Date(last).getTime() > REALERT_MS;
}

export async function GET(request: Request) {
  const authHeader = request.headers.get("authorization");
  if (!process.env.CRON_SECRET || authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const stamp = (key: string) =>
    prisma.agentConfig.upsert({
      where: { key },
      update: { value: new Date().toISOString() },
      create: { key, value: new Date().toISOString() },
    }).catch(() => {});

  await stamp("margin_watch_last_run");

  if (!krakenConfigured()) {
    return Response.json({ ok: true, note: "kraken not configured" });
  }

  const sent: string[] = [];
  const errors: string[] = [];
  const state = await loadState();

  // 1) Keep the trade history topped up (incremental — stops at the first fully-known page).
  try {
    await syncKrakenTrades(false);
    await stamp("margin_trades_synced_at");
  } catch (e) {
    errors.push(`trade sync: ${e}`);
  }

  // 2) Margin level vs the call/liquidation lines, + the account drawdown circuit breaker.
  let flat = true;
  try {
    const health = await getKrakenMarginHealth();

    // Drawdown circuit breaker: track peak equity; if equity falls more than
    // kraken_margin_max_drawdown_pct from the peak, DISARM new entries (the executor
    // reads kraken_margin_disarmed_dd). Re-arm automatically once equity recovers to
    // within half the threshold. This is the account-level stop that prevents a bad run
    // from compounding — the single most important "not lose" guard.
    if (health.equity > 0) {
      const ddPct = Math.max(1, await cfgNum("kraken_margin_max_drawdown_pct", 15)) / 100;
      const peakRow = await prisma.agentConfig.findUnique({ where: { key: "kraken_margin_equity_peak" } }).catch(() => null);
      let peak = peakRow?.value ? parseFloat(peakRow.value) : 0;
      if (health.equity > peak) {
        peak = health.equity;
        await prisma.agentConfig.upsert({
          where: { key: "kraken_margin_equity_peak" },
          update: { value: String(peak) },
          create: { key: "kraken_margin_equity_peak", value: String(peak) },
        }).catch(() => {});
      }
      const dd = peak > 0 ? (peak - health.equity) / peak : 0;
      const disarmed = (await cfg("kraken_margin_disarmed_dd")) === "true";
      if (!disarmed && dd >= ddPct) {
        await prisma.agentConfig.upsert({
          where: { key: "kraken_margin_disarmed_dd" }, update: { value: "true" }, create: { key: "kraken_margin_disarmed_dd", value: "true" },
        }).catch(() => {});
        await sendNotification(
          `🛑 DRAWDOWN CIRCUIT BREAKER — equity $${health.equity.toFixed(0)} is ${(dd * 100).toFixed(1)}% below peak $${peak.toFixed(0)} (limit ${(ddPct * 100).toFixed(0)}%). Auto-entries HALTED. Closes still allowed. Re-arms when recovered.`,
          "margin_urgent",
        );
        sent.push("dd-breaker-tripped");
      } else if (disarmed && dd < ddPct / 2) {
        await prisma.agentConfig.upsert({
          where: { key: "kraken_margin_disarmed_dd" }, update: { value: "false" }, create: { key: "kraken_margin_disarmed_dd", value: "false" },
        }).catch(() => {});
        await sendNotification(`✅ Drawdown recovered — equity $${health.equity.toFixed(0)}, ${(dd * 100).toFixed(1)}% below peak. Auto-entries RE-ARMED.`, "margin_urgent");
        sent.push("dd-breaker-rearmed");
      }
    }

    if (health.marginLevel != null) {
      flat = false;
      const ml = health.marginLevel;
      if (ml < 100) {
        // Below 100% the account is losing posted margin; 80% is Kraken's margin call.
        const key = "ml-urgent";
        if (shouldFire(state, key, true)) {
          await sendNotification(
            `🚨 MARGIN URGENT — margin level ${ml.toFixed(0)}% (Kraken calls at 80%, LIQUIDATES at 40%). ` +
            `Equity $${health.equity.toFixed(0)}, margin used $${health.marginUsed.toFixed(0)}. Reduce now.`,
            "margin_urgent",
          );
          state.alerts[key] = new Date().toISOString();
          sent.push(key);
        }
      } else if (ml < 150) {
        const key = "ml-warn";
        if (shouldFire(state, key)) {
          await sendNotification(
            `⚠️ Margin level ${ml.toFixed(0)}% — getting close to the 80% margin-call line. ` +
            `Equity $${health.equity.toFixed(0)}, free margin $${health.freeMargin.toFixed(0)}.`,
            "margin_urgent",
          );
          state.alerts[key] = new Date().toISOString();
          sent.push(key);
        }
      }
    }
  } catch (e) {
    errors.push(`health: ${e}`);
  }

  // 3) Per-position liquidation distance (an ESTIMATE — account margin level above is
  //    the authoritative trigger). Warns hourly at half the cushion gone and again at
  //    three quarters; a position we cannot price is an ERROR, not a silent skip.
  try {
    const positions = await getKrakenMarginPositions();
    flat = flat && positions.length === 0;
    if (positions.length) {
      const { krakenPublic } = await import("@/lib/kraken");
      const { publicPairFor } = await import("@/lib/kraken-pairs");
      let tick: Record<string, unknown> = {};
      // Venue-suffixed position pairs (XBTUSD:BTNL) must be priced via public pairs.
      try { tick = await krakenPublic("Ticker", { pair: [...new Set(positions.map((p) => publicPairFor(p.pair)))].join(",") }); } catch { tick = {}; }
      for (const p of positions) {
        const t = Object.entries(tick).find(([k]) => k === p.pair || pairBase(k) === pairBase(p.pair))?.[1] as { c?: string[] } | undefined;
        const px = t?.c?.[0] ? parseFloat(t.c[0]) : null;
        if (!px) { errors.push(`unable to price position ${p.pair} (${p.id})`); continue; }
        const { liqPrice, pctAway } = liquidationEstimate(p, px);
        const cushion = 0.6 / Math.max(1, p.leverage);   // full cushion at entry
        const used = 1 - pctAway / cushion;              // fraction of cushion consumed
        if (used >= 0.75) {
          const key = `liq-urgent-${p.id}`;
          if (shouldFire(state, key)) {
            await sendNotification(
              `🚨 ${p.pair} ${p.side.toUpperCase()} ${p.leverage.toFixed(0)}x — est. ${(pctAway * 100).toFixed(1)}% from liquidation (~$${liqPrice.toFixed(2)}, now $${px.toFixed(2)}). Account margin level is the hard number — check the cockpit.`,
              "margin_urgent",
            );
            state.alerts[key] = new Date().toISOString();
            sent.push(key);
          }
        } else if (used >= 0.5) {
          const key = `liq-warn-${p.id}`;
          if (shouldFire(state, key)) {
            await sendNotification(
              `⚠️ ${p.pair} ${p.side.toUpperCase()} ${p.leverage.toFixed(0)}x has used ${(used * 100).toFixed(0)}% of its cushion — liquidation $${liqPrice.toFixed(2)}, price $${px.toFixed(2)} (${(pctAway * 100).toFixed(1)}% away).`,
              "margin_urgent",
            );
            state.alerts[key] = new Date().toISOString();
            sent.push(key);
          }
        }
      }
    }
  } catch (e) {
    errors.push(`positions: ${e}`);
  }

  // 3b) Reconcile the EXECUTOR's own orders (scoped strictly to MARGIN_USERREF — manual
  //     orders are never touched). Two hazards this closes:
  //       • ORPHAN STOP — Spencer closes a position by hand; its attached stop lingers as
  //         a live order that could OPEN a fresh opposite position when triggered. Cancel
  //         any of our stop orders with no matching open position.
  //       • STALE ENTRY — a post-only limit entry that never filled. Cancel ours older
  //         than kraken_margin_stale_entry_min so cash/intent isn't left dangling.
  try {
    const orders = await krakenOpenOrders();
    const mine = orders.filter((o) => o.userref === MARGIN_USERREF);
    if (mine.length) {
      const positions = await getKrakenMarginPositions();
      // A protective stop is only valid if it CLOSES a live position: a sell-stop
      // protects a long, a buy-stop protects a short. Matching on pair alone would keep
      // an old long's sell-stop alive after a manual close even when a NEW short exists —
      // and that stray sell-stop would then ADD to the short if it triggered.
      const stopProtectsLive = (o: { pair: string; side: string }) => positions.some((p) =>
        pairBase(p.pair) === pairBase(o.pair) &&
        ((o.side === "sell" && p.side === "long") || (o.side === "buy" && p.side === "short")));
      const staleMin = Math.max(5, await cfgNum("kraken_margin_stale_entry_min", 30));
      const nowSec = Date.now() / 1000;
      for (const o of mine) {
        const isStop = o.ordertype.includes("stop");
        const isEntry = o.ordertype === "limit" || o.ordertype === "market";
        if (isStop && !stopProtectsLive(o)) {
          try { await krakenCancelOrder(o.txid); sent.push(`orphan-stop-cancelled-${o.pair}`); } catch { /* already gone */ }
        } else if (isEntry && (nowSec - o.opentm) > staleMin * 60) {
          try { await krakenCancelOrder(o.txid); sent.push(`stale-entry-cancelled-${o.pair}`); } catch { /* already gone */ }
        }
      }
    }
  } catch (e) {
    errors.push(`order reconcile: ${e}`);
  }

  // 4) Fast-move heads-up on the majors (±3% in an hour) — only worth checking when
  //    positions are open or Spencer is actively trading; cheap either way (public data).
  try {
    for (const symbol of ["BTC/USD", "ETH/USD", "SOL/USD"]) {
      const bars = await getKrakenOHLC(symbol, 5);
      if (bars.length < 13) continue;
      const now = bars[bars.length - 1].c;
      const hourAgo = bars[bars.length - 13].c;   // 12 × 5m = 1h
      const move = (now - hourAgo) / hourAgo;
      if (Math.abs(move) >= 0.03) {
        const dir = move > 0 ? "up" : "down";
        const key = `move-${symbol}-${dir}`;
        if (shouldFire(state, key)) {
          await sendNotification(
            `${move > 0 ? "📈" : "📉"} ${symbol} ${dir} ${(move * 100).toFixed(1)}% in the last hour ($${now.toLocaleString()}).`,
            "margin_signals",
          );
          state.alerts[key] = new Date().toISOString();
          sent.push(key);
        }
      }
    }
  } catch (e) {
    errors.push(`fast-move: ${e}`);
  }

  // 5) Event guardrail: levered into a high-impact macro print within 24h → one warning.
  //    Imported directly — an HTTP round-trip to our own API would be rejected by the
  //    auth proxy and fail silently forever.
  if (!flat) {
    try {
      const { imminent } = macroEventWindows(new Date());
      for (const e of imminent) {
        const key = `event-${e.name}-${e.date}`;
        if (shouldFire(state, key)) {
          await sendNotification(
            `📅 Heads up: ${e.name} lands ${e.date} ${e.time} and you have margin positions open. That print can move more than a 20x cushion.`,
            "margin_urgent",
          );
          state.alerts[key] = new Date().toISOString();
          sent.push(key);
        }
      }
    } catch (e) {
      errors.push(`event guardrail: ${e}`);
    }
  }

  await saveState(state);

  // Fail loudly: an unhealthy guardian is worse than none, because it feels like cover.
  if (errors.length) {
    console.error("[/api/cron/margin-watch]", errors);
    const key = "watch-errors";
    if (shouldFire(state, key)) {
      await sendNotification(`⚠️ margin-watch errors: ${errors.join(" | ").slice(0, 400)}`, "margin_urgent");
      state.alerts[key] = new Date().toISOString();
      await saveState(state);
    }
  }

  return Response.json({ ok: errors.length === 0, flat, sent, errors });
}
