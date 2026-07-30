"use client";

import useSWR from "swr";

/**
 * "Today's Plan" — what the LIVE engine intends to do today, and at what size.
 *
 * Every number here is rendered from the engine's own heartbeat snapshot. Nothing is recomputed in
 * the browser: a second copy of the ATR/size maths would drift from the engine and start lying.
 */

const fetcher = (u: string) => fetch(u).then((r) => r.json());

interface SymState {
  sym: string;
  price?: number; atr?: number; rsi?: number;
  ema9DistPct?: number | null; above200?: boolean | null;
  trend15?: string; dayType?: string; bars?: number;
  plannedQty?: number; quoteAgeSec?: number; quarantine?: number;
  snapshotAgeSec?: number | null; edgeArmedNow?: boolean;
}
interface PlanResp {
  engine: { alive: boolean; ageSec: number; session: string; mdHealth: string; positions: number; dailyTrades: number; dailyPnl: number } | null;
  risk: { equity: number; riskPerTrade: number | null; dailyLossLimit: number | null; maxTradesPerDay: number | null; maxContractsPerTrade: number | null } | null;
  schedule: { session: string; label: string; from: string; to: string; edges: { key: string; name: string }[]; tradable: boolean }[];
  symbols: SymState[];
  edges: { key: string; name: string; blurb: string; enabled: boolean }[];
}

/** Why is this symbol not able to open a trade right now? First blocking reason wins. */
function blockReason(s: SymState, session: string): { text: string; tone: "block" | "wait" | "ok" } {
  if (session === "halt") return { text: "market closed", tone: "wait" };
  // Checked FIRST: a size can be computable while no edge is armed for this symbol in this session,
  // and reading that as "ready to trade" would be wrong. Both must hold.
  if (s.edgeArmedNow === false) return { text: "no edge armed this session — sits out", tone: "wait" };
  if ((s.snapshotAgeSec ?? 0) > 600) return { text: `stale reading (${Math.round((s.snapshotAgeSec ?? 0) / 60)}m old — no bar closed)`, tone: "block" };
  if ((s.quoteAgeSec ?? 0) > 30) return { text: `no fresh quote (${s.quoteAgeSec}s old)`, tone: "block" };
  if ((s.quarantine ?? 0) > 0) return { text: `feed gap — ${s.quarantine} clean bars to go`, tone: "block" };
  if ((s.plannedQty ?? 0) < 1) return { text: "too volatile to size — stop wider than the risk budget", tone: "block" };
  const rsi = s.rsi ?? 50;
  if (s.sym === "MGC") {
    if (rsi <= 75 && rsi >= 25) return { text: `RSI ${rsi.toFixed(0)} — needs >75 or <25`, tone: "wait" };
  } else if (rsi > 65) {
    return { text: `RSI ${rsi.toFixed(0)} — trend-long needs 35–65 (pullback)`, tone: "wait" };
  } else if ((s.ema9DistPct ?? 9) >= 0.3) {
    return { text: `${(s.ema9DistPct ?? 0).toFixed(2)}% from EMA9 — needs <0.30%`, tone: "wait" };
  }
  return { text: "conditions met — waiting on confidence ≥75", tone: "ok" };
}

const money = (n: number | null | undefined) => (n == null ? "—" : `$${Math.round(n).toLocaleString()}`);

export default function TodaysPlan({ mode = "live" }: { mode?: "live" | "demo" }) {
  const { data } = useSWR<PlanResp>(`/api/futures/plan?mode=${mode}`, fetcher, { refreshInterval: 30000 });

  if (!data) return <div className="rounded-xl border p-4 text-sm text-muted-foreground">Loading today&apos;s plan…</div>;
  if (!data.engine) return <div className="rounded-xl border p-4 text-sm text-muted-foreground">No engine heartbeat yet.</div>;

  const { engine, risk, schedule, symbols, edges } = data;
  const armed = edges.filter((e) => e.enabled);
  const nowSession = engine.session;

  return (
    <div className="rounded-xl border bg-card p-4 space-y-5">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <h3 className="text-base font-semibold">Today&apos;s Plan · {mode.toUpperCase()}</h3>
          <p className="text-xs text-muted-foreground">
            What the engine intends today — rendered from its own numbers, not recalculated here.
          </p>
        </div>
        <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${engine.alive ? "bg-emerald-500/10 text-emerald-600" : "bg-red-500/10 text-red-600"}`}>
          {engine.alive ? `live · ${engine.ageSec}s ago` : `STALE · ${engine.ageSec}s`}
        </span>
      </div>

      {/* Risk budget */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
        {[
          ["Equity", money(risk?.equity)],
          ["Risk / trade", money(risk?.riskPerTrade)],
          ["Daily loss limit", money(risk?.dailyLossLimit)],
          ["Trades today", `${engine.dailyTrades} / ${risk?.maxTradesPerDay ?? "—"}`],
          ["Open positions", String(engine.positions)],
        ].map(([k, v]) => (
          <div key={k} className="rounded-lg bg-muted/40 px-3 py-2">
            <div className="text-[11px] uppercase tracking-wide text-muted-foreground">{k}</div>
            <div className="text-sm font-semibold tabular-nums">{v}</div>
          </div>
        ))}
      </div>

      {/* When it can trade */}
      <div>
        <div className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
          When it can trade today (ET)
        </div>
        <div className="space-y-1">
          {schedule.map((w) => {
            const isNow = w.session === nowSession;
            return (
              <div key={w.session}
                className={`flex flex-wrap items-center gap-2 rounded-lg px-3 py-1.5 text-sm ${
                  isNow ? "bg-primary/10 ring-1 ring-primary/30" : w.tradable ? "bg-muted/30" : "opacity-45"}`}>
                <span className="w-28 shrink-0 tabular-nums text-xs text-muted-foreground">{w.from}–{w.to}</span>
                <span className="w-20 shrink-0 font-medium">{w.label}</span>
                {isNow && <span className="rounded bg-primary/20 px-1.5 py-0.5 text-[10px] font-semibold uppercase">now</span>}
                {w.tradable
                  ? <span className="flex flex-wrap gap-1">
                      {w.edges.map((e) => (
                        <span key={e.key} className="rounded bg-emerald-500/10 px-1.5 py-0.5 text-[11px] text-emerald-700 dark:text-emerald-400">{e.name}</span>
                      ))}
                    </span>
                  : <span className="text-xs text-muted-foreground">no edges armed — sits out</span>}
              </div>
            );
          })}
        </div>
      </div>

      {/* Per symbol, right now */}
      <div>
        <div className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Right now — size it would take, and what it&apos;s waiting for
        </div>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[640px] text-sm">
            <thead>
              <tr className="border-b text-left text-[11px] uppercase tracking-wide text-muted-foreground">
                <th className="py-1.5 pr-3">Symbol</th>
                <th className="py-1.5 pr-3">Price</th>
                <th className="py-1.5 pr-3">ATR</th>
                <th className="py-1.5 pr-3">RSI</th>
                <th className="py-1.5 pr-3 text-center">Size now</th>
                <th className="py-1.5">Status</th>
              </tr>
            </thead>
            <tbody>
              {symbols.length === 0 && (
                <tr><td colSpan={6} className="py-3 text-xs text-muted-foreground">
                  Waiting for the engine to publish its first snapshot (one 5-minute bar).
                </td></tr>
              )}
              {symbols.map((s) => {
                const r = blockReason(s, nowSession);
                const tone = r.tone === "block" ? "text-red-600" : r.tone === "wait" ? "text-amber-600" : "text-emerald-600";
                return (
                  <tr key={s.sym} className="border-b last:border-0">
                    <td className="py-2 pr-3 font-medium">{s.sym}</td>
                    <td className="py-2 pr-3 tabular-nums">{s.price?.toFixed(2) ?? "—"}</td>
                    <td className="py-2 pr-3 tabular-nums">{s.atr?.toFixed(2) ?? "—"}</td>
                    <td className="py-2 pr-3 tabular-nums">{s.rsi?.toFixed(0) ?? "—"}</td>
                    <td className="py-2 pr-3 text-center">
                      <span className={`rounded px-2 py-0.5 font-semibold tabular-nums ${
                        (s.plannedQty ?? 0) > 0 && s.edgeArmedNow !== false
                          ? "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400"
                          : "bg-muted text-muted-foreground"}`}
                        title={s.edgeArmedNow === false ? "No edge armed this session — this size is what it WOULD use, not what it will do" : undefined}>
                        {s.plannedQty ?? 0}×
                      </span>
                    </td>
                    <td className={`py-2 text-xs ${tone}`}>{r.text}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <p className="mt-2 text-[11px] leading-relaxed text-muted-foreground">
          <strong>Size now</strong> is what the engine would take if a setup fired on this bar. It is solved
          backwards from the risk budget, so a <em>tighter</em> ATR buys <em>more</em> contracts at the same
          dollar risk — the cap ({risk?.maxContractsPerTrade ?? 4} in RTH, 2 overnight on gold) only ever trims it.
        </p>
      </div>

      {/* Armed edges */}
      <div>
        <div className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Edges armed ({armed.length} of {edges.length})
        </div>
        <div className="flex flex-wrap gap-1.5">
          {edges.map((e) => (
            <span key={e.key} title={e.blurb}
              className={`rounded px-2 py-0.5 text-[11px] ${e.enabled
                ? "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400"
                : "bg-muted text-muted-foreground line-through opacity-60"}`}>
              {e.name}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}
