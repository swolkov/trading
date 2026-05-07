"use client";

import { useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

interface PerformanceData {
  overview: {
    totalTrades: number;
    openTrades: number;
    winRate: number;
    profitFactor: number;
    totalPnl: number;
    grossProfit: number;
    grossLoss: number;
    avgWin: number;
    avgLoss: number;
    maxDrawdown: number;
    expectancy: number;
    currentStreak: string;
    bestTrade: number;
    worstTrade: number;
  };
  agent: {
    totalRuns: number;
    avgDuration: number;
    totalScanned: number;
  };
  byStrategy: { strategy: string; trades: number; winRate: number; pnl: number }[];
  bySymbol: { symbol: string; trades: number; winRate: number; pnl: number }[];
  dailyPnl: { date: string; pnl: number }[];
  recentTrades: {
    symbol: string;
    action: string;
    qty: number;
    price: number | null;
    pnl: number | null;
    score: number | null;
    signal: string | null;
    reason: string;
    time: string;
  }[];
}

function pnlColor(val: number) {
  return val > 0 ? "text-emerald-400" : val < 0 ? "text-red-400" : "text-muted-foreground";
}

function StatCard({ label, value, sub, color }: { label: string; value: string; sub?: string; color?: string }) {
  return (
    <Card>
      <CardContent className="pt-4 pb-3">
        <p className="text-[10px] text-muted-foreground/60 uppercase tracking-wider">{label}</p>
        <p className={`text-xl font-bold mt-1 ${color || "text-foreground"}`}>{value}</p>
        {sub && <p className="text-[10px] text-muted-foreground/50 mt-0.5">{sub}</p>}
      </CardContent>
    </Card>
  );
}

export default function PerformancePage() {
  const [data, setData] = useState<PerformanceData | null>(null);

  useEffect(() => {
    fetch("/api/performance")
      .then((r) => r.json())
      .then(setData)
      .catch(console.error);
  }, []);

  if (!data) return <div className="p-6 text-muted-foreground">Loading performance data...</div>;

  const o = data.overview;
  const cumulativePnl = data.dailyPnl.reduce<{ date: string; pnl: number; cumulative: number }[]>((acc, d) => {
    const prev = acc.length > 0 ? acc[acc.length - 1].cumulative : 0;
    acc.push({ ...d, cumulative: prev + d.pnl });
    return acc;
  }, []);

  const maxCum = Math.max(...cumulativePnl.map((d) => Math.abs(d.cumulative)), 1);

  return (
    <div className="space-y-6 animate-fade-up">
      <div>
        <h1 className="text-2xl font-bold">How Is The Agent Doing?</h1>
        <p className="text-sm text-muted-foreground">Simple breakdown of your AI trading agent's performance</p>
      </div>

      {/* Big Simple Status */}
      <Card className={`border-2 ${o.totalPnl >= 0 ? "border-emerald-500/30" : "border-red-500/30"}`}>
        <CardContent className="pt-6 pb-4 text-center">
          <p className="text-sm text-muted-foreground mb-1">Total Money Made / Lost</p>
          <p className={`text-5xl font-bold ${pnlColor(o.totalPnl)}`}>
            {o.totalPnl >= 0 ? "+" : ""}${Math.abs(o.totalPnl).toLocaleString()}
          </p>
          <p className="text-sm text-muted-foreground mt-2">
            from {o.totalTrades} completed trades
          </p>
        </CardContent>
      </Card>

      {/* Key Metrics — Beginner Friendly */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <StatCard
          label="Winning Trades"
          value={`${o.winRate}%`}
          sub={o.winRate >= 55 ? "Good! Above 55% is profitable" : "Needs improvement (target: 55%+)"}
          color={o.winRate >= 50 ? "text-emerald-400" : "text-red-400"}
        />
        <StatCard
          label="Avg When We Win"
          value={`+$${o.avgWin.toFixed(0)}`}
          sub="How much we make per winning trade"
          color="text-emerald-400"
        />
        <StatCard
          label="Avg When We Lose"
          value={`-$${o.avgLoss.toFixed(0)}`}
          sub="How much we lose per losing trade"
          color="text-red-400"
        />
        <StatCard
          label="Per Trade Average"
          value={`${o.expectancy >= 0 ? "+" : ""}$${o.expectancy.toFixed(0)}`}
          sub={o.expectancy > 0 ? "Making money on average" : "Losing money on average"}
          color={pnlColor(o.expectancy)}
        />
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <StatCard label="Best Single Trade" value={`+$${o.bestTrade.toFixed(0)}`} color="text-emerald-400" />
        <StatCard label="Worst Single Trade" value={`-$${Math.abs(o.worstTrade).toFixed(0)}`} color="text-red-400" />
        <StatCard label="Biggest Dip" value={`-$${o.maxDrawdown.toFixed(0)}`} sub="Worst losing streak total" color="text-red-400" />
        <StatCard label="Current Streak" value={o.currentStreak} color={o.currentStreak.includes("win") ? "text-emerald-400" : "text-red-400"} />
      </div>

      {/* Equity Curve */}
      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Equity Curve (Realized P&L)</CardTitle>
        </CardHeader>
        <CardContent>
          {cumulativePnl.length === 0 ? (
            <p className="text-xs text-muted-foreground">No closed trades yet</p>
          ) : (
            <div className="h-40 flex items-end gap-1">
              {cumulativePnl.map((d, i) => {
                const height = Math.abs(d.cumulative) / maxCum * 100;
                const isNeg = d.cumulative < 0;
                return (
                  <div key={i} className="flex-1 flex flex-col items-center justify-end h-full relative group">
                    <div
                      className={`w-full rounded-sm min-h-[2px] ${isNeg ? "bg-red-500/60" : "bg-emerald-500/60"}`}
                      style={{ height: `${Math.max(2, height)}%` }}
                    />
                    <div className="absolute -top-8 left-1/2 -translate-x-1/2 bg-card border border-border rounded px-2 py-1 text-[9px] whitespace-nowrap hidden group-hover:block z-10">
                      {d.date}: ${d.pnl.toFixed(0)} (cum: ${d.cumulative.toFixed(0)})
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>

      <div className="grid md:grid-cols-2 gap-6">
        {/* Strategy Breakdown */}
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Which Strategies Make Money?</CardTitle>
          </CardHeader>
          <CardContent>
            {data.byStrategy.length === 0 ? (
              <p className="text-xs text-muted-foreground">No data yet</p>
            ) : (
              <div className="space-y-2">
                {data.byStrategy.map((s) => (
                  <div key={s.strategy} className="flex items-center justify-between text-xs border-b border-white/5 pb-2">
                    <div>
                      <span className="font-medium">{s.strategy}</span>
                      <span className="text-muted-foreground/50 ml-2">{s.trades} trades</span>
                    </div>
                    <div className="flex gap-4">
                      <span className={s.winRate >= 50 ? "text-emerald-400" : "text-red-400"}>
                        {s.winRate}% win
                      </span>
                      <span className={`font-medium min-w-[70px] text-right ${pnlColor(s.pnl)}`}>
                        ${s.pnl.toFixed(0)}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        {/* Symbol Breakdown */}
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Which Stocks Make Money?</CardTitle>
          </CardHeader>
          <CardContent>
            {data.bySymbol.length === 0 ? (
              <p className="text-xs text-muted-foreground">No data yet</p>
            ) : (
              <div className="space-y-2">
                {data.bySymbol.slice(0, 15).map((s) => (
                  <div key={s.symbol} className="flex items-center justify-between text-xs border-b border-white/5 pb-2">
                    <div>
                      <span className="font-bold">{s.symbol}</span>
                      <span className="text-muted-foreground/50 ml-2">{s.trades} trades</span>
                    </div>
                    <div className="flex gap-4">
                      <span className={s.winRate >= 50 ? "text-emerald-400" : "text-red-400"}>
                        {s.winRate}% win
                      </span>
                      <span className={`font-medium min-w-[70px] text-right ${pnlColor(s.pnl)}`}>
                        ${s.pnl.toFixed(0)}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Trade Log */}
      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Recent Trades</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="text-muted-foreground/50 border-b border-white/5">
                  <th className="text-left py-2 font-medium">Time</th>
                  <th className="text-left py-2 font-medium">Symbol</th>
                  <th className="text-left py-2 font-medium">Action</th>
                  <th className="text-right py-2 font-medium">Qty</th>
                  <th className="text-right py-2 font-medium">Price</th>
                  <th className="text-right py-2 font-medium">Score</th>
                  <th className="text-right py-2 font-medium">P&L</th>
                  <th className="text-left py-2 font-medium pl-3">Reasoning</th>
                </tr>
              </thead>
              <tbody>
                {data.recentTrades.map((t, i) => (
                  <tr key={i} className="border-b border-white/[0.03] hover:bg-white/[0.02]">
                    <td className="py-2 text-muted-foreground/50 whitespace-nowrap">
                      {new Date(t.time).toLocaleDateString()} {new Date(t.time).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                    </td>
                    <td className="py-2 font-bold">{t.symbol.length > 20 ? t.symbol.slice(0, 20) + "..." : t.symbol}</td>
                    <td className="py-2">
                      <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${
                        t.action.includes("buy") ? "bg-emerald-500/15 text-emerald-400" :
                        t.action.includes("sell") || t.action.includes("stop") ? "bg-red-500/15 text-red-400" :
                        "bg-white/5 text-muted-foreground"
                      }`}>
                        {t.action.replace(/_/g, " ")}
                      </span>
                    </td>
                    <td className="py-2 text-right">{t.qty}</td>
                    <td className="py-2 text-right">{t.price ? `$${t.price.toFixed(2)}` : "—"}</td>
                    <td className="py-2 text-right">{t.score ?? "—"}</td>
                    <td className={`py-2 text-right font-medium ${t.pnl != null ? pnlColor(t.pnl) : ""}`}>
                      {t.pnl != null ? `$${t.pnl.toFixed(0)}` : "—"}
                    </td>
                    <td className="py-2 pl-3 text-muted-foreground/60 max-w-[300px] truncate">{t.reason}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>

      {/* Trust Checklist */}
      <Card className="border-2 border-white/10">
        <CardHeader>
          <CardTitle className="text-sm">Safe to Use Real Money?</CardTitle>
          <p className="text-xs text-muted-foreground">All items must be green before switching to live trading</p>
        </CardHeader>
        <CardContent>
          <div className="space-y-3">
            {[
              { check: o.totalTrades >= 50, label: "Made at least 50 trades (enough data to trust)", value: `${o.totalTrades}/50` },
              { check: o.winRate >= 55, label: "Wins more than it loses (55%+ win rate)", value: `${o.winRate}%` },
              { check: o.profitFactor >= 1.5, label: "Wins are bigger than losses (1.5x+ profit factor)", value: `${o.profitFactor}x` },
              { check: o.expectancy > 0, label: "Makes money on average per trade", value: `$${o.expectancy.toFixed(0)}/trade` },
              { check: o.maxDrawdown < 5000, label: "Never lost more than $5,000 in a row", value: `$${o.maxDrawdown.toFixed(0)}` },
              { check: data.agent.totalRuns >= 20, label: "Agent has run at least 20 times", value: `${data.agent.totalRuns}` },
            ].map((item, i) => (
              <div key={i} className="flex items-center gap-3 text-xs">
                <span className={`w-5 h-5 rounded-full flex items-center justify-center text-[10px] ${
                  item.check ? "bg-emerald-500/20 text-emerald-400" : "bg-red-500/20 text-red-400"
                }`}>
                  {item.check ? "Y" : "N"}
                </span>
                <span className="flex-1">{item.label}</span>
                <span className={`font-medium ${item.check ? "text-emerald-400" : "text-red-400"}`}>{item.value}</span>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
