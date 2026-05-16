"use client";

import { useEffect, useState, useMemo } from "react";
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

interface FuturesRoundTrip {
  symbol: string;
  direction: string;
  qty: number;
  entryPrice: number;
  exitPrice: number;
  pnl: number;
  entryTime: string;
  exitTime: string;
}

interface FuturesPerfData {
  connected: boolean;
  account: { balance: number; netLiq: number; realizedPnl: number } | null;
  fillBasedPnl?: {
    totalPnl: number;
    tradeCount: number;
    wins: number;
    losses: number;
    roundTrips: FuturesRoundTrip[];
  };
  activity: { id: string; symbol: string; action: string; qty: number; price: number | null; pnl: number | null; reason: string; time: string }[];
}

export default function PerformancePage() {
  const [data, setData] = useState<TradeAnalysis | null>(null);
  const [history, setHistory] = useState<PortfolioHistory | null>(null);
  const [positions, setPositions] = useState<Position[]>([]);
  const [futures, setFutures] = useState<FuturesPerfData | null>(null);
  const [activeTab, setActiveTab] = useState<"options" | "futures" | "paper">("options");

  useEffect(() => {
    fetch("/api/trades/analysis").then((r) => r.json()).then(setData).catch(console.error);
    fetch("/api/portfolio-history?period=1M&timeframe=1D").then((r) => r.json()).then((d) => { if (!d.error) setHistory(d); }).catch(() => {});
    fetch("/api/positions").then((r) => r.json()).then((p) => { if (Array.isArray(p)) setPositions(p); }).catch(() => {});
    fetch("/api/futures/positions").then((r) => r.json()).then((d) => { if (!d.error) setFutures(d); }).catch(() => {});
  }, []);

  if (!data) return (
    <div className="space-y-5 animate-fade-up">
      <div>
        <div className="skeleton h-6 w-48 rounded mb-2" />
        <div className="skeleton h-3 w-64 rounded" />
      </div>
      <div className="skeleton h-32 w-full rounded-xl" />
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="rounded-xl border border-white/[0.06] bg-white/[0.02] p-4">
            <div className="skeleton h-3 w-14 rounded mb-2" />
            <div className="skeleton h-6 w-20 rounded" />
          </div>
        ))}
      </div>
    </div>
  );

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
        <h1 className="text-xl font-bold tracking-tight">Performance</h1>
        <p className="text-[11px] text-muted-foreground/50">Options &amp; Futures — trade analytics by account</p>
      </div>

      {/* Account Tabs */}
      <div className="flex gap-1.5">
        <button
          onClick={() => setActiveTab("options")}
          className={`px-3 py-1.5 rounded-full text-xs font-medium transition-all ${
            activeTab === "options"
              ? "bg-purple-500/15 text-purple-400 ring-1 ring-purple-500/30"
              : "bg-white/[0.04] text-muted-foreground hover:bg-white/[0.08]"
          }`}
        >
          Options / Alpaca
        </button>
        <button
          onClick={() => setActiveTab("futures")}
          className={`px-3 py-1.5 rounded-full text-xs font-medium transition-all ${
            activeTab === "futures"
              ? "bg-amber-500/15 text-amber-400 ring-1 ring-amber-500/30"
              : "bg-white/[0.04] text-muted-foreground hover:bg-white/[0.08]"
          }`}
        >
          Futures / Tradovate
        </button>
        <button
          onClick={() => setActiveTab("paper")}
          className={`px-3 py-1.5 rounded-full text-xs font-medium transition-all ${
            activeTab === "paper"
              ? "bg-violet-500/15 text-violet-400 ring-1 ring-violet-500/30"
              : "bg-white/[0.04] text-muted-foreground hover:bg-white/[0.08]"
          }`}
        >
          Paper Trades
        </button>
      </div>

      {activeTab === "options" && <>
      {/* Big P&L */}
      <Card className={`border-2 ${s.totalPnl >= 0 ? "border-emerald-500/30 bg-gradient-to-br from-emerald-500/[0.03] to-transparent" : "border-red-500/30 bg-gradient-to-br from-red-500/[0.03] to-transparent"}`}>
        <CardContent className="pt-6 pb-4 text-center">
          <p className="text-sm text-muted-foreground mb-1">Total Realized Profit / Loss</p>
          <p className={`text-5xl font-black tracking-tight ${pnl(s.totalPnl)}`}>{fmt(s.totalPnl)}</p>
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

      </>}

      {activeTab === "futures" && (() => {
        const fp = futures?.fillBasedPnl;
        const closedFromDb = (futures?.activity || []).filter((t) => t.pnl != null);
        const hasFillData = !!fp && fp.tradeCount > closedFromDb.length;
        const tradeCount = hasFillData ? fp.tradeCount : closedFromDb.length;
        const winCount = hasFillData ? fp.wins : closedFromDb.filter((t) => (t.pnl || 0) > 0).length;
        const lossCount = hasFillData ? fp.losses : closedFromDb.filter((t) => (t.pnl || 0) < 0).length;
        const STARTING_CAPITAL = 7_000;
        const accountPnl = futures?.account?.balance ? futures.account.balance - STARTING_CAPITAL : null;
        const totalPnl = accountPnl ?? (hasFillData ? fp.totalPnl : closedFromDb.reduce((s, t) => s + (t.pnl || 0), 0));
        const winRate = tradeCount > 0 ? (winCount / tradeCount * 100) : 0;

        const roundTrips = fp?.roundTrips || [];
        const wins = roundTrips.filter((rt) => rt.pnl > 0);
        const losses = roundTrips.filter((rt) => rt.pnl < 0);
        const avgWin = wins.length > 0 ? wins.reduce((s, rt) => s + rt.pnl, 0) / wins.length : 0;
        const avgLoss = losses.length > 0 ? losses.reduce((s, rt) => s + rt.pnl, 0) / losses.length : 0;

        // Daily breakdown from round trips
        const dayMap: Record<string, { trades: number; wins: number; losses: number; totalPnl: number; label: string }> = {};
        for (const rt of roundTrips) {
          const d = new Date(rt.exitTime);
          const dateKey = d.toLocaleDateString("en-CA", { timeZone: "America/New_York" });
          const label = d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "America/New_York" });
          if (!dayMap[dateKey]) dayMap[dateKey] = { trades: 0, wins: 0, losses: 0, totalPnl: 0, label };
          dayMap[dateKey].trades++;
          if (rt.pnl > 0) dayMap[dateKey].wins++;
          else dayMap[dateKey].losses++;
          dayMap[dateKey].totalPnl += rt.pnl;
        }
        const days = Object.entries(dayMap).sort(([a], [b]) => b.localeCompare(a));

        if (tradeCount === 0 && !futures?.connected) {
          return (
            <Card>
              <CardContent className="py-8 text-center">
                <p className="text-sm text-muted-foreground/50">Tradovate not connected — futures data unavailable</p>
              </CardContent>
            </Card>
          );
        }

        return (
          <>
            {/* Futures Big P&L */}
            <Card className={`border-2 ${totalPnl >= 0 ? "border-emerald-500/30 bg-gradient-to-br from-emerald-500/[0.03] to-transparent" : "border-red-500/30 bg-gradient-to-br from-red-500/[0.03] to-transparent"}`}>
              <CardContent className="pt-6 pb-4 text-center">
                <p className="text-sm text-muted-foreground mb-1">Futures Realized P&L</p>
                <p className={`text-5xl font-black tracking-tight ${pnl(totalPnl)}`}>{fmt(Math.round(totalPnl))}</p>
                <p className="text-sm text-muted-foreground mt-2">
                  {winCount} wins, {lossCount} losses from {tradeCount} completed trades
                </p>
              </CardContent>
            </Card>

            {/* Futures Key Stats */}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              <Card>
                <CardContent className="pt-4 pb-3">
                  <p className="text-[10px] text-muted-foreground/60 uppercase tracking-wider">Win Rate</p>
                  <p className={`text-2xl font-bold mt-1 ${winRate >= 50 ? "text-emerald-400" : "text-red-400"}`}>{winRate.toFixed(0)}%</p>
                  <p className="text-[10px] text-muted-foreground/50">{winCount}W / {lossCount}L</p>
                </CardContent>
              </Card>
              <Card>
                <CardContent className="pt-4 pb-3">
                  <p className="text-[10px] text-muted-foreground/60 uppercase tracking-wider">Avg Win</p>
                  <p className="text-2xl font-bold mt-1 text-emerald-400">{avgWin > 0 ? `+$${avgWin.toFixed(0)}` : "—"}</p>
                  <p className="text-[10px] text-muted-foreground/50">Per winning trade</p>
                </CardContent>
              </Card>
              <Card>
                <CardContent className="pt-4 pb-3">
                  <p className="text-[10px] text-muted-foreground/60 uppercase tracking-wider">Avg Loss</p>
                  <p className="text-2xl font-bold mt-1 text-red-400">{avgLoss < 0 ? `-$${Math.abs(avgLoss).toFixed(0)}` : "—"}</p>
                  <p className="text-[10px] text-muted-foreground/50">Per losing trade</p>
                </CardContent>
              </Card>
              <Card>
                <CardContent className="pt-4 pb-3">
                  <p className="text-[10px] text-muted-foreground/60 uppercase tracking-wider">Profit Factor</p>
                  <p className={`text-2xl font-bold mt-1 ${wins.length > 0 && losses.length > 0 ? (wins.reduce((s, r) => s + r.pnl, 0) / Math.abs(losses.reduce((s, r) => s + r.pnl, 0)) >= 1 ? "text-emerald-400" : "text-red-400") : "text-muted-foreground"}`}>
                    {wins.length > 0 && losses.length > 0
                      ? (wins.reduce((s, r) => s + r.pnl, 0) / Math.abs(losses.reduce((s, r) => s + r.pnl, 0))).toFixed(2)
                      : "—"}
                  </p>
                  <p className="text-[10px] text-muted-foreground/50">Gross profit / gross loss</p>
                </CardContent>
              </Card>
            </div>

            {/* Futures Account Value */}
            {futures?.account && (
              <Card>
                <CardContent className="pt-4 pb-3">
                  <div className="grid grid-cols-3 gap-4">
                    <div>
                      <p className="text-[10px] text-muted-foreground/60 uppercase tracking-wider">Account Balance</p>
                      <p className="text-xl font-bold mt-1">{fmt(Math.round(futures.account.balance))}</p>
                    </div>
                    <div>
                      <p className="text-[10px] text-muted-foreground/60 uppercase tracking-wider">Net Liquidation</p>
                      <p className="text-xl font-bold mt-1">{fmt(Math.round(futures.account.netLiq))}</p>
                    </div>
                    <div>
                      <p className="text-[10px] text-muted-foreground/60 uppercase tracking-wider">Today Realized</p>
                      <p className={`text-xl font-bold mt-1 ${pnl(futures.account.realizedPnl)}`}>{fmt(Math.round(futures.account.realizedPnl))}</p>
                    </div>
                  </div>
                </CardContent>
              </Card>
            )}

            {/* Futures Daily / Weekly / Monthly P&L */}
            {roundTrips.length > 0 && (() => {
              // Weekly breakdown
              const weekMap: Record<string, { pnl: number; label: string }> = {};
              for (const rt of roundTrips) {
                const d = new Date(rt.exitTime);
                const weekStart = new Date(d);
                weekStart.setDate(d.getDate() - d.getDay());
                const key = weekStart.toLocaleDateString("en-CA", { timeZone: "America/New_York" });
                const label = `Week of ${weekStart.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "America/New_York" })}`;
                if (!weekMap[key]) weekMap[key] = { pnl: 0, label };
                weekMap[key].pnl += rt.pnl;
              }
              const weeks = Object.entries(weekMap).sort(([a], [b]) => b.localeCompare(a));

              // Monthly breakdown
              const monthMap: Record<string, { pnl: number; label: string }> = {};
              for (const rt of roundTrips) {
                const d = new Date(rt.exitTime);
                const key = d.toLocaleDateString("en-CA", { timeZone: "America/New_York" }).slice(0, 7);
                const label = d.toLocaleDateString("en-US", { month: "long", year: "numeric", timeZone: "America/New_York" });
                if (!monthMap[key]) monthMap[key] = { pnl: 0, label };
                monthMap[key].pnl += rt.pnl;
              }
              const months = Object.entries(monthMap).sort(([a], [b]) => b.localeCompare(a));

              return (
                <div className="grid md:grid-cols-3 gap-4">
                  <Card>
                    <CardHeader><CardTitle className="text-sm">Daily P&L</CardTitle></CardHeader>
                    <CardContent>
                      <div className="space-y-1.5 max-h-64 overflow-y-auto">
                        {days.map(([dateKey, d]) => (
                          <div key={dateKey} className="flex justify-between text-xs">
                            <span className="text-muted-foreground">{d.label}</span>
                            <span className={`font-medium ${pnl(d.totalPnl)}`}>
                              {d.totalPnl >= 0 ? "+" : "-"}${Math.abs(d.totalPnl).toFixed(0)}
                            </span>
                          </div>
                        ))}
                      </div>
                    </CardContent>
                  </Card>
                  <Card>
                    <CardHeader><CardTitle className="text-sm">Weekly P&L</CardTitle></CardHeader>
                    <CardContent>
                      <div className="space-y-1.5 max-h-64 overflow-y-auto">
                        {weeks.map(([key, w]) => (
                          <div key={key} className="flex justify-between text-xs">
                            <span className="text-muted-foreground">{w.label}</span>
                            <span className={`font-medium ${pnl(w.pnl)}`}>
                              {w.pnl >= 0 ? "+" : "-"}${Math.abs(w.pnl).toFixed(0)}
                            </span>
                          </div>
                        ))}
                      </div>
                    </CardContent>
                  </Card>
                  <Card>
                    <CardHeader><CardTitle className="text-sm">Monthly P&L</CardTitle></CardHeader>
                    <CardContent>
                      <div className="space-y-1.5 max-h-64 overflow-y-auto">
                        {months.map(([key, m]) => (
                          <div key={key} className="flex justify-between text-xs">
                            <span className="text-muted-foreground">{m.label}</span>
                            <span className={`font-medium ${pnl(m.pnl)}`}>
                              {m.pnl >= 0 ? "+" : "-"}${Math.abs(m.pnl).toFixed(0)}
                            </span>
                          </div>
                        ))}
                      </div>
                    </CardContent>
                  </Card>
                </div>
              );
            })()}

            {/* Futures Daily Breakdown Table */}
            {days.length > 0 && (
              <Card>
                <CardHeader>
                  <CardTitle className="text-sm">Daily Futures Performance</CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="overflow-x-auto">
                    <table className="w-full text-xs">
                      <thead>
                        <tr className="text-muted-foreground/60 border-b border-white/10">
                          <th className="text-left py-2 font-medium">Date</th>
                          <th className="text-center py-2 font-medium">Trades</th>
                          <th className="text-center py-2 font-medium">Wins</th>
                          <th className="text-center py-2 font-medium">Losses</th>
                          <th className="text-center py-2 font-medium">Win Rate</th>
                          <th className="text-right py-2 font-medium">Total P&L</th>
                          <th className="text-right py-2 font-medium">Avg P&L</th>
                        </tr>
                      </thead>
                      <tbody>
                        {days.map(([dateKey, d]) => {
                          const wr = d.trades > 0 ? (d.wins / d.trades * 100) : 0;
                          const avg = d.trades > 0 ? d.totalPnl / d.trades : 0;
                          return (
                            <tr key={dateKey} className="border-b border-white/[0.04] hover:bg-white/[0.02]">
                              <td className="py-2 font-medium">{d.label}</td>
                              <td className="text-center py-2">{d.trades}</td>
                              <td className="text-center py-2 text-emerald-400">{d.wins}</td>
                              <td className="text-center py-2 text-red-400">{d.losses}</td>
                              <td className="text-center py-2">
                                <span className={wr >= 50 ? "text-emerald-400" : "text-red-400"}>{wr.toFixed(0)}%</span>
                              </td>
                              <td className={`text-right py-2 font-bold ${pnl(d.totalPnl)}`}>
                                {d.totalPnl >= 0 ? "+" : "-"}${Math.abs(d.totalPnl).toFixed(0)}
                              </td>
                              <td className={`text-right py-2 ${pnl(avg)}`}>
                                {avg >= 0 ? "+" : "-"}${Math.abs(avg).toFixed(0)}
                              </td>
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

      {/* ═══════════ PAPER TRADES TAB ═══════════ */}
      {activeTab === "paper" && (() => {
        // Paper trades from futures activity (action starts with paper_)
        const allActivity = futures?.activity || [];
        const paperTrades = allActivity.filter((t) => t.action.startsWith("paper_"));
        const scoredPapers = paperTrades.filter((t) => t.pnl != null);
        const unscoredPapers = paperTrades.filter((t) => t.pnl == null);
        const paperWins = scoredPapers.filter((t) => (t.pnl || 0) > 0);
        const paperLosses = scoredPapers.filter((t) => (t.pnl || 0) < 0);
        const paperTotalPnl = scoredPapers.reduce((s, t) => s + (t.pnl || 0), 0);
        const paperWinRate = scoredPapers.length > 0 ? (paperWins.length / scoredPapers.length * 100) : 0;
        const paperAvgWin = paperWins.length > 0 ? paperWins.reduce((s, t) => s + (t.pnl || 0), 0) / paperWins.length : 0;
        const paperAvgLoss = paperLosses.length > 0 ? paperLosses.reduce((s, t) => s + (t.pnl || 0), 0) / paperLosses.length : 0;

        return (
          <>
            <Card className="border-2 border-violet-500/20 bg-gradient-to-br from-violet-500/[0.03] to-transparent">
              <CardContent className="pt-6 pb-4 text-center">
                <p className="text-sm text-muted-foreground mb-1">Hypothetical P&L — if these were real trades</p>
                <p className={`text-5xl font-black tracking-tight ${pnl(paperTotalPnl)}`}>{fmt(Math.round(paperTotalPnl))}</p>
                <p className="text-sm text-muted-foreground mt-2">
                  {scoredPapers.length} scored ({paperWins.length}W / {paperLosses.length}L) · {unscoredPapers.length} awaiting EOD review
                </p>
              </CardContent>
            </Card>

            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              <Card>
                <CardContent className="pt-4 pb-3">
                  <p className="text-[10px] text-muted-foreground/60 uppercase tracking-wider">Paper Win Rate</p>
                  <p className={`text-2xl font-bold mt-1 ${paperWinRate >= 50 ? "text-emerald-400" : "text-red-400"}`}>{paperWinRate.toFixed(0)}%</p>
                  <p className="text-[10px] text-muted-foreground/50">{paperWins.length}W / {paperLosses.length}L</p>
                </CardContent>
              </Card>
              <Card>
                <CardContent className="pt-4 pb-3">
                  <p className="text-[10px] text-muted-foreground/60 uppercase tracking-wider">Avg Paper Win</p>
                  <p className="text-2xl font-bold mt-1 text-emerald-400">{paperAvgWin > 0 ? `+$${paperAvgWin.toFixed(0)}` : "—"}</p>
                </CardContent>
              </Card>
              <Card>
                <CardContent className="pt-4 pb-3">
                  <p className="text-[10px] text-muted-foreground/60 uppercase tracking-wider">Avg Paper Loss</p>
                  <p className="text-2xl font-bold mt-1 text-red-400">{paperAvgLoss < 0 ? `-$${Math.abs(paperAvgLoss).toFixed(0)}` : "—"}</p>
                </CardContent>
              </Card>
              <Card>
                <CardContent className="pt-4 pb-3">
                  <p className="text-[10px] text-muted-foreground/60 uppercase tracking-wider">Total Paper Trades</p>
                  <p className="text-2xl font-bold mt-1">{paperTrades.length}</p>
                  <p className="text-[10px] text-muted-foreground/50">{scoredPapers.length} scored</p>
                </CardContent>
              </Card>
            </div>

            {/* Paper trade log */}
            {paperTrades.length > 0 && (
              <Card>
                <CardHeader>
                  <CardTitle className="text-sm">Paper Trade Log</CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="overflow-x-auto max-h-[400px] overflow-y-auto">
                    <table className="w-full text-xs">
                      <thead className="sticky top-0 bg-card z-10">
                        <tr className="text-muted-foreground/60 border-b border-white/10">
                          <th className="text-left py-2 font-medium">Time</th>
                          <th className="text-left py-2 font-medium">Symbol</th>
                          <th className="text-left py-2 font-medium">Direction</th>
                          <th className="text-right py-2 font-medium">Qty</th>
                          <th className="text-right py-2 font-medium">Entry</th>
                          <th className="text-right py-2 font-medium">Hypothetical P&L</th>
                          <th className="text-center py-2 font-medium">Result</th>
                        </tr>
                      </thead>
                      <tbody>
                        {paperTrades.map((t) => {
                          const result = t.pnl != null ? (t.pnl > 0 ? "WIN" : "LOSS") : "PENDING";
                          return (
                            <tr key={t.id} className="border-b border-white/[0.04] hover:bg-white/[0.02]">
                              <td className="py-2 text-muted-foreground/50 tabular-nums whitespace-nowrap">
                                {new Date(t.time).toLocaleDateString("en-US", { month: "short", day: "numeric" })}
                              </td>
                              <td className="py-2 font-bold">{t.symbol}</td>
                              <td className="py-2">
                                <span className={`px-1.5 py-0.5 rounded text-[10px] font-bold ${
                                  t.action.includes("long") ? "bg-emerald-500/15 text-emerald-400" : "bg-red-500/15 text-red-400"
                                }`}>{t.action.replace("paper_", "").toUpperCase()}</span>
                              </td>
                              <td className="py-2 text-right tabular-nums">{t.qty}</td>
                              <td className="py-2 text-right tabular-nums">{t.price ? `$${t.price.toFixed(2)}` : "—"}</td>
                              <td className={`py-2 text-right font-bold tabular-nums ${t.pnl != null ? pnl(t.pnl) : ""}`}>
                                {t.pnl != null ? `${t.pnl >= 0 ? "+" : ""}$${t.pnl.toFixed(0)}` : "—"}
                              </td>
                              <td className="py-2 text-center">
                                <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold ${
                                  result === "WIN" ? "bg-emerald-500/15 text-emerald-400" :
                                  result === "LOSS" ? "bg-red-500/15 text-red-400" :
                                  "bg-violet-500/15 text-violet-400"
                                }`}>{result}</span>
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                </CardContent>
              </Card>
            )}

            {paperTrades.length === 0 && (
              <Card>
                <CardContent className="py-12 text-center">
                  <p className="text-sm text-muted-foreground/50">No paper trades yet</p>
                  <p className="text-[11px] text-muted-foreground/30 mt-1">Set agents to "paper" mode in Agent Hub to start logging hypothetical trades</p>
                </CardContent>
              </Card>
            )}
          </>
        );
      })()}

      {/* Ready Checklist */}
      {activeTab === "options" && <Card className="border-2 border-white/10">
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
      </Card>}
    </div>
  );
}
