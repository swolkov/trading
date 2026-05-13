"use client";

import { useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

interface Position {
  symbol: string;
  qty: string;
  side: string;
  avg_entry_price: string;
  current_price: string;
  market_value: string;
  unrealized_pl: string;
  unrealized_plpc: string;
  asset_class: string;
}

interface TradeAnalysis {
  stats: {
    totalTrades: number;
    openTrades: number;
    winners: number;
    losers: number;
    winRate: number;
    totalPnl: number;
    grossProfit: number;
    grossLoss: number;
    avgWin: number;
    avgLoss: number;
    profitFactor: number;
    avgHoldDays: number;
  };
  trades: {
    symbol: string;
    underlying: string;
    type: string;
    openSide: string;
    openDate: string;
    openPrice: number;
    openQty: number;
    closeDate: string | null;
    closePrice: number | null;
    pnl: number | null;
    pnlPct: number | null;
    holdDays: number | null;
    status: string;
  }[];
  dailyPnl: { date: string; pnl: number }[];
  weeklyPnl: { week: string; pnl: number }[];
  monthlyPnl: { month: string; pnl: number }[];
}

interface PortfolioHistory {
  timestamp: number[];
  equity: number[];
  profit_loss: number[];
  profit_loss_pct: number[];
}

function pnl(val: number) {
  return val > 0 ? "text-emerald-400" : val < 0 ? "text-red-400" : "text-muted-foreground";
}

function fmt(val: number) {
  return val >= 0 ? `+$${val.toLocaleString()}` : `-$${Math.abs(val).toLocaleString()}`;
}

function parseOptionSymbol(symbol: string) {
  const match = symbol.match(/^([A-Z]+)(\d{6})([CP])(\d+)$/);
  if (!match) return null;
  const underlying = match[1];
  const dateStr = match[2]; // YYMMDD
  const type = match[3] === "C" ? "CALL" : "PUT";
  const strike = parseInt(match[4]) / 1000;
  const expiry = new Date(`20${dateStr.slice(0, 2)}-${dateStr.slice(2, 4)}-${dateStr.slice(4, 6)}`);
  const now = new Date();
  const dte = Math.max(0, Math.ceil((expiry.getTime() - now.getTime()) / (1000 * 60 * 60 * 24)));
  return { underlying, type, strike, expiry: expiry.toLocaleDateString("en-US", { month: "short", day: "numeric" }), dte };
}

export default function PerformancePage() {
  const [data, setData] = useState<TradeAnalysis | null>(null);
  const [history, setHistory] = useState<PortfolioHistory | null>(null);
  const [positions, setPositions] = useState<Position[]>([]);

  useEffect(() => {
    fetch("/api/trades/analysis").then((r) => r.json()).then(setData).catch(console.error);
    fetch("/api/portfolio-history?period=1M&timeframe=1D").then((r) => r.json()).then((d) => { if (!d.error) setHistory(d); }).catch(() => {});
    fetch("/api/positions").then((r) => r.json()).then((p) => { if (Array.isArray(p)) setPositions(p); }).catch(() => {});
  }, []);

  if (!data) return <div className="p-6 text-muted-foreground">Loading...</div>;

  const s = data.stats;

  // Equity curve from portfolio history
  const equityData = history?.timestamp?.map((t, i) => ({
    date: new Date(t * 1000).toLocaleDateString("en-US", { month: "short", day: "numeric" }),
    equity: history.equity[i],
    pnl: history.profit_loss[i],
  })) || [];

  const maxEquity = Math.max(...(equityData.map((d) => d.equity) || [100000]));
  const minEquity = Math.min(...(equityData.map((d) => d.equity) || [100000]));
  const equityRange = maxEquity - minEquity || 1;

  return (
    <div className="space-y-6 animate-fade-up">
      <div>
        <h1 className="text-2xl font-bold">How Is The Agent Doing?</h1>
        <p className="text-sm text-muted-foreground">Complete breakdown of every trade, profit, and loss</p>
      </div>

      {/* Big P&L */}
      <Card className={`border-2 ${s.totalPnl >= 0 ? "border-emerald-500/30" : "border-red-500/30"}`}>
        <CardContent className="pt-6 pb-4 text-center">
          <p className="text-sm text-muted-foreground mb-1">Total Realized Profit / Loss</p>
          <p className={`text-5xl font-bold ${pnl(s.totalPnl)}`}>{fmt(s.totalPnl)}</p>
          <p className="text-sm text-muted-foreground mt-2">
            {s.winners} wins, {s.losers} losses from {s.totalTrades} completed trades ({s.openTrades} still open)
          </p>
        </CardContent>
      </Card>

      {/* Key Stats */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Card>
          <CardContent className="pt-4 pb-3">
            <p className="text-[10px] text-muted-foreground/60 uppercase tracking-wider">Win Rate</p>
            <p className={`text-2xl font-bold mt-1 ${s.winRate >= 55 ? "text-emerald-400" : "text-red-400"}`}>{s.winRate}%</p>
            <p className="text-[10px] text-muted-foreground/50">{s.winRate >= 55 ? "Above target (55%)" : "Below target (need 55%)"}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-4 pb-3">
            <p className="text-[10px] text-muted-foreground/60 uppercase tracking-wider">Avg Win</p>
            <p className="text-2xl font-bold mt-1 text-emerald-400">+${s.avgWin.toFixed(0)}</p>
            <p className="text-[10px] text-muted-foreground/50">Per winning trade</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-4 pb-3">
            <p className="text-[10px] text-muted-foreground/60 uppercase tracking-wider">Avg Loss</p>
            <p className="text-2xl font-bold mt-1 text-red-400">-${s.avgLoss.toFixed(0)}</p>
            <p className="text-[10px] text-muted-foreground/50">Per losing trade</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-4 pb-3">
            <p className="text-[10px] text-muted-foreground/60 uppercase tracking-wider">Avg Hold Time</p>
            <p className="text-2xl font-bold mt-1">{s.avgHoldDays} days</p>
            <p className="text-[10px] text-muted-foreground/50">Average trade duration</p>
          </CardContent>
        </Card>
      </div>

      {/* Open Options Positions */}
      {(() => {
        const optionPositions = positions.filter((p) => parseOptionSymbol(p.symbol));
        const stockPositions = positions.filter((p) => !parseOptionSymbol(p.symbol));
        if (optionPositions.length === 0 && stockPositions.length === 0) return null;
        return (
          <>
            {optionPositions.length > 0 && (
              <Card className="border-2 border-purple-500/20">
                <CardHeader>
                  <CardTitle className="text-sm">Open Options Positions ({optionPositions.length})</CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="overflow-x-auto">
                    <table className="w-full text-xs">
                      <thead>
                        <tr className="text-muted-foreground/60 border-b border-white/10">
                          <th className="text-left py-2 font-medium">Underlying</th>
                          <th className="text-left py-2 font-medium">Type</th>
                          <th className="text-right py-2 font-medium">Strike</th>
                          <th className="text-right py-2 font-medium">Expiry</th>
                          <th className="text-right py-2 font-medium">DTE</th>
                          <th className="text-right py-2 font-medium">Qty</th>
                          <th className="text-right py-2 font-medium">Entry</th>
                          <th className="text-right py-2 font-medium">Current</th>
                          <th className="text-right py-2 font-medium">Mkt Value</th>
                          <th className="text-right py-2 font-medium">P&L</th>
                          <th className="text-right py-2 font-medium">% P&L</th>
                        </tr>
                      </thead>
                      <tbody>
                        {optionPositions.map((p, i) => {
                          const opt = parseOptionSymbol(p.symbol)!;
                          const pl = parseFloat(p.unrealized_pl);
                          const plPct = (parseFloat(p.unrealized_plpc) * 100);
                          return (
                            <tr key={i} className="border-b border-white/[0.04] hover:bg-white/[0.02]">
                              <td className="py-2 font-bold">{opt.underlying}</td>
                              <td className="py-2">
                                <span className={`px-1.5 py-0.5 rounded text-[10px] ${
                                  opt.type === "CALL" ? "bg-emerald-500/15 text-emerald-400" : "bg-red-500/15 text-red-400"
                                }`}>{opt.type}</span>
                              </td>
                              <td className="py-2 text-right">${opt.strike.toFixed(0)}</td>
                              <td className="py-2 text-right text-muted-foreground">{opt.expiry}</td>
                              <td className={`py-2 text-right font-medium ${opt.dte <= 7 ? "text-red-400" : opt.dte <= 14 ? "text-yellow-400" : "text-muted-foreground"}`}>{opt.dte}d</td>
                              <td className="py-2 text-right">{p.qty} {p.side === "long" ? "L" : "S"}</td>
                              <td className="py-2 text-right">${parseFloat(p.avg_entry_price).toFixed(2)}</td>
                              <td className="py-2 text-right">${parseFloat(p.current_price).toFixed(2)}</td>
                              <td className="py-2 text-right">${parseFloat(p.market_value).toLocaleString()}</td>
                              <td className={`py-2 text-right font-bold ${pnl(pl)}`}>{fmt(Math.round(pl))}</td>
                              <td className={`py-2 text-right ${pnl(plPct)}`}>{plPct > 0 ? "+" : ""}{plPct.toFixed(1)}%</td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                  <div className="mt-3 flex gap-4 text-xs text-muted-foreground">
                    <span>Total Options P&L: <span className={`font-bold ${pnl(optionPositions.reduce((s, p) => s + parseFloat(p.unrealized_pl), 0))}`}>
                      {fmt(Math.round(optionPositions.reduce((s, p) => s + parseFloat(p.unrealized_pl), 0)))}
                    </span></span>
                    <span>Total Market Value: <span className="font-bold">${Math.round(optionPositions.reduce((s, p) => s + Math.abs(parseFloat(p.market_value)), 0)).toLocaleString()}</span></span>
                  </div>
                </CardContent>
              </Card>
            )}
            {stockPositions.length > 0 && (
              <Card>
                <CardHeader>
                  <CardTitle className="text-sm">Open Stock Positions ({stockPositions.length})</CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="overflow-x-auto">
                    <table className="w-full text-xs">
                      <thead>
                        <tr className="text-muted-foreground/60 border-b border-white/10">
                          <th className="text-left py-2 font-medium">Symbol</th>
                          <th className="text-right py-2 font-medium">Qty</th>
                          <th className="text-right py-2 font-medium">Entry</th>
                          <th className="text-right py-2 font-medium">Current</th>
                          <th className="text-right py-2 font-medium">Mkt Value</th>
                          <th className="text-right py-2 font-medium">P&L</th>
                          <th className="text-right py-2 font-medium">% P&L</th>
                        </tr>
                      </thead>
                      <tbody>
                        {stockPositions.map((p, i) => {
                          const pl = parseFloat(p.unrealized_pl);
                          const plPct = (parseFloat(p.unrealized_plpc) * 100);
                          return (
                            <tr key={i} className="border-b border-white/[0.04] hover:bg-white/[0.02]">
                              <td className="py-2 font-bold">{p.symbol}</td>
                              <td className="py-2 text-right">{p.qty} {p.side === "long" ? "L" : "S"}</td>
                              <td className="py-2 text-right">${parseFloat(p.avg_entry_price).toFixed(2)}</td>
                              <td className="py-2 text-right">${parseFloat(p.current_price).toFixed(2)}</td>
                              <td className="py-2 text-right">${parseFloat(p.market_value).toLocaleString()}</td>
                              <td className={`py-2 text-right font-bold ${pnl(pl)}`}>{fmt(Math.round(pl))}</td>
                              <td className={`py-2 text-right ${pnl(plPct)}`}>{plPct > 0 ? "+" : ""}{plPct.toFixed(1)}%</td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                </CardContent>
              </Card>
            )}
          </>
        );
      })()}

      {/* Equity Curve */}
      {equityData.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Account Value Over Time</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="h-48 flex items-end gap-[2px] relative">
              {/* Y-axis labels */}
              <div className="absolute left-0 top-0 text-[9px] text-muted-foreground/40">${(maxEquity / 1000).toFixed(1)}k</div>
              <div className="absolute left-0 bottom-0 text-[9px] text-muted-foreground/40">${(minEquity / 1000).toFixed(1)}k</div>
              {equityData.map((d, i) => {
                const height = ((d.equity - minEquity) / equityRange) * 100;
                const isUp = d.pnl >= 0;
                return (
                  <div key={i} className="flex-1 flex flex-col justify-end h-full relative group cursor-pointer">
                    <div
                      className={`w-full rounded-t-sm ${isUp ? "bg-emerald-500/50" : "bg-red-500/50"}`}
                      style={{ height: `${Math.max(2, height)}%` }}
                    />
                    <div className="absolute -top-12 left-1/2 -translate-x-1/2 bg-card border border-border rounded-lg px-3 py-1.5 text-[10px] whitespace-nowrap hidden group-hover:block z-10 shadow-lg">
                      <div className="font-bold">{d.date}</div>
                      <div>Account: ${d.equity.toLocaleString()}</div>
                      <div className={pnl(d.pnl)}>Day: {fmt(d.pnl)}</div>
                    </div>
                  </div>
                );
              })}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Daily / Weekly / Monthly P&L */}
      <div className="grid md:grid-cols-3 gap-4">
        <Card>
          <CardHeader><CardTitle className="text-sm">Daily P&L</CardTitle></CardHeader>
          <CardContent>
            <div className="space-y-1.5 max-h-64 overflow-y-auto">
              {data.dailyPnl.length === 0 && <p className="text-xs text-muted-foreground">No data</p>}
              {[...data.dailyPnl].reverse().map((d) => (
                <div key={d.date} className="flex justify-between text-xs">
                  <span className="text-muted-foreground">{new Date(d.date + "T12:00:00").toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" })}</span>
                  <span className={`font-medium ${pnl(d.pnl)}`}>{fmt(d.pnl)}</span>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle className="text-sm">Weekly P&L</CardTitle></CardHeader>
          <CardContent>
            <div className="space-y-1.5 max-h-64 overflow-y-auto">
              {data.weeklyPnl.length === 0 && <p className="text-xs text-muted-foreground">No data</p>}
              {data.weeklyPnl.map((w) => (
                <div key={w.week} className="flex justify-between text-xs">
                  <span className="text-muted-foreground">{w.week}</span>
                  <span className={`font-medium ${pnl(w.pnl)}`}>{fmt(w.pnl)}</span>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle className="text-sm">Monthly P&L</CardTitle></CardHeader>
          <CardContent>
            <div className="space-y-1.5 max-h-64 overflow-y-auto">
              {data.monthlyPnl.length === 0 && <p className="text-xs text-muted-foreground">No data</p>}
              {data.monthlyPnl.map((m) => (
                <div key={m.month} className="flex justify-between text-xs">
                  <span className="text-muted-foreground">{m.month}</span>
                  <span className={`font-medium ${pnl(m.pnl)}`}>{fmt(m.pnl)}</span>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Every Trade */}
      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Every Trade (Newest First)</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="text-muted-foreground/60 border-b border-white/10">
                  <th className="text-left py-2.5 font-medium">Date</th>
                  <th className="text-left py-2.5 font-medium">Stock</th>
                  <th className="text-left py-2.5 font-medium">Type</th>
                  <th className="text-left py-2.5 font-medium">Direction</th>
                  <th className="text-right py-2.5 font-medium">Qty</th>
                  <th className="text-right py-2.5 font-medium">Bought At</th>
                  <th className="text-right py-2.5 font-medium">Sold At</th>
                  <th className="text-right py-2.5 font-medium">Profit / Loss</th>
                  <th className="text-right py-2.5 font-medium">% Return</th>
                  <th className="text-right py-2.5 font-medium">Held</th>
                  <th className="text-center py-2.5 font-medium">Result</th>
                </tr>
              </thead>
              <tbody>
                {data.trades.map((t, i) => (
                  <tr key={i} className="border-b border-white/[0.04] hover:bg-white/[0.02]">
                    <td className="py-2.5 text-muted-foreground text-[10px]">
                      {new Date(t.openDate).toLocaleDateString("en-US", { month: "short", day: "numeric" })}
                      <br />
                      {new Date(t.openDate).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" })}
                    </td>
                    <td className="py-2.5 font-bold">{t.underlying}</td>
                    <td className="py-2.5">
                      <span className={`px-1.5 py-0.5 rounded text-[10px] ${
                        t.type === "CALL" ? "bg-emerald-500/15 text-emerald-400" :
                        t.type === "PUT" ? "bg-red-500/15 text-red-400" :
                        "bg-blue-500/15 text-blue-400"
                      }`}>{t.type}</span>
                    </td>
                    <td className="py-2.5 text-muted-foreground">{t.openSide.toUpperCase()}</td>
                    <td className="py-2.5 text-right">{t.openQty}</td>
                    <td className="py-2.5 text-right">${t.openPrice.toFixed(2)}</td>
                    <td className="py-2.5 text-right">{t.closePrice ? `$${t.closePrice.toFixed(2)}` : "—"}</td>
                    <td className={`py-2.5 text-right font-bold ${t.pnl != null ? pnl(t.pnl) : ""}`}>
                      {t.pnl != null ? fmt(t.pnl) : "Open"}
                    </td>
                    <td className={`py-2.5 text-right ${t.pnlPct != null ? pnl(t.pnlPct) : ""}`}>
                      {t.pnlPct != null ? `${t.pnlPct > 0 ? "+" : ""}${t.pnlPct}%` : "—"}
                    </td>
                    <td className="py-2.5 text-right text-muted-foreground">{t.holdDays != null ? `${t.holdDays}d` : "—"}</td>
                    <td className="py-2.5 text-center">
                      {t.status === "open" ? (
                        <span className="px-2 py-0.5 rounded-full text-[10px] bg-blue-500/15 text-blue-400">OPEN</span>
                      ) : t.status === "winner" ? (
                        <span className="px-2 py-0.5 rounded-full text-[10px] bg-emerald-500/15 text-emerald-400">WIN</span>
                      ) : (
                        <span className="px-2 py-0.5 rounded-full text-[10px] bg-red-500/15 text-red-400">LOSS</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>

      {/* Ready Checklist */}
      <Card className="border-2 border-white/10">
        <CardHeader>
          <CardTitle className="text-sm">Safe to Use Real Money?</CardTitle>
          <p className="text-xs text-muted-foreground">All items must be green before switching to live trading</p>
        </CardHeader>
        <CardContent>
          <div className="space-y-3">
            {[
              { check: s.totalTrades >= 50, label: "Made at least 50 trades (enough data to trust)", value: `${s.totalTrades}/50` },
              { check: s.winRate >= 55, label: "Wins more often than it loses (55%+)", value: `${s.winRate}%` },
              { check: s.profitFactor >= 1.5, label: "Wins are bigger than losses (1.5x+)", value: `${s.profitFactor}x` },
              { check: s.totalPnl > 0, label: "Overall profitable", value: fmt(s.totalPnl) },
              { check: s.avgWin > s.avgLoss, label: "Average win > average loss", value: `$${s.avgWin.toFixed(0)} vs $${s.avgLoss.toFixed(0)}` },
            ].map((item, i) => (
              <div key={i} className="flex items-center gap-3 text-sm">
                <span className={`w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold ${
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
