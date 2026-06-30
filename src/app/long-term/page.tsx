"use client";

import { useState } from "react";
import useSWR from "swr";

const fetcher = (url: string) => fetch(url).then((r) => r.json());

interface Holding {
  qty: number; avgPrice: number; currentPrice: number;
  marketValue: number; costBasis: number; unrealizedPl: number; unrealizedPlpc: number;
}
interface RecentBuy { at: string; reason: string; }
interface LongTerm {
  enabled: boolean; symbol: string; amountUsd: number; lastRun: string | null;
  schedule: string; holding: Holding | null; totalInvested: number;
  buyCount: number; recentBuys: RecentBuy[];
}

function money(v: number) { return (v < 0 ? "-$" : "$") + Math.abs(v).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
function pnlColor(v: number) { return v > 0 ? "text-emerald-400" : v < 0 ? "text-red-400" : "text-muted-foreground"; }
const when = (iso: string) => new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

function Stat({ label, value, sub, color }: { label: string; value: string; sub?: string; color?: string }) {
  return (
    <div className="rounded-xl border border-white/[0.06] bg-white/[0.02] p-4">
      <div className="text-[10px] font-semibold tracking-[0.12em] text-muted-foreground/50 uppercase">{label}</div>
      <div className={`mt-1.5 text-xl font-bold tabular-nums ${color || "text-foreground"}`}>{value}</div>
      {sub && <div className="mt-0.5 text-[11px] text-muted-foreground/60">{sub}</div>}
    </div>
  );
}

// Cumulative-invested curve, built from real buy timestamps (not fabricated P&L). Each scheduled
// buy steps the line up by its dollar amount. Needs ≥2 buys to draw; otherwise a clean placeholder.
function InvestedCurve({ buys, amount }: { buys: RecentBuy[]; amount: number }) {
  if (buys.length < 2) {
    return <div className="text-xs text-muted-foreground/60 py-8 text-center">A cumulative-invested curve appears once at least two weekly buys are on the books — {buys.length} so far.</div>;
  }
  // oldest → newest, running sum of the per-buy dollar amount
  const ordered = [...buys].reverse();
  let run = 0;
  const series = ordered.map(() => (run += amount));
  const W = 800, H = 140, pad = 6;
  const min = 0, max = Math.max(...series);
  const span = (max - min) || 1;
  const x = (i: number) => pad + (i / (series.length - 1)) * (W - 2 * pad);
  const y = (v: number) => H - pad - ((v - min) / span) * (H - 2 * pad);
  const pts = series.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ");
  return (
    <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="w-full h-32">
      <polyline points={pts} fill="none" stroke="#34d399" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}

export default function LongTermPage() {
  const { data, isLoading, mutate } = useSWR<LongTerm>("/api/longterm", fetcher, { refreshInterval: 30000 });
  const [toggling, setToggling] = useState(false);

  if (isLoading) return (
    <div className="space-y-5 animate-fade-up">
      <div><div className="skeleton h-6 w-56 rounded mb-2" /><div className="skeleton h-3 w-80 rounded" /></div>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">{Array.from({ length: 4 }).map((_, i) => <div key={i} className="rounded-xl border border-white/[0.06] bg-white/[0.02] p-4"><div className="skeleton h-3 w-14 rounded mb-2" /><div className="skeleton h-6 w-20 rounded" /></div>)}</div>
    </div>
  );

  const d = data;
  const h = d?.holding ?? null;
  const symbol = d?.symbol || "SPY";
  const amount = d?.amountUsd ?? 50;
  const invested = d?.totalInvested ?? 0;
  const buyCount = d?.buyCount ?? 0;
  const enabled = d?.enabled ?? false;
  const fresh = buyCount === 0 && !h;

  async function toggle() {
    if (!d) return;
    setToggling(true);
    try {
      await fetch("/api/longterm", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: !d.enabled }),
      });
      await mutate();
    } finally {
      setToggling(false);
    }
  }

  return (
    <div className="space-y-5 animate-fade-up">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-xl font-bold tracking-tight flex items-center gap-2">
            Long-term — S&amp;P Buy &amp; Hold
            <span className="text-[8px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded text-emerald-400/70 bg-emerald-500/[0.08]">Live · Real money</span>
          </h1>
          <p className="text-xs text-muted-foreground/60 mt-0.5">
            Dollar-cost average into {symbol} and hold. Harvests the ~8-10%/yr equity risk premium. <span className="text-foreground/70">Buy-only — never sells.</span>
          </p>
        </div>
        <div className="text-right text-[11px] text-muted-foreground/50">
          <div>{buyCount} buy{buyCount === 1 ? "" : "s"} placed</div>
          {d?.lastRun && <div>last run {when(d.lastRun)}</div>}
        </div>
      </div>

      {fresh ? (
        <div className="rounded-xl border border-white/[0.06] bg-white/[0.02] p-8 text-center space-y-3">
          <div className="text-sm text-muted-foreground/70">No long-term position yet — DCA hasn&apos;t started.</div>
          <div className="text-xs text-muted-foreground/50 max-w-md mx-auto">
            Enabling begins automatic weekly buys of {money(amount)} of {symbol} at the Monday open (real money). The position builds slowly and is held indefinitely.
          </div>
          <button
            onClick={toggle}
            disabled={toggling}
            className="mt-1 text-xs font-semibold px-3 py-1.5 rounded-lg border border-emerald-500/30 bg-emerald-500/[0.08] text-emerald-400 hover:bg-emerald-500/[0.14] transition-colors disabled:opacity-50"
          >
            {toggling ? "Saving…" : enabled ? "DCA enabled" : `Enable weekly ${money(amount)} buys`}
          </button>
        </div>
      ) : (
        <>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <Stat label="Total invested" value={money(invested)} sub={`${buyCount} buy${buyCount === 1 ? "" : "s"}`} />
            <Stat label="Current value" value={h ? money(h.marketValue) : "—"} sub={h ? `${symbol} held` : "no live position"} />
            <Stat
              label="Return"
              value={h ? `${h.unrealizedPl >= 0 ? "+" : ""}${money(h.unrealizedPl)}` : "—"}
              color={h ? pnlColor(h.unrealizedPl) : undefined}
              sub={h ? `${(h.unrealizedPlpc * 100).toFixed(2)}%` : undefined}
            />
            <Stat label="# of buys" value={String(buyCount)} sub={`${money(amount)} each`} />
          </div>

          <div className="rounded-xl border border-white/[0.06] bg-white/[0.02] p-4">
            <div className="text-[10px] font-semibold tracking-[0.12em] text-muted-foreground/50 uppercase mb-2">Cumulative Invested</div>
            <InvestedCurve buys={d?.recentBuys || []} amount={amount} />
          </div>

          <div className="rounded-xl border border-white/[0.06] bg-white/[0.02] p-4">
            <div className="text-[10px] font-semibold tracking-[0.12em] text-muted-foreground/50 uppercase mb-3">Holdings</div>
            {h ? (
              <table className="w-full text-[12.5px]">
                <thead><tr className="text-[10px] uppercase tracking-wider text-muted-foreground/40 text-left">
                  <th className="pb-1.5">Symbol</th>
                  <th className="pb-1.5 text-right">Qty</th>
                  <th className="pb-1.5 text-right">Avg cost</th>
                  <th className="pb-1.5 text-right">Price</th>
                  <th className="pb-1.5 text-right">Market value</th>
                  <th className="pb-1.5 text-right">Unrealized P&amp;L</th>
                </tr></thead>
                <tbody>
                  <tr className="border-t border-white/[0.04]">
                    <td className="py-1.5 font-medium">{symbol}</td>
                    <td className="py-1.5 text-right tabular-nums">{h.qty.toLocaleString(undefined, { maximumFractionDigits: 4 })}</td>
                    <td className="py-1.5 text-right tabular-nums">${h.avgPrice.toFixed(2)}</td>
                    <td className="py-1.5 text-right tabular-nums">${h.currentPrice.toFixed(2)}</td>
                    <td className="py-1.5 text-right tabular-nums">{money(h.marketValue)}</td>
                    <td className={`py-1.5 text-right tabular-nums ${pnlColor(h.unrealizedPl)}`}>{h.unrealizedPl >= 0 ? "+" : ""}{money(h.unrealizedPl)} <span className="text-muted-foreground/40">({(h.unrealizedPlpc * 100).toFixed(2)}%)</span></td>
                  </tr>
                </tbody>
              </table>
            ) : (
              <div className="text-xs text-muted-foreground/40 py-3">No live {symbol} position found (buys logged but the Alpaca position is empty or live keys are unavailable).</div>
            )}
          </div>

          <div className="rounded-xl border border-white/[0.06] bg-white/[0.02] p-4">
            <div className="flex items-start justify-between gap-3 flex-wrap">
              <div>
                <div className="text-[10px] font-semibold tracking-[0.12em] text-muted-foreground/50 uppercase mb-1">DCA Status</div>
                <div className={`text-sm font-semibold ${enabled ? "text-emerald-400" : "text-muted-foreground/60"}`}>{enabled ? "Enabled" : "Disabled"}</div>
                <div className="text-[11px] text-muted-foreground/60 mt-1">
                  {enabled
                    ? <>Buying {money(amount)} of {symbol} · {d?.schedule}</>
                    : <>DCA is off — enable to start weekly {money(amount)} buys of {symbol} (real money).</>}
                </div>
                {d?.lastRun && <div className="text-[11px] text-muted-foreground/40 mt-0.5">Last run {when(d.lastRun)}</div>}
              </div>
              <button
                onClick={toggle}
                disabled={toggling}
                className={`text-xs font-semibold px-3 py-1.5 rounded-lg border transition-colors disabled:opacity-50 ${
                  enabled
                    ? "border-red-500/30 bg-red-500/[0.08] text-red-400 hover:bg-red-500/[0.14]"
                    : "border-emerald-500/30 bg-emerald-500/[0.08] text-emerald-400 hover:bg-emerald-500/[0.14]"
                }`}
              >
                {toggling ? "Saving…" : enabled ? "Disable DCA" : "Enable DCA"}
              </button>
            </div>
            <div className="grid grid-cols-2 md:grid-cols-3 gap-3 mt-4 pt-3 border-t border-white/[0.04] text-[12px]">
              <div><div className="text-[10px] uppercase tracking-wider text-muted-foreground/40">Target</div><div className="font-medium tabular-nums">{symbol}</div></div>
              <div><div className="text-[10px] uppercase tracking-wider text-muted-foreground/40">$ per buy</div><div className="font-medium tabular-nums">{money(amount)}</div></div>
              <div><div className="text-[10px] uppercase tracking-wider text-muted-foreground/40">Schedule</div><div className="font-medium">{d?.schedule}</div></div>
            </div>
          </div>

          {d && d.recentBuys.length > 0 && (
            <div className="rounded-xl border border-white/[0.06] bg-white/[0.02] p-4">
              <div className="text-[10px] font-semibold tracking-[0.12em] text-muted-foreground/50 uppercase mb-3">Recent Buys</div>
              <table className="w-full text-[12.5px]">
                <thead><tr className="text-[10px] uppercase tracking-wider text-muted-foreground/40 text-left"><th className="pb-1.5">When</th><th className="pb-1.5">Detail</th></tr></thead>
                <tbody>{d.recentBuys.map((b, i) => (
                  <tr key={i} className="border-t border-white/[0.04]">
                    <td className="py-1.5 whitespace-nowrap pr-3 text-muted-foreground/70 tabular-nums">{when(b.at)}</td>
                    <td className="py-1.5 text-muted-foreground/80">{b.reason}</td>
                  </tr>
                ))}</tbody>
              </table>
            </div>
          )}
        </>
      )}

      <p className="text-[11px] text-muted-foreground/40 leading-relaxed">
        This is the boring, durable pillar: own the whole market and let the equity risk premium compound. On a ~$500 account the dollar moves are small — that&apos;s expected; the point is the habit and the holding period, not the weekly P&amp;L. Buy-only by design — it never sells.
      </p>
    </div>
  );
}
