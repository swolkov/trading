"use client";

import { useEffect, useState, useMemo } from "react";
import useSWR from "swr";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { computeFuturesStats } from "./lib/compute-stats";

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
  balanceHistory?: { date: string; startBalance: number | null; endBalance: number | null }[];
  startingCapital?: number;
}

const swrFetcher = (url: string) => fetch(url).then((r) => r.json());

export default function PerformancePage() {
  const [data, setData] = useState<TradeAnalysis | null>(null);
  const [history, setHistory] = useState<PortfolioHistory | null>(null);
  const [positions, setPositions] = useState<Position[]>([]);
  const [futures, setFutures] = useState<FuturesPerfData | null>(null);
  const [activeTab, setActiveTab] = useState<"options" | "futures">("futures");
  const { data: modeData } = useSWR<{ modes: Record<string, string> }>("/api/trading-mode", swrFetcher, { refreshInterval: 10000 });
  const futuresViewMode = modeData?.modes?.futures || "paper";

  useEffect(() => {
    fetch("/api/trades/analysis").then((r) => r.json()).then(setData).catch(console.error);
    fetch("/api/portfolio-history?period=1M&timeframe=1D").then((r) => r.json()).then((d) => { if (!d.error) setHistory(d); }).catch(() => {});
    fetch("/api/positions").then((r) => r.json()).then((p) => { if (Array.isArray(p)) setPositions(p); }).catch(() => {});
  }, []);

  // Re-fetch futures data when view mode changes (LIVE ↔ DEMO)
  useEffect(() => {
    setFutures(null);
    fetch("/api/futures/positions").then((r) => r.json()).then((d) => { if (!d.error) setFutures(d); }).catch(() => {});
  }, [futuresViewMode]);

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
      <div className="flex items-center gap-3">
        <div>
          <h1 className="text-xl font-bold tracking-tight">Performance</h1>
          <p className="text-[11px] text-muted-foreground/50">Trading analytics — all asset classes</p>
        </div>
        <span className={`px-2.5 py-1 rounded-full text-[10px] font-bold tracking-wider uppercase ${
          futuresViewMode === "live"
            ? "bg-red-500/15 text-red-400 ring-1 ring-red-500/30"
            : "bg-emerald-500/15 text-emerald-400 ring-1 ring-emerald-500/30"
        }`}>
          {futuresViewMode === "live" ? "LIVE" : "DEMO"}
        </span>
      </div>

      {/* Futures Only */}
      <div className="flex gap-1.5">
        <span className="px-3 py-1.5 rounded-full text-xs font-medium bg-amber-500/15 text-amber-400 ring-1 ring-amber-500/30">
          Futures / Tradovate
        </span>
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
        // Exclude May 13 2026 — Railway outage prevented trade closure (infrastructure failure, not strategy)
        const EXCLUDED_DATES: string[] = []; // Clean account, no exclusions
        const toEtDate = (time: string) => new Date(time).toLocaleDateString("en-CA", { timeZone: "America/New_York" });
        const isExcludedDate = (time: string) => EXCLUDED_DATES.includes(toEtDate(time));

        const fp = futures?.fillBasedPnl;
        const allRoundTrips = fp?.roundTrips || [];
        const roundTrips = allRoundTrips.filter((rt) => !isExcludedDate(rt.exitTime));

        // Activity log fallback — ONLY when Tradovate fills are completely empty.
        // DB AutoTradeLog.pnl is unreliable (double-logging inflates losses ~2x).
        // Tradovate fills are the source of truth for per-trade P&L.
        const closedFromDb = (futures?.activity || []).filter((t) => t.pnl != null && !isExcludedDate(t.time) && !t.action.startsWith("paper_"));
        const useFills = roundTrips.length > 0;
        const STARTING_CAPITAL = futures?.startingCapital ?? 50_000;
        const accountPnl = futures?.account?.balance ? futures.account.balance - STARTING_CAPITAL : null;

        // Build synthetic round-trips from activity logs when fills aren't available
        // Note: activity close actions (stop_loss, take_profit, etc.) don't indicate direction,
        // so we check the reason field or mark as unknown
        const effectiveRoundTrips: FuturesRoundTrip[] = useFills ? roundTrips : closedFromDb.map((t) => {
          const reasonLower = (t.reason || "").toLowerCase();
          const actionLower = t.action.toLowerCase();
          const isLong = actionLower.includes("long") || reasonLower.includes("long") || reasonLower.includes("buy");
          const isShort = actionLower.includes("short") || reasonLower.includes("short") || reasonLower.includes("sell");
          return {
            symbol: t.symbol,
            direction: isLong ? "Long" : isShort ? "Short" : "—",
            qty: t.qty,
            entryPrice: t.price || 0,
            exitPrice: t.price || 0,
            pnl: t.pnl || 0,
            entryTime: t.time,
            exitTime: t.time,
          };
        });

        // ── Daily P&L from balance deltas (source of truth) ──
        // Per risk-management.md: NEVER sum trade P&L. Use Tradovate balance deltas.
        const balanceHistory = (futures?.balanceHistory || []).filter((b) => !EXCLUDED_DATES.includes(b.date));
        const balancePnlByDate: Record<string, number> = {};
        const dayMap: Record<string, { trades: number; wins: number; losses: number; totalPnl: number; label: string; hasBalanceData: boolean }> = {};

        // Build balance-based daily P&L lookup
        const sortedBal = [...balanceHistory].sort((a, b) => a.date.localeCompare(b.date));
        for (let i = 0; i < sortedBal.length; i++) {
          const b = sortedBal[i];
          let dayPnl: number | null = null;
          if (b.startBalance != null && b.endBalance != null) {
            dayPnl = b.endBalance - b.startBalance;
          } else if (b.startBalance != null && sortedBal[i + 1]?.startBalance != null) {
            dayPnl = sortedBal[i + 1].startBalance! - b.startBalance;
          }
          if (dayPnl != null) {
            balancePnlByDate[b.date] = Math.round(dayPnl);
          }
        }

        // Build dayMap: balance P&L (if available) + trade counts from round-trips
        // Days with balance data get accurate P&L; days without get no P&L entry
        for (const rt of effectiveRoundTrips) {
          const dateKey = toEtDate(rt.exitTime);
          if (!dayMap[dateKey]) {
            const d = new Date(rt.exitTime);
            const label = d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "America/New_York" });
            const hasBalance = dateKey in balancePnlByDate;
            dayMap[dateKey] = { trades: 0, wins: 0, losses: 0, totalPnl: hasBalance ? balancePnlByDate[dateKey] : 0, label, hasBalanceData: hasBalance };
          }
          dayMap[dateKey].trades++;
          if (rt.pnl > 0) dayMap[dateKey].wins++;
          else if (rt.pnl < 0) dayMap[dateKey].losses++;
        }

        // Also add days that have balance data with non-zero P&L but no trades (e.g., position carry-over)
        // Skip $0 balance-only days (weekends, holidays with no activity)
        for (const [date, pnl] of Object.entries(balancePnlByDate)) {
          if (!dayMap[date] && pnl !== 0) {
            const d = new Date(date + "T12:00:00");
            const label = d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
            dayMap[date] = { trades: 0, wins: 0, losses: 0, totalPnl: pnl, label, hasBalanceData: true };
          }
        }
        // Filter out days with no trades and no P&L (weekend balance snapshots)
        const days = Object.entries(dayMap)
          .filter(([, d]) => d.trades > 0 || d.totalPnl !== 0)
          .sort(([a], [b]) => b.localeCompare(a));

        // Weekly breakdown — aggregate daily P&L by week (using string math to avoid timezone issues)
        const weekMap: Record<string, { trades: number; wins: number; losses: number; pnl: number; label: string }> = {};
        for (const [dateKey, d] of days) {
          // Calculate week start (Sunday) using UTC-safe date math
          const [y, m, dy] = dateKey.split("-").map(Number);
          const dt = new Date(Date.UTC(y, m - 1, dy, 12));
          const dayOfWeek = dt.getUTCDay();
          const weekStartDate = new Date(Date.UTC(y, m - 1, dy - dayOfWeek, 12));
          const key = weekStartDate.toISOString().slice(0, 10);
          const label = `Week of ${weekStartDate.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" })}`;
          if (!weekMap[key]) weekMap[key] = { trades: 0, wins: 0, losses: 0, pnl: 0, label };
          weekMap[key].trades += d.trades;
          weekMap[key].wins += d.wins;
          weekMap[key].losses += d.losses;
          weekMap[key].pnl += d.totalPnl;
        }
        const weeks = Object.entries(weekMap).sort(([a], [b]) => b.localeCompare(a));

        // Monthly breakdown — aggregate daily P&L by month
        const monthMap: Record<string, { pnl: number; label: string }> = {};
        for (const [dateKey, d] of days) {
          const key = dateKey.slice(0, 7);
          const [y, m] = key.split("-").map(Number);
          const label = new Date(Date.UTC(y, m - 1, 15)).toLocaleDateString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });
          if (!monthMap[key]) monthMap[key] = { pnl: 0, label };
          monthMap[key].pnl += d.totalPnl;
        }
        const months = Object.entries(monthMap).sort(([a], [b]) => b.localeCompare(a));

        // Compute all stats
        const stats = computeFuturesStats(effectiveRoundTrips, dayMap, weekMap, STARTING_CAPITAL);
        const totalPnl = accountPnl ?? stats.totalPnl;

        if (!futures) {
          return (
            <div className="space-y-4">
              <div className="skeleton h-32 w-full rounded-xl" />
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                {Array.from({ length: 8 }).map((_, i) => (
                  <div key={i} className="rounded-xl border border-white/[0.06] bg-white/[0.02] p-4">
                    <div className="skeleton h-3 w-14 rounded mb-2" />
                    <div className="skeleton h-6 w-20 rounded" />
                  </div>
                ))}
              </div>
            </div>
          );
        }

        if (stats.tradeCount === 0 && !futures.connected) {
          return (
            <Card>
              <CardContent className="py-8 text-center">
                <p className="text-sm text-muted-foreground/50">Tradovate not connected — futures data unavailable</p>
              </CardContent>
            </Card>
          );
        }

        // ── Balance-based stats (accurate) ──
        const daysWithPnl = days.filter(([, d]) => d.hasBalanceData);
        const greenDays = daysWithPnl.filter(([, d]) => d.totalPnl > 0).length;
        const redDays = daysWithPnl.filter(([, d]) => d.totalPnl < 0).length;
        const tradingDays = daysWithPnl.length;

        // Max drawdown from daily balance cumulative P&L
        const sortedDayPnls = [...daysWithPnl].sort(([a], [b]) => a.localeCompare(b));
        let ddPeak = 0, maxDD = 0, ddCum = 0;
        for (const [, d] of sortedDayPnls) {
          ddCum += d.totalPnl;
          if (ddCum > ddPeak) ddPeak = ddCum;
          const dd = ddPeak - ddCum;
          if (dd > maxDD) maxDD = dd;
        }
        const maxDDPct = STARTING_CAPITAL > 0 ? (maxDD / STARTING_CAPITAL) * 100 : 0;

        // Sharpe from daily balance P&L
        let sharpe: number | null = null;
        if (daysWithPnl.length >= 5) {
          const pnls = daysWithPnl.map(([, d]) => d.totalPnl);
          const mean = pnls.reduce((s, v) => s + v, 0) / pnls.length;
          const stddev = Math.sqrt(pnls.reduce((s, v) => s + (v - mean) ** 2, 0) / pnls.length);
          sharpe = stddev > 0 ? (mean / stddev) * Math.sqrt(252) : 0;
        }

        // Best/worst day
        const bestDayEntry = daysWithPnl.length > 0 ? daysWithPnl.reduce(([bk, bv], [k, v]) => v.totalPnl > bv.totalPnl ? [k, v] : [bk, bv]) : null;
        const worstDayEntry = daysWithPnl.length > 0 ? daysWithPnl.reduce(([wk, wv], [k, v]) => v.totalPnl < wv.totalPnl ? [k, v] : [wk, wv]) : null;

        // Best/worst week (only weeks with P&L)
        const weeksWithPnl = weeks.filter(([, w]) => w.pnl !== 0);
        const bestWeekEntry = weeksWithPnl.length > 0 ? weeksWithPnl.reduce(([bk, bv], [k, v]) => v.pnl > bv.pnl ? [k, v] : [bk, bv]) : null;
        const worstWeekEntry = weeksWithPnl.length > 0 ? weeksWithPnl.reduce(([wk, wv], [k, v]) => v.pnl < wv.pnl ? [k, v] : [wk, wv]) : null;

        // Avg daily P&L
        const avgDailyPnl = tradingDays > 0 ? totalPnl / tradingDays : 0;

        // Equity curve from daily balance deltas (cumulative)
        let balCum = 0;
        const balanceCurve = sortedDayPnls.map(([dateKey, d]) => {
          balCum += d.totalPnl;
          return { date: dateKey, cumPnl: balCum };
        });

        return (
          <>
            {/* Futures Big P&L */}
            <Card className={`border-2 ${totalPnl >= 0 ? "border-emerald-500/30 bg-gradient-to-br from-emerald-500/[0.03] to-transparent" : "border-red-500/30 bg-gradient-to-br from-red-500/[0.03] to-transparent"}`}>
              <CardContent className="pt-6 pb-4 text-center">
                <p className="text-sm text-muted-foreground mb-1">Futures Realized P&L</p>
                <p className={`text-5xl font-black tracking-tight ${pnl(totalPnl)}`}>{fmt(Math.round(totalPnl))}</p>
                <p className="text-sm text-muted-foreground mt-2">
                  {tradingDays} trading day{tradingDays !== 1 ? "s" : ""} · {greenDays} green, {redDays} red
                </p>
              </CardContent>
            </Card>

            {/* Stats — all from balance data */}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              <Card>
                <CardContent className="pt-4 pb-3">
                  <p className="text-[10px] text-muted-foreground/60 uppercase tracking-wider">Green Days</p>
                  <p className={`text-2xl font-bold mt-1 ${greenDays > redDays ? "text-emerald-400" : greenDays < redDays ? "text-red-400" : "text-muted-foreground"}`}>
                    {tradingDays > 0 ? `${((greenDays / tradingDays) * 100).toFixed(0)}%` : "—"}
                  </p>
                  <p className="text-[10px] text-muted-foreground/50">{greenDays}W / {redDays}L</p>
                </CardContent>
              </Card>
              <Card>
                <CardContent className="pt-4 pb-3">
                  <p className="text-[10px] text-muted-foreground/60 uppercase tracking-wider">Avg Daily P&L</p>
                  <p className={`text-2xl font-bold mt-1 ${pnl(avgDailyPnl)}`}>
                    {tradingDays > 0 ? fmt(Math.round(avgDailyPnl)) : "—"}
                  </p>
                  <p className="text-[10px] text-muted-foreground/50">Per trading day</p>
                </CardContent>
              </Card>
              <Card>
                <CardContent className="pt-4 pb-3">
                  <p className="text-[10px] text-muted-foreground/60 uppercase tracking-wider">Max Drawdown</p>
                  <p className="text-2xl font-bold mt-1 text-red-400">
                    {maxDD > 0 ? `-$${maxDD.toFixed(0)}` : "$0"}
                  </p>
                  <p className="text-[10px] text-muted-foreground/50">
                    {maxDDPct > 0 ? `-${maxDDPct.toFixed(1)}% of capital` : "No drawdown"}
                  </p>
                </CardContent>
              </Card>
              <Card>
                <CardContent className="pt-4 pb-3">
                  <p className="text-[10px] text-muted-foreground/60 uppercase tracking-wider">Sharpe Ratio</p>
                  <p className={`text-2xl font-bold mt-1 ${sharpe != null ? (sharpe >= 1 ? "text-emerald-400" : sharpe >= 0 ? "text-yellow-400" : "text-red-400") : "text-muted-foreground"}`}>
                    {sharpe != null ? sharpe.toFixed(2) : "N/A"}
                  </p>
                  <p className="text-[10px] text-muted-foreground/50">
                    {sharpe == null ? "Need 5+ trading days" : "Annualized"}
                  </p>
                </CardContent>
              </Card>
            </div>

            {/* Account Summary */}
            {futures?.account && (
              <Card>
                <CardContent className="pt-4 pb-3">
                  <div className="grid grid-cols-3 gap-4">
                    <div>
                      <p className="text-[10px] text-muted-foreground/60 uppercase tracking-wider">Account Balance</p>
                      <p className="text-xl font-bold mt-1">${Math.round(futures.account.balance).toLocaleString()}</p>
                    </div>
                    <div>
                      <p className="text-[10px] text-muted-foreground/60 uppercase tracking-wider">Net Liquidation</p>
                      <p className="text-xl font-bold mt-1">${Math.round(futures.account.netLiq).toLocaleString()}</p>
                    </div>
                    <div>
                      <p className="text-[10px] text-muted-foreground/60 uppercase tracking-wider">Today Realized</p>
                      <p className={`text-xl font-bold mt-1 ${pnl(futures.account.realizedPnl)}`}>{fmt(Math.round(futures.account.realizedPnl))}</p>
                    </div>
                  </div>
                </CardContent>
              </Card>
            )}

            {/* Highlights — balance-based only */}
            {tradingDays > 0 && (
              <Card>
                <CardHeader><CardTitle className="text-sm">Highlights</CardTitle></CardHeader>
                <CardContent>
                  <div className="grid grid-cols-2 md:grid-cols-3 gap-x-6 gap-y-3 text-xs">
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">Best Day</span>
                      <span className={`font-bold ${bestDayEntry ? pnl(bestDayEntry[1].totalPnl) : ""}`}>
                        {bestDayEntry ? `${fmt(Math.round(bestDayEntry[1].totalPnl))} (${bestDayEntry[1].label})` : "—"}
                      </span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">Worst Day</span>
                      <span className={`font-bold ${worstDayEntry ? pnl(worstDayEntry[1].totalPnl) : ""}`}>
                        {worstDayEntry ? `${fmt(Math.round(worstDayEntry[1].totalPnl))} (${worstDayEntry[1].label})` : "—"}
                      </span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">Trading Days</span>
                      <span className="font-bold">{tradingDays}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">Best Week</span>
                      <span className={`font-bold ${bestWeekEntry ? pnl(bestWeekEntry[1].pnl) : ""}`}>
                        {bestWeekEntry ? fmt(Math.round(bestWeekEntry[1].pnl)) : "—"}
                      </span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">Worst Week</span>
                      <span className={`font-bold ${worstWeekEntry ? pnl(worstWeekEntry[1].pnl) : ""}`}>
                        {worstWeekEntry ? fmt(Math.round(worstWeekEntry[1].pnl)) : "—"}
                      </span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">Green / Red Days</span>
                      <span className="font-bold">
                        <span className="text-emerald-400">{greenDays}</span>
                        <span className="text-muted-foreground/50"> / </span>
                        <span className="text-red-400">{redDays}</span>
                        <span className="text-muted-foreground/50"> ({tradingDays > 0 ? ((greenDays / tradingDays) * 100).toFixed(0) : 0}%)</span>
                      </span>
                    </div>
                  </div>
                </CardContent>
              </Card>
            )}

            {/* Equity Curve — from daily balance deltas */}
            {balanceCurve.length > 1 && (() => {
              const maxPnl = Math.max(...balanceCurve.map((p) => p.cumPnl));
              const minPnl = Math.min(...balanceCurve.map((p) => p.cumPnl), 0);
              const range = maxPnl - minPnl || 1;
              const chartH = 180;
              const chartW = 600;
              const padTop = 10;
              const padBot = 10;
              const usableH = chartH - padTop - padBot;

              const toY = (val: number) => padTop + usableH - ((val - minPnl) / range) * usableH;
              const toX = (i: number) => (i / (balanceCurve.length - 1)) * chartW;

              const linePts = balanceCurve.map((p, i) => `${toX(i)},${toY(p.cumPnl)}`).join(" ");
              const zeroY = toY(0);
              const areaPath = `M${toX(0)},${zeroY} ` +
                balanceCurve.map((p, i) => `L${toX(i)},${toY(p.cumPnl)}`).join(" ") +
                ` L${toX(balanceCurve.length - 1)},${zeroY} Z`;

              return (
                <Card>
                  <CardHeader><CardTitle className="text-sm">Equity Curve</CardTitle></CardHeader>
                  <CardContent>
                    <div className="relative">
                      <svg viewBox={`0 0 ${chartW} ${chartH}`} className="w-full h-48" preserveAspectRatio="none">
                        <line x1="0" y1={zeroY} x2={chartW} y2={zeroY} stroke="rgba(255,255,255,0.1)" strokeDasharray="4 4" />
                        <path d={areaPath} fill={balanceCurve[balanceCurve.length - 1].cumPnl >= 0 ? "rgba(52,211,153,0.08)" : "rgba(248,113,113,0.08)"} />
                        <polyline
                          points={linePts}
                          fill="none"
                          stroke={balanceCurve[balanceCurve.length - 1].cumPnl >= 0 ? "rgb(52,211,153)" : "rgb(248,113,113)"}
                          strokeWidth="2"
                          vectorEffect="non-scaling-stroke"
                        />
                      </svg>
                      <div className="absolute left-1 top-1 text-[9px] text-muted-foreground/40">
                        {maxPnl >= 0 ? "+" : ""}${maxPnl.toFixed(0)}
                      </div>
                      <div className="absolute left-1 bottom-1 text-[9px] text-muted-foreground/40">
                        {minPnl >= 0 ? "+" : "-"}${Math.abs(minPnl).toFixed(0)}
                      </div>
                    </div>
                    <div className="flex justify-between text-[9px] text-muted-foreground/40 mt-1">
                      <span>{new Date(balanceCurve[0].date + "T12:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric" })}</span>
                      <span>{new Date(balanceCurve[balanceCurve.length - 1].date + "T12:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric" })}</span>
                    </div>
                  </CardContent>
                </Card>
              );
            })()}

            {/* Daily / Weekly / Monthly P&L */}
            {effectiveRoundTrips.length > 0 && (
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
            )}

            {/* Daily Performance Table — P&L from balance, trades from fills */}
            {days.length > 0 && (
              <Card>
                <CardHeader>
                  <CardTitle className="text-sm">Daily Performance</CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="overflow-x-auto">
                    <table className="w-full text-xs">
                      <thead>
                        <tr className="text-muted-foreground/60 border-b border-white/10">
                          <th className="text-left py-2 font-medium">Date</th>
                          <th className="text-center py-2 font-medium">Trades</th>
                          <th className="text-right py-2 font-medium">P&L</th>
                        </tr>
                      </thead>
                      <tbody>
                        {days.map(([dateKey, d]) => (
                          <tr key={dateKey} className="border-b border-white/[0.04] hover:bg-white/[0.02]">
                            <td className="py-2 font-medium">{d.label}</td>
                            <td className="text-center py-2">{d.trades > 0 ? d.trades : "—"}</td>
                            <td className={`text-right py-2 font-bold ${pnl(d.totalPnl)}`}>
                              {fmt(d.totalPnl)}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </CardContent>
              </Card>
            )}

            {/* Weekly Performance Table */}
            {weeks.filter(([, w]) => w.pnl !== 0).length > 0 && (
              <Card>
                <CardHeader>
                  <CardTitle className="text-sm">Weekly Performance</CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="overflow-x-auto">
                    <table className="w-full text-xs">
                      <thead>
                        <tr className="text-muted-foreground/60 border-b border-white/10">
                          <th className="text-left py-2 font-medium">Week</th>
                          <th className="text-center py-2 font-medium">Trades</th>
                          <th className="text-right py-2 font-medium">P&L</th>
                        </tr>
                      </thead>
                      <tbody>
                        {weeks.filter(([, w]) => w.pnl !== 0).map(([key, w]) => (
                          <tr key={key} className="border-b border-white/[0.04] hover:bg-white/[0.02]">
                            <td className="py-2 font-medium">{w.label}</td>
                            <td className="text-center py-2">{w.trades > 0 ? w.trades : "—"}</td>
                            <td className={`text-right py-2 font-bold ${pnl(w.pnl)}`}>
                              {fmt(w.pnl)}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
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
