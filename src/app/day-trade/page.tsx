"use client";

import Link from "next/link";
import useSWR from "swr";
import { formatCurrency, pnlColor } from "@/lib/utils";

interface OpenPosition {
  symbol: string;
  kind: "STOCK" | "CRYPTO";
  side: string;
  qty: string;
  entry: number;
  current: number;
  marketValue: number;
  unrealizedPl: number;
  unrealizedPlpc: number;
}
interface RecentTrade {
  symbol: string;
  kind: "STOCK" | "CRYPTO";
  action: string;
  pnl: number | null;
  price: number | null;
  at: string;
}
interface PoolStats {
  mode: string;
  poolSize: number;
  currentEquity: number;
  poolPnl: number;
  poolPnlPct: number;
  startISO: string;
  deployed: number;
  idle: number;
  openPositions: OpenPosition[];
  activity: {
    roundTrips: number;
    entries: number;
    wins: number;
    losses: number;
    winRate: number | null;
    stocksClosed: number;
    cryptoClosed: number;
  };
  recentTrades: RecentTrade[];
  error?: string;
}

const fetcher = async (url: string) => {
  const r = await fetch(url);
  const d = await r.json().catch(() => null);
  if (!r.ok || (d && d.error)) throw new Error(d?.error || `Request failed (${r.status})`);
  return d;
};

const ACTION_LABEL: Record<string, { label: string; cls: string }> = {
  take_profit: { label: "TARGET", cls: "bg-emerald-500/15 text-emerald-400" },
  stop_loss: { label: "STOP", cls: "bg-red-500/15 text-red-400" },
  eod_flatten: { label: "EOD FLAT", cls: "bg-blue-500/15 text-blue-400" },
  time_exit: { label: "TIME EXIT", cls: "bg-amber-500/15 text-amber-400" },
};

export default function DayTradePage() {
  const { data, isLoading, error } = useSWR<PoolStats>("/api/alpaca/pool-stats", fetcher, {
    refreshInterval: 20000,
  });

  const poolSize = data?.poolSize ?? 1000;
  const poolPnl = data?.poolPnl ?? 0;
  const poolPnlPct = data?.poolPnlPct ?? 0;
  const positions = data?.openPositions ?? [];
  const sorted = [...positions].sort((a, b) => Math.abs(b.marketValue) - Math.abs(a.marketValue));
  const started = data?.startISO ? new Date(data.startISO) : null;
  const deployedPct = poolSize > 0 ? (Math.min(poolSize, data?.deployed ?? 0) / poolSize) * 100 : 0;

  return (
    <div className="space-y-5 animate-fade-up">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div>
          <h1 className="text-xl font-bold tracking-tight">Day Trade</h1>
          <p className="text-[11px] text-muted-foreground/50">
            Stocks + Crypto · buy the dip, sell same day · ${poolSize.toLocaleString()} paper pool
            <span className="ml-2 inline-flex items-center gap-1 text-emerald-400">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" />
              Paper
            </span>
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Link href="/stocks" className="text-xs px-3 py-1.5 rounded-lg bg-blue-500/10 text-blue-400 hover:bg-blue-500/20 transition-colors border border-blue-500/20 font-medium">Stocks detail</Link>
          <Link href="/crypto" className="text-xs px-3 py-1.5 rounded-lg bg-purple-500/10 text-purple-400 hover:bg-purple-500/20 transition-colors border border-purple-500/20 font-medium">Crypto detail</Link>
        </div>
      </div>

      {error ? (
        <div className="rounded-xl border border-red-500/20 bg-red-500/[0.04] p-6 text-center">
          <p className="text-sm text-red-400 font-medium">Couldn&apos;t load the test data</p>
          <p className="text-[11px] text-muted-foreground/50 mt-1">{String(error.message || error)}</p>
        </div>
      ) : (
        <>
          {/* Hero: true test P&L */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <div className={`rounded-xl border p-4 col-span-2 md:col-span-1 ${poolPnl >= 0 ? "border-emerald-500/25 bg-gradient-to-br from-emerald-500/[0.08] to-transparent" : "border-red-500/25 bg-gradient-to-br from-red-500/[0.08] to-transparent"}`}>
              <p className="text-[10px] uppercase tracking-wider font-bold text-muted-foreground/60">Test P&amp;L</p>
              {isLoading ? <div className="skeleton h-8 w-24 rounded mt-1" /> : (
                <p className={`text-3xl font-black mt-1 tabular-nums ${pnlColor(poolPnl)}`}>
                  {poolPnl >= 0 ? "+" : ""}{formatCurrency(poolPnl)}
                </p>
              )}
              <p className={`text-[11px] mt-0.5 font-medium ${pnlColor(poolPnl)}`}>
                {poolPnlPct >= 0 ? "+" : ""}{poolPnlPct.toFixed(2)}% of ${poolSize.toLocaleString()} pool
              </p>
            </div>
            <div className="rounded-xl border border-white/[0.06] bg-white/[0.02] p-4">
              <p className="text-[10px] text-muted-foreground/50 uppercase tracking-wider font-medium">Deployed</p>
              <p className="text-xl font-bold mt-1 tabular-nums">{formatCurrency(data?.deployed ?? 0)}</p>
              <div className="flex items-center gap-1.5 mt-1.5">
                <div className="flex-1 h-1.5 rounded-full bg-white/[0.06] overflow-hidden">
                  <div className="h-full rounded-full bg-blue-400/50" style={{ width: `${Math.min(100, deployedPct)}%` }} />
                </div>
                <span className="text-[10px] tabular-nums text-muted-foreground/50">{deployedPct.toFixed(0)}%</span>
              </div>
            </div>
            <div className="rounded-xl border border-white/[0.06] bg-white/[0.02] p-4">
              <p className="text-[10px] text-muted-foreground/50 uppercase tracking-wider font-medium">Open Positions</p>
              <p className="text-xl font-bold mt-1 tabular-nums">{positions.length}</p>
              <p className="text-[11px] mt-0.5 text-muted-foreground/50">
                {positions.filter((p) => p.kind === "STOCK").length} stk · {positions.filter((p) => p.kind === "CRYPTO").length} cry
              </p>
            </div>
            <div className="rounded-xl border border-white/[0.06] bg-white/[0.02] p-4">
              <p className="text-[10px] text-muted-foreground/50 uppercase tracking-wider font-medium">Win Rate</p>
              <p className={`text-xl font-black mt-1 ${data?.activity.winRate == null ? "text-muted-foreground/40" : data.activity.winRate >= 50 ? "text-emerald-400" : "text-red-400"}`}>
                {data?.activity.winRate == null ? "—" : `${data.activity.winRate}%`}
              </p>
              <p className="text-[11px] mt-0.5 text-muted-foreground/50">
                {data?.activity.roundTrips ?? 0} round-trips ({data?.activity.wins ?? 0}W/{data?.activity.losses ?? 0}L)
              </p>
            </div>
          </div>

          {/* Started note */}
          <p className="text-[10px] text-muted-foreground/40">
            Test started {started ? started.toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "—"} ·
            {" "}{data?.activity.entries ?? 0} entries taken · paper shell {formatCurrency(data?.currentEquity ?? 0)} (only ${poolSize.toLocaleString()} is in play)
          </p>

          {/* Open positions (stocks + crypto together) */}
          <div className="rounded-xl border border-white/[0.06] bg-white/[0.02] overflow-hidden">
            <div className="flex items-center justify-between px-4 py-3 border-b border-white/[0.06]">
              <p className="text-xs font-medium">Open Positions</p>
              <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-white/[0.06] text-muted-foreground/60 tabular-nums">{positions.length}</span>
            </div>
            {isLoading ? (
              <div className="divide-y divide-white/[0.04]">
                {Array.from({ length: 3 }).map((_, i) => (
                  <div key={i} className="flex items-center justify-between px-4 py-3">
                    <div className="skeleton h-4 w-20 rounded" />
                    <div className="skeleton h-3 w-16 rounded" />
                  </div>
                ))}
              </div>
            ) : sorted.length > 0 ? (
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="text-muted-foreground/40 border-b border-white/[0.06]">
                      <th className="text-left px-4 py-2.5 font-medium">Symbol</th>
                      <th className="text-left px-2 py-2.5 font-medium">Type</th>
                      <th className="text-left px-2 py-2.5 font-medium">Side</th>
                      <th className="text-right px-2 py-2.5 font-medium">Qty</th>
                      <th className="text-right px-2 py-2.5 font-medium">Entry</th>
                      <th className="text-right px-2 py-2.5 font-medium">Current</th>
                      <th className="text-right px-2 py-2.5 font-medium">Mkt Value</th>
                      <th className="text-right px-2 py-2.5 font-medium">P&amp;L</th>
                      <th className="text-right px-4 py-2.5 font-medium">% P&amp;L</th>
                    </tr>
                  </thead>
                  <tbody>
                    {sorted.map((p) => (
                      <tr key={p.symbol} className="border-b border-white/[0.03] hover:bg-white/[0.02] transition-colors">
                        <td className="px-4 py-2.5 font-bold">{p.symbol}</td>
                        <td className="px-2 py-2.5">
                          <span className={`px-1.5 py-0.5 rounded text-[9px] font-bold ${p.kind === "CRYPTO" ? "bg-purple-500/15 text-purple-400" : "bg-blue-500/15 text-blue-400"}`}>{p.kind}</span>
                        </td>
                        <td className="px-2 py-2.5">
                          <span className={`px-1.5 py-0.5 rounded text-[10px] font-bold ${p.side === "long" ? "bg-emerald-500/15 text-emerald-400" : "bg-red-500/15 text-red-400"}`}>{p.side.toUpperCase()}</span>
                        </td>
                        <td className="px-2 py-2.5 text-right tabular-nums">{p.qty}</td>
                        <td className="px-2 py-2.5 text-right tabular-nums text-muted-foreground/60">${p.entry.toFixed(2)}</td>
                        <td className="px-2 py-2.5 text-right tabular-nums">${p.current.toFixed(2)}</td>
                        <td className="px-2 py-2.5 text-right tabular-nums">{formatCurrency(p.marketValue)}</td>
                        <td className={`px-2 py-2.5 text-right font-bold tabular-nums ${pnlColor(p.unrealizedPl)}`}>
                          {p.unrealizedPl >= 0 ? "+" : ""}{formatCurrency(p.unrealizedPl)}
                        </td>
                        <td className={`px-4 py-2.5 text-right font-medium tabular-nums ${pnlColor(p.unrealizedPlpc)}`}>
                          {p.unrealizedPlpc >= 0 ? "+" : ""}{p.unrealizedPlpc.toFixed(2)}%
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <div className="px-4 py-10 text-center">
                <p className="text-sm text-muted-foreground/40">No open positions right now</p>
                <p className="text-[11px] text-muted-foreground/25 mt-1">The bot waits for a dip — it&apos;s selective on purpose.</p>
              </div>
            )}
          </div>

          {/* Recent round-trips */}
          <div className="rounded-xl border border-white/[0.06] bg-white/[0.02] overflow-hidden">
            <div className="flex items-center justify-between px-4 py-3 border-b border-white/[0.06]">
              <p className="text-xs font-medium">Recent Round-Trips</p>
              <Link href="/journal" className="text-[10px] text-emerald-400 hover:underline">Journal</Link>
            </div>
            {data && data.recentTrades.length > 0 ? (
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="text-muted-foreground/40 border-b border-white/[0.06]">
                      <th className="text-left px-4 py-2 font-medium">Closed</th>
                      <th className="text-left px-2 py-2 font-medium">Symbol</th>
                      <th className="text-left px-2 py-2 font-medium">Type</th>
                      <th className="text-left px-2 py-2 font-medium">Exit</th>
                      <th className="text-right px-4 py-2 font-medium">P&amp;L</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.recentTrades.map((t, i) => {
                      const a = ACTION_LABEL[t.action] || { label: t.action.toUpperCase(), cls: "bg-white/[0.06] text-muted-foreground/60" };
                      return (
                        <tr key={i} className="border-b border-white/[0.03] hover:bg-white/[0.02]">
                          <td className="px-4 py-2 text-muted-foreground/50 tabular-nums">
                            {new Date(t.at).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}
                          </td>
                          <td className="px-2 py-2 font-bold">{t.symbol}</td>
                          <td className="px-2 py-2">
                            <span className={`px-1.5 py-0.5 rounded text-[9px] font-bold ${t.kind === "CRYPTO" ? "bg-purple-500/15 text-purple-400" : "bg-blue-500/15 text-blue-400"}`}>{t.kind}</span>
                          </td>
                          <td className="px-2 py-2">
                            <span className={`px-1.5 py-0.5 rounded text-[9px] font-bold ${a.cls}`}>{a.label}</span>
                          </td>
                          <td className={`px-4 py-2 text-right font-bold tabular-nums ${t.pnl != null ? pnlColor(t.pnl) : ""}`}>
                            {t.pnl != null ? `${t.pnl >= 0 ? "+" : ""}${formatCurrency(t.pnl)}` : "—"}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            ) : (
              <div className="px-4 py-10 text-center">
                <p className="text-sm text-muted-foreground/40">No completed round-trips yet</p>
                <p className="text-[11px] text-muted-foreground/25 mt-1">They&apos;ll show here as the bot buys dips and sells into bounces.</p>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
