"use client";

import { useState, useEffect, useCallback } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { FuturesChart } from "@/components/charts/futures-chart";
import { TradingViewChart } from "@/components/charts/tradingview-chart";

// ── Types ──────────────────────────────────────────────

interface FuturesQuote {
  symbol: string;
  yahooSymbol: string;
  name: string;
  multiplier: number;
  tickSize: number;
  margin: number;
  price: number;
  change: number;
  changePercent: number;
  prevClose: number;
  open: number;
  high: number;
  low: number;
  volume: number;
  bid: number;
  ask: number;
  timestamp: string;
}

interface FuturesStatus {
  connected: boolean;
  accountId?: string;
  accountName?: string;
  message?: string;
}

interface FuturesTrade {
  symbol: string;
  action: string;
  qty: number;
  price: number | null;
  pnl: number | null;
  reason: string;
  time: string;
}

interface FuturesResult {
  trades: { symbol: string; action: string; contracts: number; price: number; stopLoss: number; target: number; reasoning: string; success: boolean }[];
  managed: number;
  details: string[];
}

interface FuturesPosition {
  id: number;
  contractName: string;
  symbol: string;
  direction: "long" | "short";
  quantity: number;
  entryPrice: number;
  currentPrice: number;
  unrealizedPnl: number;
  stopLoss: number | null;
  target: number | null;
  pctToStop: number | null;
  pctToTarget: number | null;
  multiplier: number;
  setup: string | null;
  aiScore: number | null;
  openedAt: string;
}

interface FuturesAccount {
  balance: number;
  netLiq: number;
  realizedPnl: number;
  unrealizedPnl: number;
  marginUsed: number;
}

interface ActivityLog {
  id: string;
  symbol: string;
  action: string;
  qty: number;
  price: number | null;
  pnl: number | null;
  reason: string;
  aiScore: number | null;
  time: string;
}

interface PositionsData {
  connected: boolean;
  account: FuturesAccount | null;
  positions: FuturesPosition[];
  orders: { id: number; action: string; type: string; qty: number; status: string }[];
  activity: ActivityLog[];
  engineStatus?: { alive: boolean; lastHeartbeat: string | null; ageMinutes: number };
}

interface BacktestSetup {
  setup: string;
  trades: number;
  wins: number;
  losses: number;
  winRate: number;
  avgWin: number;
  avgLoss: number;
  profitFactor: number;
  totalPnl: number;
  maxDrawdown: number;
  avgRMultiple: number;
  avgHoldBars: number;
  sharpe: number;
  verdict: "keep" | "optimize" | "kill";
}

interface BacktestData {
  symbol: string;
  period: string;
  totalBars: number;
  tradingDays: number;
  setups: BacktestSetup[];
  equity: number[];
  summary: {
    totalTrades: number;
    winRate: number;
    profitFactor: number;
    totalPnl: number;
    maxDrawdown: number;
    sharpe: number;
    bestSetup: string;
    worstSetup: string;
  };
}

// ── Constants ──────────────────────────────────────────

const CONTRACTS = ["MES", "MNQ", "MYM", "M2K"];

const STRATEGIES = [
  { name: "Gap Fill", priority: 1, confidence: "78%", when: "First 30 min", desc: "Fade small gaps (<10pts) targeting prior day close. 78% fill rate on ES." },
  { name: "IB Breakout", priority: 2, confidence: "75%+", when: "After 10:30 AM", desc: "Break above/below 60-min Initial Balance with volume + 15m trend alignment." },
  { name: "Failed IB Breakout", priority: 3, confidence: "73%", when: "After IB break fails", desc: "Price tests IB high/low, returns to range. Fade to IB midpoint." },
  { name: "Trend Continuation", priority: 4, confidence: "72%", when: "Morning/Afternoon", desc: "Pullback to EMA9 in trending market. Best backtest setup (67% WR)." },
  { name: "Extreme RSI Bounce", priority: 5, confidence: "70%", when: "RSI <25 or >75", desc: "Exhaustion reversal on declining volume. Any session, any day type." },
];

const RISK_RULES = [
  "Dynamic sizing: 0.25-1% per trade",
  "Scale out 50% at 1R, trail rest",
  "Breakeven stop at 1R profit",
  "$1,500 daily loss kill switch",
  "Max 2 positions, 6 trades/day",
  "AI hard gate (Claude confirms)",
  "Tilt: 30min pause after 2 stops",
  "EOD forced close at 3:50 PM",
  "Skip lunch 12-2 PM, half Mon/Fri",
  "No re-entry on stopped symbols",
];

// ── Helpers ────────────────────────────────────────────

function pnlColor(val: number) {
  return val > 0 ? "text-emerald-400" : val < 0 ? "text-red-400" : "text-muted-foreground";
}

function formatNum(n: number, decimals = 2) {
  return n.toLocaleString(undefined, { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}

function formatVol(v: number) {
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`;
  if (v >= 1_000) return `${(v / 1_000).toFixed(1)}K`;
  return String(v);
}

// ── Component ──────────────────────────────────────────

export default function FuturesPage() {
  const [quotes, setQuotes] = useState<FuturesQuote[]>([]);
  const [status, setStatus] = useState<FuturesStatus | null>(null);
  const [trades, setTrades] = useState<FuturesTrade[]>([]);
  const [posData, setPosData] = useState<PositionsData | null>(null);
  const [result, setResult] = useState<FuturesResult | null>(null);
  const [running, setRunning] = useState(false);
  const [selectedContract, setSelectedContract] = useState("MES");
  const [activeTab, setActiveTab] = useState<"chart" | "strategy" | "history" | "backtest" | "reports">("chart");
  const [chartMode, setChartMode] = useState<"tradingview" | "lightweight">("lightweight");
  const [backtest, setBacktest] = useState<BacktestData | null>(null);
  const [backtestLoading, setBacktestLoading] = useState(false);

  // ── Data Loading ─────────────────────────────────────

  const loadQuotes = useCallback(async () => {
    try {
      const res = await fetch("/api/futures/quotes");
      const data = await res.json();
      if (Array.isArray(data)) setQuotes(data);
    } catch { /* ignore */ }
  }, []);

  const loadPositions = useCallback(async () => {
    try {
      const res = await fetch("/api/futures/positions");
      const data = await res.json();
      if (data && !data.error) setPosData(data);
    } catch { /* ignore */ }
  }, []);

  const loadStatus = useCallback(async () => {
    try {
      const [statusRes, tradesRes] = await Promise.all([
        fetch("/api/futures").then((r) => r.json()).catch(() => ({ connected: false })),
        fetch("/api/agent/activity?filter=futures").then((r) => r.json()).catch(() => []),
      ]);
      setStatus(statusRes);
      if (Array.isArray(tradesRes)) setTrades(tradesRes.filter((t: FuturesTrade) => t.symbol?.startsWith("FUT:")));
    } catch { /* ignore */ }
  }, []);

  useEffect(() => {
    loadQuotes();
    loadStatus();
    loadPositions();
    // Refresh quotes every 15s, positions every 10s, status every 30s
    const quoteInterval = setInterval(loadQuotes, 15000);
    const posInterval = setInterval(loadPositions, 10000);
    const statusInterval = setInterval(loadStatus, 30000);
    return () => { clearInterval(quoteInterval); clearInterval(posInterval); clearInterval(statusInterval); };
  }, [loadQuotes, loadStatus, loadPositions]);

  const runAgent = async () => {
    setRunning(true);
    try {
      const res = await fetch("/api/futures", { method: "POST" });
      setResult(await res.json());
    } catch (err) {
      setResult({ trades: [], managed: 0, details: [`Error: ${err}`] });
    }
    setRunning(false);
    loadStatus();
    loadPositions();
  };

  // ── Derived data ─────────────────────────────────────

  const selectedQuote = quotes.find((q) => q.symbol === selectedContract);
  const closedTrades = trades.filter((t) => t.pnl != null);
  const wins = closedTrades.filter((t) => (t.pnl || 0) > 0);
  const losses = closedTrades.filter((t) => (t.pnl || 0) < 0);
  const totalPnl = closedTrades.reduce((s, t) => s + (t.pnl || 0), 0);
  const avgWin = wins.length > 0 ? wins.reduce((s, t) => s + (t.pnl || 0), 0) / wins.length : 0;
  const avgLoss = losses.length > 0 ? losses.reduce((s, t) => s + (t.pnl || 0), 0) / losses.length : 0;
  const bestTrade = closedTrades.reduce((best, t) => (t.pnl || 0) > (best?.pnl || -Infinity) ? t : best, closedTrades[0]);
  const worstTrade = closedTrades.reduce((worst, t) => (t.pnl || 0) < (worst?.pnl || Infinity) ? t : worst, closedTrades[0]);

  // Daily/Weekly/Monthly P&L
  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const weekStart = new Date(todayStart); weekStart.setDate(weekStart.getDate() - weekStart.getDay());
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);

  const dailyPnl = closedTrades
    .filter((t) => new Date(t.time) >= todayStart)
    .reduce((s, t) => s + (t.pnl || 0), 0);
  const weeklyPnl = closedTrades
    .filter((t) => new Date(t.time) >= weekStart)
    .reduce((s, t) => s + (t.pnl || 0), 0);
  const monthlyPnl = closedTrades
    .filter((t) => new Date(t.time) >= monthStart)
    .reduce((s, t) => s + (t.pnl || 0), 0);
  const dailyTrades = closedTrades.filter((t) => new Date(t.time) >= todayStart).length;
  const weeklyTrades = closedTrades.filter((t) => new Date(t.time) >= weekStart).length;
  const monthlyTrades = closedTrades.filter((t) => new Date(t.time) >= monthStart).length;

  return (
    <div className="space-y-4 animate-fade-up">
      {/* ── Header ── */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold tracking-tight">Futures Command Center</h1>
          <p className="text-[11px] text-muted-foreground/60">
            Micro futures — live data via Yahoo Finance
            {status?.connected && (
              <span className="text-emerald-400 ml-2">Tradovate Connected</span>
            )}
            {posData?.engineStatus?.alive && (
              <span className="text-blue-400 ml-2 inline-flex items-center gap-1">
                <span className="relative flex h-1.5 w-1.5"><span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-blue-400 opacity-75" /><span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-blue-400" /></span>
                Railway Engine Live
              </span>
            )}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <div className="flex items-center gap-1.5">
            <span className={`w-2 h-2 rounded-full ${status?.connected ? "bg-emerald-500 animate-pulse" : "bg-amber-500"}`} />
            <span className="text-[10px] text-muted-foreground/60">
              {status?.connected ? status.accountName : "Tradovate pending"}
            </span>
          </div>
          <Button onClick={runAgent} disabled={running || !status?.connected} size="sm" variant="outline" className="text-xs h-7">
            {running ? "Running..." : "Run Agent"}
          </Button>
        </div>
      </div>

      {/* ── Live Price Tiles ── */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
        {CONTRACTS.map((sym) => {
          const q = quotes.find((x) => x.symbol === sym);
          const isSelected = sym === selectedContract;
          const isUp = (q?.change ?? 0) >= 0;
          return (
            <button
              key={sym}
              onClick={() => setSelectedContract(sym)}
              className={`text-left rounded-lg border p-3 transition-all ${
                isSelected
                  ? "border-emerald-500/40 bg-emerald-500/[0.06] shadow-lg shadow-emerald-500/5"
                  : "border-white/[0.06] bg-white/[0.02] hover:border-white/[0.12] hover:bg-white/[0.04]"
              }`}
            >
              <div className="flex items-center justify-between mb-1">
                <span className={`text-sm font-bold ${isSelected ? "text-emerald-400" : ""}`}>{sym}</span>
                {q && (
                  <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded ${
                    isUp ? "bg-emerald-500/15 text-emerald-400" : "bg-red-500/15 text-red-400"
                  }`}>
                    {isUp ? "+" : ""}{q.changePercent.toFixed(2)}%
                  </span>
                )}
              </div>
              {q ? (
                <>
                  <p className={`text-lg font-bold tabular-nums ${isUp ? "text-emerald-400" : "text-red-400"}`}>
                    {formatNum(q.price)}
                  </p>
                  <div className="flex items-center justify-between mt-1">
                    <span className={`text-[10px] tabular-nums ${isUp ? "text-emerald-400/70" : "text-red-400/70"}`}>
                      {isUp ? "+" : ""}{formatNum(q.change)}
                    </span>
                    <span className="text-[9px] text-muted-foreground/40">
                      Vol {formatVol(q.volume)}
                    </span>
                  </div>
                </>
              ) : (
                <div className="h-10 flex items-center">
                  <span className="text-[10px] text-muted-foreground/40 animate-pulse">Loading...</span>
                </div>
              )}
            </button>
          );
        })}
      </div>

      {/* ── Selected Contract Detail Bar ── */}
      {selectedQuote && (
        <div className="flex flex-wrap gap-x-6 gap-y-1 px-1 text-[11px] text-muted-foreground/60">
          <span>Open <span className="text-foreground/80 font-medium tabular-nums">{formatNum(selectedQuote.open)}</span></span>
          <span>High <span className="text-emerald-400/80 font-medium tabular-nums">{formatNum(selectedQuote.high)}</span></span>
          <span>Low <span className="text-red-400/80 font-medium tabular-nums">{formatNum(selectedQuote.low)}</span></span>
          <span>Prev Close <span className="text-foreground/80 font-medium tabular-nums">{formatNum(selectedQuote.prevClose)}</span></span>
          <span>Bid <span className="text-foreground/60 tabular-nums">{formatNum(selectedQuote.bid)}</span></span>
          <span>Ask <span className="text-foreground/60 tabular-nums">{formatNum(selectedQuote.ask)}</span></span>
          <span>${selectedQuote.multiplier}/pt</span>
          <span>${selectedQuote.margin.toLocaleString()} margin</span>
        </div>
      )}

      {/* ── Main Content Area ── */}
      <div className="grid grid-cols-1 xl:grid-cols-[1fr_320px] gap-4">
        {/* Left: Chart + Tabs */}
        <div className="space-y-3">
          {/* Tab bar */}
          <div className="flex gap-1 border-b border-white/[0.06] pb-2">
            {(["chart", "strategy", "backtest", "history", "reports"] as const).map((tab) => (
              <button
                key={tab}
                onClick={() => {
                  setActiveTab(tab);
                  if (tab === "backtest" && !backtest && !backtestLoading) {
                    setBacktestLoading(true);
                    fetch("/api/futures/backtest")
                      .then((r) => r.json())
                      .then((data) => { if (!data.error) setBacktest(data); })
                      .catch(() => {})
                      .finally(() => setBacktestLoading(false));
                  }
                }}
                className={`px-3 py-1.5 rounded-t text-xs font-medium transition-colors ${
                  activeTab === tab
                    ? "text-foreground border-b-2 border-emerald-500"
                    : "text-muted-foreground/60 hover:text-foreground"
                }`}
              >
                {tab === "chart" ? "Chart" : tab === "strategy" ? "Strategy" : tab === "backtest" ? "Backtest" : tab === "reports" ? "Reports" : "Trade History"}
              </button>
            ))}
          </div>

          {/* Chart tab */}
          {activeTab === "chart" && (
            <Card className="border-white/[0.06]">
              <CardContent className="pt-4">
                <div className="flex items-center justify-end gap-1 mb-3">
                  <button
                    onClick={() => setChartMode("tradingview")}
                    className={`px-2.5 py-1 rounded text-[11px] font-bold tracking-wide transition-colors ${
                      chartMode === "tradingview"
                        ? "bg-blue-500/15 text-blue-400 border border-blue-500/30"
                        : "text-muted-foreground hover:text-foreground hover:bg-white/5"
                    }`}
                  >
                    TradingView
                  </button>
                  <button
                    onClick={() => setChartMode("lightweight")}
                    className={`px-2.5 py-1 rounded text-[11px] font-bold tracking-wide transition-colors ${
                      chartMode === "lightweight"
                        ? "bg-emerald-500/15 text-emerald-400 border border-emerald-500/30"
                        : "text-muted-foreground hover:text-foreground hover:bg-white/5"
                    }`}
                  >
                    Lightweight
                  </button>
                </div>
                {chartMode === "tradingview" ? (
                  <TradingViewChart symbol={selectedContract} height={560} />
                ) : (
                  <FuturesChart symbol={selectedContract} height={560} />
                )}
              </CardContent>
            </Card>
          )}

          {/* Strategy tab */}
          {activeTab === "strategy" && (
            <Card className="border-white/[0.06]">
              <CardHeader className="pb-2">
                <CardTitle className="text-sm">5 Expert Setups — Priority Order</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="space-y-2">
                  {STRATEGIES.map((s) => (
                    <div key={s.priority} className="flex items-start gap-3 bg-white/[0.02] border border-white/[0.04] rounded-lg p-3">
                      <span className="text-[10px] bg-blue-500/15 text-blue-400 px-1.5 py-0.5 rounded font-bold shrink-0">#{s.priority}</span>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center justify-between">
                          <span className="text-sm font-bold">{s.name}</span>
                          <span className="text-[10px] text-emerald-400 font-bold">{s.confidence}</span>
                        </div>
                        <p className="text-[11px] text-muted-foreground/60 mt-0.5">{s.desc}</p>
                        <span className="text-[9px] text-muted-foreground/40">{s.when}</span>
                      </div>
                    </div>
                  ))}
                </div>
                <div className="mt-4 pt-3 border-t border-white/[0.06]">
                  <p className="text-[10px] text-muted-foreground/40 uppercase tracking-wider mb-2 font-bold">Risk Rules</p>
                  <div className="grid grid-cols-2 gap-1.5">
                    {RISK_RULES.map((r, i) => (
                      <span key={i} className="text-[10px] text-muted-foreground/60 flex items-center gap-1.5">
                        <span className="text-emerald-400/60">{i + 1}.</span> {r}
                      </span>
                    ))}
                  </div>
                </div>
              </CardContent>
            </Card>
          )}

          {/* Backtest tab */}
          {activeTab === "backtest" && (
            <Card className="border-white/[0.06]">
              <CardContent className="pt-4">
                {backtestLoading ? (
                  <div className="text-center py-12">
                    <p className="text-sm text-muted-foreground/60 animate-pulse">Running backtest on ~55 days of ES 5-min data...</p>
                    <p className="text-[10px] text-muted-foreground/30 mt-1">This takes 10-30 seconds</p>
                  </div>
                ) : backtest ? (
                  <div className="space-y-4">
                    {/* Summary */}
                    <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                      <div className="bg-white/[0.03] rounded-lg p-3">
                        <p className="text-[9px] text-muted-foreground/40 uppercase">Total P&L</p>
                        <p className={`text-xl font-bold tabular-nums ${pnlColor(backtest.summary.totalPnl)}`}>
                          {backtest.summary.totalPnl >= 0 ? "+" : ""}{backtest.summary.totalPnl.toFixed(1)} pts
                        </p>
                      </div>
                      <div className="bg-white/[0.03] rounded-lg p-3">
                        <p className="text-[9px] text-muted-foreground/40 uppercase">Win Rate</p>
                        <p className="text-xl font-bold">{(backtest.summary.winRate * 100).toFixed(0)}%</p>
                        <p className="text-[9px] text-muted-foreground/30">{backtest.summary.totalTrades} trades</p>
                      </div>
                      <div className="bg-white/[0.03] rounded-lg p-3">
                        <p className="text-[9px] text-muted-foreground/40 uppercase">Profit Factor</p>
                        <p className={`text-xl font-bold ${backtest.summary.profitFactor >= 1.5 ? "text-emerald-400" : backtest.summary.profitFactor >= 1.0 ? "text-amber-400" : "text-red-400"}`}>
                          {backtest.summary.profitFactor.toFixed(2)}
                        </p>
                      </div>
                      <div className="bg-white/[0.03] rounded-lg p-3">
                        <p className="text-[9px] text-muted-foreground/40 uppercase">Sharpe</p>
                        <p className={`text-xl font-bold ${backtest.summary.sharpe >= 1.0 ? "text-emerald-400" : backtest.summary.sharpe >= 0.5 ? "text-amber-400" : "text-red-400"}`}>
                          {backtest.summary.sharpe.toFixed(2)}
                        </p>
                      </div>
                    </div>

                    <div className="text-[10px] text-muted-foreground/40">
                      {backtest.symbol} | {backtest.period} | {backtest.tradingDays} trading days | {backtest.totalBars.toLocaleString()} bars
                    </div>

                    {/* Per-setup breakdown */}
                    <div>
                      <p className="text-xs font-bold mb-2">Per-Setup Performance</p>
                      <div className="space-y-2">
                        {backtest.setups.map((s) => (
                          <div key={s.setup} className={`bg-white/[0.02] border rounded-lg p-3 ${
                            s.verdict === "keep" ? "border-emerald-500/30" :
                            s.verdict === "optimize" ? "border-amber-500/30" :
                            "border-red-500/30"
                          }`}>
                            <div className="flex items-center justify-between mb-2">
                              <div className="flex items-center gap-2">
                                <span className="text-sm font-bold">{s.setup.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase())}</span>
                                <span className={`text-[9px] font-bold px-1.5 py-0.5 rounded ${
                                  s.verdict === "keep" ? "bg-emerald-500/15 text-emerald-400" :
                                  s.verdict === "optimize" ? "bg-amber-500/15 text-amber-400" :
                                  "bg-red-500/15 text-red-400"
                                }`}>
                                  {s.verdict.toUpperCase()}
                                </span>
                              </div>
                              <span className={`text-sm font-bold tabular-nums ${pnlColor(s.totalPnl)}`}>
                                {s.totalPnl >= 0 ? "+" : ""}{s.totalPnl.toFixed(1)} pts
                              </span>
                            </div>
                            {s.trades > 0 ? (
                              <div className="grid grid-cols-4 md:grid-cols-8 gap-2 text-[10px]">
                                <div>
                                  <p className="text-muted-foreground/40">Trades</p>
                                  <p className="font-bold">{s.trades}</p>
                                </div>
                                <div>
                                  <p className="text-muted-foreground/40">Win Rate</p>
                                  <p className="font-bold">{(s.winRate * 100).toFixed(0)}%</p>
                                </div>
                                <div>
                                  <p className="text-muted-foreground/40">W/L</p>
                                  <p className="font-bold">{s.wins}/{s.losses}</p>
                                </div>
                                <div>
                                  <p className="text-muted-foreground/40">PF</p>
                                  <p className={`font-bold ${s.profitFactor >= 1.5 ? "text-emerald-400" : s.profitFactor >= 1.0 ? "text-amber-400" : "text-red-400"}`}>
                                    {s.profitFactor.toFixed(2)}
                                  </p>
                                </div>
                                <div>
                                  <p className="text-muted-foreground/40">Avg Win</p>
                                  <p className="text-emerald-400 font-bold">{s.avgWin.toFixed(1)}</p>
                                </div>
                                <div>
                                  <p className="text-muted-foreground/40">Avg Loss</p>
                                  <p className="text-red-400 font-bold">{s.avgLoss.toFixed(1)}</p>
                                </div>
                                <div>
                                  <p className="text-muted-foreground/40">Avg R</p>
                                  <p className="font-bold">{s.avgRMultiple.toFixed(2)}R</p>
                                </div>
                                <div>
                                  <p className="text-muted-foreground/40">Sharpe</p>
                                  <p className="font-bold">{s.sharpe.toFixed(2)}</p>
                                </div>
                              </div>
                            ) : (
                              <p className="text-[10px] text-muted-foreground/30">No trades triggered in test period</p>
                            )}
                          </div>
                        ))}
                      </div>
                    </div>

                    {/* Equity curve (simple text representation) */}
                    {backtest.equity.length > 0 && (
                      <div>
                        <p className="text-xs font-bold mb-2">Equity Curve (cumulative points)</p>
                        <div className="bg-black/30 rounded-lg p-3 h-24 flex items-end gap-px">
                          {(() => {
                            // Sample equity to ~80 bars for display
                            const eq = backtest.equity;
                            const step = Math.max(1, Math.floor(eq.length / 80));
                            const sampled = eq.filter((_, i) => i % step === 0);
                            const min = Math.min(...sampled, 0);
                            const max = Math.max(...sampled, 1);
                            const range = max - min || 1;
                            return sampled.map((v, i) => {
                              const height = ((v - min) / range) * 100;
                              return (
                                <div
                                  key={i}
                                  className={`flex-1 min-w-[2px] rounded-t ${v >= 0 ? "bg-emerald-500/60" : "bg-red-500/60"}`}
                                  style={{ height: `${Math.max(2, height)}%` }}
                                />
                              );
                            });
                          })()}
                        </div>
                        <div className="flex justify-between text-[9px] text-muted-foreground/30 mt-1">
                          <span>Trade 1</span>
                          <span>Max DD: {backtest.summary.maxDrawdown.toFixed(1)} pts</span>
                          <span>Trade {backtest.equity.length}</span>
                        </div>
                      </div>
                    )}

                    {/* Re-run button */}
                    <div className="flex justify-end">
                      <Button
                        size="sm"
                        variant="outline"
                        className="text-xs h-7"
                        onClick={() => {
                          setBacktestLoading(true);
                          setBacktest(null);
                          fetch("/api/futures/backtest")
                            .then((r) => r.json())
                            .then((data) => { if (!data.error) setBacktest(data); })
                            .catch(() => {})
                            .finally(() => setBacktestLoading(false));
                        }}
                      >
                        Re-run Backtest
                      </Button>
                    </div>
                  </div>
                ) : (
                  <p className="text-sm text-muted-foreground/40 text-center py-8">Click to run backtest</p>
                )}
              </CardContent>
            </Card>
          )}

          {/* History tab */}
          {activeTab === "history" && (
            <Card className="border-white/[0.06]">
              <CardContent className="pt-4">
                {trades.length > 0 ? (
                  <div className="overflow-x-auto">
                    <table className="w-full text-xs">
                      <thead>
                        <tr className="text-muted-foreground/40 border-b border-white/[0.06]">
                          <th className="text-left py-2 font-medium">Symbol</th>
                          <th className="text-left py-2 font-medium">Action</th>
                          <th className="text-right py-2 font-medium">Qty</th>
                          <th className="text-right py-2 font-medium">Price</th>
                          <th className="text-right py-2 font-medium">P&L</th>
                          <th className="text-left py-2 font-medium">Reason</th>
                          <th className="text-right py-2 font-medium">Time</th>
                        </tr>
                      </thead>
                      <tbody>
                        {trades.slice(0, 50).map((t, i) => (
                          <tr key={i} className="border-b border-white/[0.03] hover:bg-white/[0.02]">
                            <td className="py-2 font-bold">{t.symbol.replace("FUT:", "")}</td>
                            <td className="py-2">
                              <span className={`px-1.5 py-0.5 rounded text-[10px] font-bold ${
                                t.action.includes("long") ? "bg-emerald-500/15 text-emerald-400" :
                                t.action.includes("short") ? "bg-red-500/15 text-red-400" :
                                "bg-white/10 text-muted-foreground"
                              }`}>{t.action.replace("futures_", "").toUpperCase()}</span>
                            </td>
                            <td className="py-2 text-right tabular-nums">{t.qty}</td>
                            <td className="py-2 text-right tabular-nums">{t.price ? `$${t.price.toFixed(2)}` : "—"}</td>
                            <td className={`py-2 text-right font-bold tabular-nums ${t.pnl != null ? pnlColor(t.pnl) : ""}`}>
                              {t.pnl != null ? `${t.pnl >= 0 ? "+" : ""}$${t.pnl.toFixed(0)}` : "—"}
                            </td>
                            <td className="py-2 text-muted-foreground/60 max-w-[180px] truncate">{t.reason?.slice(0, 60)}</td>
                            <td className="py-2 text-right text-muted-foreground/40 tabular-nums">
                              {new Date(t.time).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : (
                  <p className="text-sm text-muted-foreground/40 text-center py-8">No futures trades yet — agent will log trades here once Tradovate is connected</p>
                )}
              </CardContent>
            </Card>
          )}

          {/* Reports tab */}
          {activeTab === "reports" && (
            <Card className="border-white/[0.06]">
              <CardContent className="pt-4 space-y-6">
                {/* Equity Curve */}
                <div>
                  <p className="text-xs font-bold mb-3">Equity Curve (Cumulative P&L)</p>
                  {closedTrades.length > 0 ? (
                    <>
                      <div className="bg-black/30 rounded-lg p-3 h-32 flex items-end gap-px">
                        {(() => {
                          const sorted = [...closedTrades].sort((a, b) => new Date(a.time).getTime() - new Date(b.time).getTime());
                          let cumPnl = 0;
                          const points = sorted.map((t) => { cumPnl += t.pnl || 0; return cumPnl; });
                          const min = Math.min(...points, 0);
                          const max = Math.max(...points, 1);
                          const range = max - min || 1;
                          return points.map((v, i) => {
                            const height = ((v - min) / range) * 100;
                            return (
                              <div key={i} className={`flex-1 min-w-[3px] rounded-t ${v >= 0 ? "bg-emerald-500/60" : "bg-red-500/60"}`} style={{ height: `${Math.max(3, height)}%` }} />
                            );
                          });
                        })()}
                      </div>
                      <div className="flex justify-between text-[9px] text-muted-foreground/30 mt-1">
                        <span>Trade 1</span>
                        <span>Trade {closedTrades.length}</span>
                      </div>
                    </>
                  ) : (
                    <p className="text-[11px] text-muted-foreground/30 text-center py-8">No closed trades yet</p>
                  )}
                </div>

                {/* Per-Setup Performance */}
                <div>
                  <p className="text-xs font-bold mb-3">Performance by Setup</p>
                  {(() => {
                    // Parse setup type from reason/action
                    const setupMap: Record<string, { wins: number; losses: number; pnl: number; trades: number }> = {};
                    for (const t of closedTrades) {
                      let setup = "Other";
                      const action = t.action || "";
                      const reason = (t.reason || "").toLowerCase();
                      if (action.includes("scale_out")) setup = "Scale Out";
                      else if (action.includes("trail_stop")) setup = "Trail Stop";
                      else if (action.includes("breakeven")) setup = "Breakeven";
                      else if (action.includes("take_profit")) setup = "Take Profit";
                      else if (action.includes("emergency")) setup = "Emergency";
                      else if (reason.includes("gap fill")) setup = "Gap Fill";
                      else if (reason.includes("failed ib")) setup = "Failed IB";
                      else if (reason.includes("or breakout") || reason.includes("ib breakout")) setup = "IB Breakout";
                      else if (reason.includes("trend pullback") || reason.includes("trend continuation")) setup = "Trend Cont.";
                      else if (reason.includes("rsi")) setup = "RSI Bounce";
                      else if (action.includes("stop_loss")) setup = "Stop Loss";
                      if (!setupMap[setup]) setupMap[setup] = { wins: 0, losses: 0, pnl: 0, trades: 0 };
                      setupMap[setup].trades++;
                      setupMap[setup].pnl += t.pnl || 0;
                      if ((t.pnl || 0) > 0) setupMap[setup].wins++;
                      else if ((t.pnl || 0) < 0) setupMap[setup].losses++;
                    }
                    const entries = Object.entries(setupMap).sort(([, a], [, b]) => b.pnl - a.pnl);
                    return entries.length > 0 ? (
                      <div className="space-y-2">
                        {entries.map(([setup, data]) => (
                          <div key={setup} className={`bg-white/[0.02] border rounded-lg p-3 ${data.pnl >= 0 ? "border-emerald-500/20" : "border-red-500/20"}`}>
                            <div className="flex items-center justify-between mb-1">
                              <span className="text-sm font-bold">{setup}</span>
                              <span className={`text-sm font-bold tabular-nums ${pnlColor(data.pnl)}`}>
                                {data.pnl >= 0 ? "+" : "-"}${Math.abs(data.pnl).toFixed(0)}
                              </span>
                            </div>
                            <div className="flex gap-4 text-[10px] text-muted-foreground/60">
                              <span>{data.trades} trades</span>
                              <span>{data.wins}W / {data.losses}L</span>
                              <span>{data.trades > 0 ? `${((data.wins / data.trades) * 100).toFixed(0)}%` : "—"} WR</span>
                              <span>Avg: {data.trades > 0 ? `${data.pnl >= 0 ? "+" : "-"}$${Math.abs(data.pnl / data.trades).toFixed(0)}` : "—"}</span>
                            </div>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <p className="text-[11px] text-muted-foreground/30 text-center py-4">No data yet</p>
                    );
                  })()}
                </div>

                {/* Daily P&L Breakdown */}
                <div>
                  <p className="text-xs font-bold mb-3">Daily P&L</p>
                  {(() => {
                    const dayMap: Record<string, { pnl: number; trades: number; wins: number }> = {};
                    for (const t of closedTrades) {
                      const day = new Date(t.time).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
                      if (!dayMap[day]) dayMap[day] = { pnl: 0, trades: 0, wins: 0 };
                      dayMap[day].pnl += t.pnl || 0;
                      dayMap[day].trades++;
                      if ((t.pnl || 0) > 0) dayMap[day].wins++;
                    }
                    const days = Object.entries(dayMap);
                    return days.length > 0 ? (
                      <div className="space-y-1.5">
                        {days.map(([day, data]) => (
                          <div key={day} className="flex items-center justify-between bg-white/[0.02] rounded-lg px-3 py-2">
                            <div>
                              <span className="text-xs font-medium">{day}</span>
                              <span className="text-[9px] text-muted-foreground/40 ml-2">{data.trades} trades ({data.wins}W)</span>
                            </div>
                            <span className={`text-sm font-bold tabular-nums ${pnlColor(data.pnl)}`}>
                              {data.pnl >= 0 ? "+" : "-"}${Math.abs(data.pnl).toFixed(0)}
                            </span>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <p className="text-[11px] text-muted-foreground/30 text-center py-4">No data yet</p>
                    );
                  })()}
                </div>

                {/* Key Stats */}
                <div>
                  <p className="text-xs font-bold mb-3">Key Metrics</p>
                  <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                    <div className="bg-white/[0.03] rounded-lg p-3">
                      <p className="text-[9px] text-muted-foreground/40 uppercase">Profit Factor</p>
                      <p className={`text-xl font-bold ${(wins.reduce((s, t) => s + (t.pnl || 0), 0) / Math.abs(losses.reduce((s, t) => s + (t.pnl || 0), 0) || 1)) >= 1 ? "text-emerald-400" : "text-red-400"}`}>
                        {losses.length > 0 ? (wins.reduce((s, t) => s + (t.pnl || 0), 0) / Math.abs(losses.reduce((s, t) => s + (t.pnl || 0), 0))).toFixed(2) : "—"}
                      </p>
                    </div>
                    <div className="bg-white/[0.03] rounded-lg p-3">
                      <p className="text-[9px] text-muted-foreground/40 uppercase">Expectancy</p>
                      <p className={`text-xl font-bold ${closedTrades.length > 0 && totalPnl / closedTrades.length >= 0 ? "text-emerald-400" : "text-red-400"}`}>
                        {closedTrades.length > 0 ? `${totalPnl / closedTrades.length >= 0 ? "+" : ""}$${(totalPnl / closedTrades.length).toFixed(0)}` : "—"}
                      </p>
                      <p className="text-[9px] text-muted-foreground/30">per trade</p>
                    </div>
                    <div className="bg-white/[0.03] rounded-lg p-3">
                      <p className="text-[9px] text-muted-foreground/40 uppercase">Max Drawdown</p>
                      <p className="text-xl font-bold text-red-400">
                        {(() => {
                          const sorted = [...closedTrades].sort((a, b) => new Date(a.time).getTime() - new Date(b.time).getTime());
                          let peak = 0, maxDD = 0, cum = 0;
                          for (const t of sorted) { cum += t.pnl || 0; peak = Math.max(peak, cum); maxDD = Math.min(maxDD, cum - peak); }
                          return `$${Math.abs(maxDD).toFixed(0)}`;
                        })()}
                      </p>
                    </div>
                    <div className="bg-white/[0.03] rounded-lg p-3">
                      <p className="text-[9px] text-muted-foreground/40 uppercase">Win/Loss Ratio</p>
                      <p className={`text-xl font-bold ${avgWin > 0 && Math.abs(avgLoss) > 0 && avgWin / Math.abs(avgLoss) >= 1 ? "text-emerald-400" : "text-red-400"}`}>
                        {avgWin > 0 && avgLoss < 0 ? (avgWin / Math.abs(avgLoss)).toFixed(2) : "—"}
                      </p>
                      <p className="text-[9px] text-muted-foreground/30">avg win / avg loss</p>
                    </div>
                  </div>
                </div>
              </CardContent>
            </Card>
          )}
        </div>

        {/* Right sidebar: Positions + Stats + Activity */}
        <div className="space-y-3">
          {/* ── LIVE POSITIONS ── */}
          <Card className={`border-white/[0.06] ${posData?.positions?.length ? "border-emerald-500/20" : ""}`}>
            <CardHeader className="pb-2">
              <div className="flex items-center justify-between">
                <CardTitle className="text-[11px] text-muted-foreground/40 uppercase tracking-wider font-bold">
                  Open Positions
                </CardTitle>
                {posData?.positions?.length ? (
                  <span className="relative flex h-2 w-2">
                    <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75" />
                    <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-400" />
                  </span>
                ) : null}
              </div>
            </CardHeader>
            <CardContent>
              {posData?.positions && posData.positions.length > 0 ? (
                <div className="space-y-2">
                  {posData.positions.map((pos) => {
                    const isProfit = pos.unrealizedPnl >= 0;
                    return (
                      <div key={pos.id} className="bg-white/[0.03] border border-white/[0.06] rounded-lg p-2.5 space-y-2">
                        {/* Header: symbol + direction + P&L */}
                        <div className="flex items-center justify-between">
                          <div className="flex items-center gap-2">
                            <span className="text-sm font-bold">{pos.symbol}</span>
                            <span className={`text-[9px] font-bold px-1.5 py-0.5 rounded ${
                              pos.direction === "long" ? "bg-emerald-500/15 text-emerald-400" : "bg-red-500/15 text-red-400"
                            }`}>
                              {pos.direction.toUpperCase()} {pos.quantity}x
                            </span>
                          </div>
                          <span className={`text-sm font-bold tabular-nums ${pnlColor(pos.unrealizedPnl)}`}>
                            {pos.unrealizedPnl >= 0 ? "+" : ""}${pos.unrealizedPnl.toFixed(0)}
                          </span>
                        </div>

                        {/* Prices row */}
                        <div className="grid grid-cols-3 gap-2 text-[10px]">
                          <div>
                            <p className="text-muted-foreground/40">Entry</p>
                            <p className="font-medium tabular-nums">${formatNum(pos.entryPrice)}</p>
                          </div>
                          <div>
                            <p className="text-muted-foreground/40">Current</p>
                            <p className={`font-medium tabular-nums ${isProfit ? "text-emerald-400" : "text-red-400"}`}>
                              ${formatNum(pos.currentPrice)}
                            </p>
                          </div>
                          <div>
                            <p className="text-muted-foreground/40">AI Score</p>
                            <p className="font-medium">{pos.aiScore ? `${pos.aiScore}%` : "—"}</p>
                          </div>
                        </div>

                        {/* Stop / Target progress bar */}
                        {(pos.stopLoss || pos.target) && (
                          <div className="space-y-1">
                            <div className="flex justify-between text-[9px]">
                              <span className="text-red-400/70">
                                Stop ${pos.stopLoss ? formatNum(pos.stopLoss) : "—"}
                                {pos.pctToStop != null && <span className="ml-1">({pos.pctToStop.toFixed(1)}%)</span>}
                              </span>
                              <span className="text-emerald-400/70">
                                Target ${pos.target ? formatNum(pos.target) : "—"}
                                {pos.pctToTarget != null && <span className="ml-1">({pos.pctToTarget.toFixed(1)}%)</span>}
                              </span>
                            </div>
                            {/* Visual progress between stop and target */}
                            {pos.stopLoss && pos.target && (
                              <div className="h-1.5 bg-white/[0.06] rounded-full overflow-hidden">
                                {(() => {
                                  const range = pos.target - pos.stopLoss;
                                  const progress = range !== 0 ? ((pos.currentPrice - pos.stopLoss) / range) * 100 : 50;
                                  const clampedProgress = Math.max(0, Math.min(100, progress));
                                  return (
                                    <div
                                      className={`h-full rounded-full transition-all ${isProfit ? "bg-emerald-500" : "bg-red-500"}`}
                                      style={{ width: `${clampedProgress}%` }}
                                    />
                                  );
                                })()}
                              </div>
                            )}
                          </div>
                        )}

                        {/* Setup name + time */}
                        <div className="flex justify-between text-[9px] text-muted-foreground/30">
                          {pos.setup && <span>{pos.setup}</span>}
                          <span>{new Date(pos.openedAt).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}</span>
                        </div>
                      </div>
                    );
                  })}

                  {/* Account summary when positions exist */}
                  {posData.account && (
                    <div className="pt-2 border-t border-white/[0.06] grid grid-cols-2 gap-2 text-[10px]">
                      <div>
                        <span className="text-muted-foreground/40">Net Liq</span>
                        <p className="font-bold">${posData.account.netLiq.toLocaleString()}</p>
                      </div>
                      <div>
                        <span className="text-muted-foreground/40">Margin Used</span>
                        <p className="font-bold">${posData.account.marginUsed.toLocaleString()}</p>
                      </div>
                    </div>
                  )}
                </div>
              ) : (
                <p className="text-[11px] text-muted-foreground/30 text-center py-4">
                  {posData?.connected ? "No open positions" : "Positions will appear once Tradovate is connected"}
                </p>
              )}
              {/* Account summary — always visible */}
              {posData?.account && (
                <div className="pt-2 mt-2 border-t border-white/[0.06] grid grid-cols-2 gap-2 text-[10px]">
                  <div>
                    <span className="text-muted-foreground/40">Balance</span>
                    <p className="font-bold">${posData.account.balance.toLocaleString()}</p>
                  </div>
                  <div>
                    <span className="text-muted-foreground/40">Net Liq</span>
                    <p className="font-bold">${posData.account.netLiq.toLocaleString()}</p>
                  </div>
                  <div>
                    <span className="text-muted-foreground/40">Realized P&L</span>
                    <p className={`font-bold ${pnlColor(posData.account.realizedPnl)}`}>
                      {posData.account.realizedPnl >= 0 ? "+" : ""}${posData.account.realizedPnl.toLocaleString()}
                    </p>
                  </div>
                  <div>
                    <span className="text-muted-foreground/40">Margin Used</span>
                    <p className="font-bold">${posData.account.marginUsed.toLocaleString()}</p>
                  </div>
                </div>
              )}
            </CardContent>
          </Card>

          {/* ── PERFORMANCE STATS ── */}
          <Card className="border-white/[0.06]">
            <CardHeader className="pb-2">
              <CardTitle className="text-[11px] text-muted-foreground/40 uppercase tracking-wider font-bold">Performance</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              {/* Total P&L */}
              <div>
                <p className="text-[10px] text-muted-foreground/40">Total P&L</p>
                <p className={`text-2xl font-bold tabular-nums ${pnlColor(totalPnl)}`}>
                  {totalPnl >= 0 ? "+" : "-"}${Math.abs(totalPnl).toFixed(0)}
                </p>
              </div>
              {/* Win Rate + Trades */}
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <p className="text-[10px] text-muted-foreground/40">Win Rate</p>
                  <p className="text-lg font-bold">
                    {closedTrades.length > 0 ? `${((wins.length / closedTrades.length) * 100).toFixed(0)}%` : "—"}
                  </p>
                  <p className="text-[9px] text-muted-foreground/30">{wins.length}W / {losses.length}L</p>
                </div>
                <div>
                  <p className="text-[10px] text-muted-foreground/40">Trades</p>
                  <p className="text-lg font-bold">{closedTrades.length}</p>
                  <p className="text-[9px] text-muted-foreground/30">closed total</p>
                </div>
              </div>
              {/* Avg Win / Avg Loss */}
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <p className="text-[10px] text-muted-foreground/40">Avg Win</p>
                  <p className="text-sm font-bold text-emerald-400 tabular-nums">
                    {wins.length > 0 ? `+$${avgWin.toFixed(0)}` : "—"}
                  </p>
                </div>
                <div>
                  <p className="text-[10px] text-muted-foreground/40">Avg Loss</p>
                  <p className="text-sm font-bold text-red-400 tabular-nums">
                    {losses.length > 0 ? `-$${Math.abs(avgLoss).toFixed(0)}` : "—"}
                  </p>
                </div>
              </div>
              {/* Best / Worst */}
              {bestTrade && (
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <p className="text-[10px] text-muted-foreground/40">Best Trade</p>
                    <p className="text-[11px] font-bold text-emerald-400 tabular-nums">+${(bestTrade.pnl || 0).toFixed(0)}</p>
                    <p className="text-[9px] text-muted-foreground/30">{bestTrade.symbol.replace("FUT:", "")}</p>
                  </div>
                  {worstTrade && (
                    <div>
                      <p className="text-[10px] text-muted-foreground/40">Worst Trade</p>
                      <p className="text-[11px] font-bold text-red-400 tabular-nums">-${Math.abs(worstTrade.pnl || 0).toFixed(0)}</p>
                      <p className="text-[9px] text-muted-foreground/30">{worstTrade.symbol.replace("FUT:", "")}</p>
                    </div>
                  )}
                </div>
              )}
              {/* Daily / Weekly / Monthly P&L */}
              <div className="pt-2 border-t border-white/[0.06] space-y-2">
                <div className="flex justify-between items-center">
                  <span className="text-[10px] text-muted-foreground/40">Today</span>
                  <div className="text-right">
                    <span className={`text-sm font-bold tabular-nums ${pnlColor(dailyPnl)}`}>
                      {dailyPnl >= 0 ? "+" : "-"}${Math.abs(dailyPnl).toFixed(0)}
                    </span>
                    <span className="text-[9px] text-muted-foreground/30 ml-1.5">{dailyTrades} trades</span>
                  </div>
                </div>
                <div className="flex justify-between items-center">
                  <span className="text-[10px] text-muted-foreground/40">This Week</span>
                  <div className="text-right">
                    <span className={`text-sm font-bold tabular-nums ${pnlColor(weeklyPnl)}`}>
                      {weeklyPnl >= 0 ? "+" : "-"}${Math.abs(weeklyPnl).toFixed(0)}
                    </span>
                    <span className="text-[9px] text-muted-foreground/30 ml-1.5">{weeklyTrades} trades</span>
                  </div>
                </div>
                <div className="flex justify-between items-center">
                  <span className="text-[10px] text-muted-foreground/40">This Month</span>
                  <div className="text-right">
                    <span className={`text-sm font-bold tabular-nums ${pnlColor(monthlyPnl)}`}>
                      {monthlyPnl >= 0 ? "+" : "-"}${Math.abs(monthlyPnl).toFixed(0)}
                    </span>
                    <span className="text-[9px] text-muted-foreground/30 ml-1.5">{monthlyTrades} trades</span>
                  </div>
                </div>
              </div>
            </CardContent>
          </Card>

          {/* ── AGENT ACTIVITY FEED ── */}
          <Card className="border-white/[0.06]">
            <CardHeader className="pb-2">
              <CardTitle className="text-[11px] text-muted-foreground/40 uppercase tracking-wider font-bold">Agent Activity</CardTitle>
            </CardHeader>
            <CardContent>
              {posData?.activity && posData.activity.length > 0 ? (
                <div className="space-y-1.5 max-h-72 overflow-y-auto">
                  {posData.activity.slice(0, 15).map((log) => (
                    <div key={log.id} className="flex items-start gap-2 text-[10px]">
                      <span className={`shrink-0 mt-0.5 w-1.5 h-1.5 rounded-full ${
                        log.action.includes("long") ? "bg-emerald-500" :
                        log.action.includes("short") ? "bg-red-500" :
                        log.action.includes("close") ? "bg-amber-500" :
                        "bg-white/20"
                      }`} />
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-1.5">
                          <span className="font-bold">{log.symbol}</span>
                          <span className={`px-1 py-0.5 rounded text-[8px] font-bold ${
                            log.action.includes("long") ? "bg-emerald-500/15 text-emerald-400" :
                            log.action.includes("short") ? "bg-red-500/15 text-red-400" :
                            "bg-white/10 text-muted-foreground"
                          }`}>
                            {log.action.replace("futures_", "").toUpperCase()}
                          </span>
                          <span className="text-muted-foreground/30 tabular-nums">{log.qty}x</span>
                          {log.pnl != null && (
                            <span className={`font-bold tabular-nums ${pnlColor(log.pnl)}`}>
                              {log.pnl >= 0 ? "+" : ""}${log.pnl.toFixed(0)}
                            </span>
                          )}
                          {log.aiScore && (
                            <span className="text-blue-400/60">{log.aiScore}%</span>
                          )}
                        </div>
                        <p className="text-muted-foreground/30 truncate">{log.reason?.slice(0, 80)}</p>
                        <p className="text-muted-foreground/20 tabular-nums">
                          {new Date(log.time).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}
                        </p>
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="text-[11px] text-muted-foreground/30 text-center py-3">No agent activity yet</p>
              )}
            </CardContent>
          </Card>

          {/* ── CONTRACT SPECS ── */}
          {selectedQuote && (
            <Card className="border-white/[0.06]">
              <CardHeader className="pb-2">
                <CardTitle className="text-[11px] text-muted-foreground/40 uppercase tracking-wider font-bold">
                  {selectedQuote.symbol} Specs
                </CardTitle>
              </CardHeader>
              <CardContent>
                <div className="space-y-1.5 text-xs">
                  <div className="flex justify-between">
                    <span className="text-muted-foreground/60">Contract</span>
                    <span className="font-medium">{selectedQuote.name}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground/60">Multiplier</span>
                    <span className="font-medium">${selectedQuote.multiplier}/pt</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground/60">Tick Size</span>
                    <span className="font-medium">{selectedQuote.tickSize}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground/60">Tick Value</span>
                    <span className="font-medium">${(selectedQuote.tickSize * selectedQuote.multiplier).toFixed(2)}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground/60">Day Margin</span>
                    <span className="font-medium">${selectedQuote.margin.toLocaleString()}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground/60">Day Range</span>
                    <span className="font-medium tabular-nums">
                      {formatNum(selectedQuote.low)} — {formatNum(selectedQuote.high)}
                    </span>
                  </div>
                </div>
              </CardContent>
            </Card>
          )}

          {/* ── SETUP REQUIRED ── */}
          {!status?.connected && (
            <Card className="border-amber-500/20 bg-amber-500/[0.03]">
              <CardHeader className="pb-2">
                <CardTitle className="text-[11px] text-amber-400 uppercase tracking-wider font-bold">Setup Required</CardTitle>
              </CardHeader>
              <CardContent className="text-[11px] space-y-2 text-muted-foreground/60">
                <p>Tradovate deposit clears ~May 14. Then:</p>
                <div className="space-y-1 ml-2">
                  <p>1. Subscribe to API ($25/mo)</p>
                  <p>2. Create API keys (CID + SEC)</p>
                  <p>3. Set Vercel env vars</p>
                  <p>4. Redeploy — agent auto-connects</p>
                </div>
                <p className="text-[9px] text-muted-foreground/30 pt-1">Charts + quotes work now via Yahoo Finance. Agent + positions need Tradovate auth.</p>
              </CardContent>
            </Card>
          )}

          {/* ── AGENT OUTPUT ── */}
          {result && (
            <Card className="border-white/[0.06]">
              <CardHeader className="pb-2">
                <CardTitle className="text-[11px] text-muted-foreground/40 uppercase tracking-wider font-bold">Last Agent Run</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="bg-black/30 rounded-lg p-2 max-h-64 overflow-y-auto font-mono text-[10px] text-muted-foreground/60 space-y-0.5">
                  {result.details.map((d, i) => (
                    <div key={i} className={
                      d.includes("TRADE:") || d.includes("ORDER PLACED") ? "text-emerald-400 font-medium" :
                      d.includes("STOP") || d.includes("EMERGENCY") ? "text-red-400" :
                      d.includes("SETUP:") ? "text-blue-400 font-medium" :
                      d.includes("REGIME:") || d.includes("MACRO:") ? "text-purple-400" :
                      ""
                    }>{d}</div>
                  ))}
                </div>
              </CardContent>
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}
