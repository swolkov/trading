"use client";

import Link from "next/link";
import { useAccount } from "@/hooks/use-account";
import { usePositions } from "@/hooks/use-positions";
import { formatCurrency, pnlColor } from "@/lib/utils";
import { useEffect, useState } from "react";

interface RegimeData {
  regime: string;
  recommendation: string;
  positionSizeMultiplier: number;
  spy1mReturn: number;
  rsi: number | null;
  volatility: number;
}

export default function DashboardPage() {
  const { data: account } = useAccount();
  const { data: positions } = usePositions();
  const [regime, setRegime] = useState<RegimeData | null>(null);
  const [recentReports, setRecentReports] = useState<{ symbol: string; score: number; signal: string; summary: string; createdAt: string }[]>([]);
  const [futures, setFutures] = useState<{ connected: boolean; account: { balance: number; netLiq: number; realizedPnl: number; marginUsed: number } | null; positions: { symbol: string; direction: string; quantity: number; unrealizedPnl: number; currentPrice: number }[]; engineStatus?: { alive: boolean; ageMinutes: number } } | null>(null);

  useEffect(() => {
    fetch("/api/regime").then((r) => r.json()).then((d) => { if (!d.error) setRegime(d); }).catch(() => {});
    fetch("/api/ai/reports?limit=5").then((r) => r.json()).then((d) => { if (Array.isArray(d)) setRecentReports(d); }).catch(() => {});
    fetch("/api/futures/positions").then((r) => r.json()).then((d) => { if (!d.error) setFutures(d); }).catch(() => {});
  }, []);

  const equity = account ? parseFloat(account.equity) : 0;
  const lastEquity = account ? parseFloat(account.last_equity) : 0;
  const dailyPnl = equity - lastEquity;
  const dailyPnlPct = lastEquity > 0 ? dailyPnl / lastEquity : 0;
  const cash = account ? parseFloat(account.cash) : 0;
  const totalUnrealized = positions?.reduce((s, p) => s + parseFloat(p.unrealized_pl), 0) || 0;

  return (
    <div className="space-y-6">
      {/* Hero */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-xl font-bold tracking-tight">Dashboard</h2>
          <p className="text-[11px] text-muted-foreground/50">Portfolio overview &middot; Paper trading</p>
        </div>
        <div className="flex items-center gap-1.5">
          <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 live-dot" />
          <span className="text-[10px] text-muted-foreground/40">Live data</span>
        </div>
      </div>

      {/* Combined Portfolio Metrics */}
      {(() => {
        const futuresEquity = futures?.account?.netLiq || 0;
        const futuresUnrealized = futures?.positions?.reduce((s, p) => s + p.unrealizedPnl, 0) || 0;
        const combinedEquity = equity + futuresEquity;
        const combinedDailyPnl = dailyPnl + (futures?.account?.realizedPnl || 0);
        const combinedUnrealized = totalUnrealized + futuresUnrealized;
        const futuresPositionCount = futures?.positions?.length || 0;
        const optionsPositionCount = positions?.length || 0;
        return (
          <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
            <div className="rounded-xl border border-white/[0.06] bg-white/[0.02] p-4">
              <p className="text-[10px] text-muted-foreground/50 uppercase tracking-wider font-medium">Total Portfolio</p>
              <p className="text-xl font-bold mt-1">{formatCurrency(combinedEquity)}</p>
              <p className="text-[11px] mt-0.5 text-muted-foreground/50">Alpaca + Tradovate</p>
            </div>
            <div className="rounded-xl border border-white/[0.06] bg-white/[0.02] p-4">
              <p className="text-[10px] text-muted-foreground/50 uppercase tracking-wider font-medium">Options Account</p>
              <p className="text-xl font-bold mt-1">{formatCurrency(equity)}</p>
              <p className="text-[11px] mt-0.5 text-muted-foreground/50">{optionsPositionCount} positions</p>
            </div>
            <div className="rounded-xl border border-white/[0.06] bg-white/[0.02] p-4">
              <p className="text-[10px] text-muted-foreground/50 uppercase tracking-wider font-medium">Futures Account</p>
              <p className="text-xl font-bold mt-1">{formatCurrency(futuresEquity)}</p>
              <p className="text-[11px] mt-0.5 text-muted-foreground/50">
                {futuresPositionCount} positions
                {futures?.engineStatus?.alive && <span className="text-emerald-400 ml-1">Engine Live</span>}
              </p>
            </div>
            <div className="rounded-xl border border-white/[0.06] bg-white/[0.02] p-4">
              <p className="text-[10px] text-muted-foreground/50 uppercase tracking-wider font-medium">Daily P&L</p>
              <p className={`text-xl font-bold mt-1 ${pnlColor(combinedDailyPnl)}`}>{combinedDailyPnl >= 0 ? "+" : ""}{formatCurrency(combinedDailyPnl)}</p>
              <p className={`text-[11px] mt-0.5 ${pnlColor(combinedDailyPnl)}`}>Combined</p>
            </div>
            <div className="rounded-xl border border-white/[0.06] bg-white/[0.02] p-4">
              <p className="text-[10px] text-muted-foreground/50 uppercase tracking-wider font-medium">Unrealized</p>
              <p className={`text-xl font-bold mt-1 ${pnlColor(combinedUnrealized)}`}>{combinedUnrealized >= 0 ? "+" : ""}{formatCurrency(combinedUnrealized)}</p>
              <p className="text-[11px] mt-0.5 text-muted-foreground/50">{optionsPositionCount + futuresPositionCount} positions</p>
            </div>
          </div>
        );
      })()}

      {/* Market Regime + Quick Actions */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        {regime && (
          <div className={`rounded-xl border p-4 ${
            regime.regime === "bull" ? "border-emerald-500/20 bg-emerald-500/[0.03]" :
            regime.regime === "bear" ? "border-red-500/20 bg-red-500/[0.03]" :
            "border-amber-500/20 bg-amber-500/[0.03]"
          }`}>
            <div className="flex items-center gap-2 mb-2">
              <span className={`text-xs px-2 py-0.5 rounded-full font-bold tracking-wider ${
                regime.regime === "bull" ? "bg-emerald-500/20 text-emerald-400" :
                regime.regime === "bear" ? "bg-red-500/20 text-red-400" :
                "bg-amber-500/20 text-amber-400"
              }`}>
                {regime.regime.toUpperCase()} MARKET
              </span>
              <span className="text-xs text-muted-foreground">
                SPY {(regime.spy1mReturn * 100).toFixed(1)}% 1M · Vol {regime.volatility.toFixed(0)}% · Sizing {regime.positionSizeMultiplier.toFixed(1)}x
              </span>
            </div>
            <p className="text-xs text-muted-foreground/70">{regime.recommendation}</p>
          </div>
        )}

        <div className="rounded-xl border border-white/[0.06] bg-white/[0.02] p-4">
          <p className="text-[10px] text-muted-foreground/50 uppercase tracking-wider font-medium mb-3">Quick Actions</p>
          <div className="flex gap-2">
            <Link href="/ai" className="flex-1 text-center py-2 rounded-lg bg-emerald-500/10 text-emerald-400 text-xs font-medium hover:bg-emerald-500/20 transition-colors border border-emerald-500/20">
              AI Analysis
            </Link>
            <Link href="/agent" className="flex-1 text-center py-2 rounded-lg bg-white/[0.04] text-foreground text-xs font-medium hover:bg-white/[0.08] transition-colors border border-white/[0.06]">
              Run Agent
            </Link>
            <Link href="/options" className="flex-1 text-center py-2 rounded-lg bg-white/[0.04] text-foreground text-xs font-medium hover:bg-white/[0.08] transition-colors border border-white/[0.06]">
              Options
            </Link>
            <Link href="/backtest" className="flex-1 text-center py-2 rounded-lg bg-white/[0.04] text-foreground text-xs font-medium hover:bg-white/[0.08] transition-colors border border-white/[0.06]">
              Backtest
            </Link>
          </div>
        </div>
      </div>

      {/* Positions */}
      <div className="rounded-xl border border-white/[0.06] bg-white/[0.02] overflow-hidden">
        <div className="flex items-center justify-between px-4 py-3 border-b border-white/[0.06]">
          <p className="text-xs font-medium">Open Positions</p>
          <Link href="/positions" className="text-[10px] text-emerald-400 hover:underline">View all</Link>
        </div>
        {positions && positions.length > 0 ? (
          <div className="divide-y divide-white/[0.04]">
            {positions.slice(0, 8).map((pos) => {
              const pnl = parseFloat(pos.unrealized_pl);
              const pnlPct = parseFloat(pos.unrealized_plpc) * 100;
              return (
                <div key={pos.symbol} className="flex items-center justify-between px-4 py-2.5 hover:bg-white/[0.02] transition-colors">
                  <div className="flex items-center gap-3">
                    <Link href={`/research/${pos.symbol}`} className="font-medium text-sm hover:text-emerald-400 transition-colors">{pos.symbol}</Link>
                    <span className="text-xs text-muted-foreground/50">{pos.qty} shares</span>
                  </div>
                  <div className="flex items-center gap-4 text-sm">
                    <span className="text-muted-foreground">{formatCurrency(pos.current_price)}</span>
                    <span className={`font-medium ${pnlColor(pnl)}`}>
                      {pnl >= 0 ? "+" : ""}{formatCurrency(pnl)}
                    </span>
                    <span className={`text-xs ${pnlColor(pnlPct)}`}>
                      {pnlPct >= 0 ? "+" : ""}{pnlPct.toFixed(2)}%
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
        ) : (
          <div className="px-4 py-8 text-center text-sm text-muted-foreground/50">
            No open positions. <Link href="/trade" className="text-emerald-400 hover:underline">Place a trade</Link> or <Link href="/agent" className="text-emerald-400 hover:underline">run the agent</Link>.
          </div>
        )}
      </div>

      {/* Futures Positions */}
      {futures?.connected && (
        <div className="rounded-xl border border-white/[0.06] bg-white/[0.02] overflow-hidden">
          <div className="flex items-center justify-between px-4 py-3 border-b border-white/[0.06]">
            <div className="flex items-center gap-2">
              <p className="text-xs font-medium">Futures Positions</p>
              {futures.engineStatus?.alive && (
                <span className="flex items-center gap-1 text-[10px] text-blue-400">
                  <span className="relative flex h-1.5 w-1.5"><span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-blue-400 opacity-75" /><span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-blue-400" /></span>
                  Railway Engine Live
                </span>
              )}
            </div>
            <Link href="/futures" className="text-[10px] text-emerald-400 hover:underline">Futures Dashboard</Link>
          </div>
          {futures.positions && futures.positions.length > 0 ? (
            <div className="divide-y divide-white/[0.04]">
              {futures.positions.map((pos, i) => (
                <div key={i} className="flex items-center justify-between px-4 py-2.5 hover:bg-white/[0.02] transition-colors">
                  <div className="flex items-center gap-3">
                    <span className="font-medium text-sm">{pos.symbol}</span>
                    <span className={`text-[10px] px-1.5 py-0.5 rounded font-bold ${
                      pos.direction === "long" ? "bg-emerald-500/15 text-emerald-400" : "bg-red-500/15 text-red-400"
                    }`}>
                      {pos.direction.toUpperCase()} {pos.quantity}x
                    </span>
                  </div>
                  <div className="flex items-center gap-4 text-sm">
                    <span className="text-muted-foreground">${pos.currentPrice.toLocaleString()}</span>
                    <span className={`font-medium ${pnlColor(pos.unrealizedPnl)}`}>
                      {pos.unrealizedPnl >= 0 ? "+" : ""}${pos.unrealizedPnl.toFixed(0)}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="px-4 py-4 text-center text-[11px] text-muted-foreground/50">
              No futures positions. Agent trades 9:45 AM - 3:50 PM ET.
            </div>
          )}
        </div>
      )}

      {/* Recent AI Research */}
      {recentReports.length > 0 && (
        <div className="rounded-xl border border-white/[0.06] bg-white/[0.02] overflow-hidden">
          <div className="flex items-center justify-between px-4 py-3 border-b border-white/[0.06]">
            <p className="text-xs font-medium">Recent AI Research</p>
            <Link href="/ai" className="text-[10px] text-emerald-400 hover:underline">View library</Link>
          </div>
          <div className="divide-y divide-white/[0.04]">
            {recentReports.map((report, i) => (
              <div key={i} className="flex items-center justify-between px-4 py-2.5 hover:bg-white/[0.02] transition-colors">
                <div className="flex items-center gap-3 flex-1 min-w-0">
                  <Link href={`/research/${report.symbol}`} className="font-medium text-sm hover:text-emerald-400 shrink-0">{report.symbol}</Link>
                  <span className={`text-[10px] px-1.5 py-0.5 rounded font-bold ${
                    report.signal.includes("buy") ? "bg-emerald-500/15 text-emerald-400" :
                    report.signal.includes("sell") ? "bg-red-500/15 text-red-400" :
                    "bg-white/5 text-muted-foreground"
                  }`}>
                    {report.signal.replace("_", " ").toUpperCase()}
                  </span>
                  <span className="text-xs text-muted-foreground/50 truncate">{report.summary}</span>
                </div>
                <span className={`text-sm font-bold shrink-0 ml-2 ${report.score > 0 ? "text-emerald-400" : report.score < 0 ? "text-red-400" : "text-muted-foreground"}`}>
                  {report.score > 0 ? "+" : ""}{report.score}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
