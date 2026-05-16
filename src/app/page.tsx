"use client";

import Link from "next/link";
import { useAccount } from "@/hooks/use-account";
import { usePositions } from "@/hooks/use-positions";
import { formatCurrency, pnlColor } from "@/lib/utils";
import { useEffect, useState, useMemo } from "react";

// ── Types ──────────────────────────────────────────────

interface RegimeData {
  regime: string;
  recommendation: string;
  positionSizeMultiplier: number;
  spy1mReturn: number;
  rsi: number | null;
  volatility: number;
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

interface FuturesData {
  connected: boolean;
  account: FuturesAccount | null;
  positions: FuturesPosition[];
  activity: { id: string; symbol: string; action: string; qty: number; price: number | null; pnl: number | null; reason: string; time: string }[];
  engineStatus?: { alive: boolean; lastHeartbeat: string | null; ageMinutes: number };
  startOfDayBalance?: number | null;
  fillBasedPnl?: { totalPnl: number; tradeCount: number; wins: number; losses: number; roundTrips: { symbol: string; direction: string; qty: number; entryPrice: number; exitPrice: number; pnl: number; entryTime: string; exitTime: string }[] };
}

interface FuturesQuote {
  symbol: string;
  name: string;
  price: number;
  change: number;
  changePercent: number;
  volume: number;
}

function parseOptionSymbol(symbol: string) {
  const match = symbol.match(/^([A-Z]+)(\d{6})([CP])(\d+)$/);
  if (!match) return null;
  const underlying = match[1];
  const dateStr = match[2];
  const type = match[3] === "C" ? "CALL" : "PUT";
  const strike = parseInt(match[4]) / 1000;
  const expiry = new Date(`20${dateStr.slice(0, 2)}-${dateStr.slice(2, 4)}-${dateStr.slice(4, 6)}`);
  const now = new Date();
  const dte = Math.max(0, Math.ceil((expiry.getTime() - now.getTime()) / (1000 * 60 * 60 * 24)));
  return { underlying, type, strike, expiry: expiry.toLocaleDateString("en-US", { month: "short", day: "numeric" }), dte };
}

// ── Allocation Bar Component ───────────────────────────

function AllocationBar({ segments }: { segments: { label: string; value: number; color: string; pct: number }[] }) {
  const total = segments.reduce((s, seg) => s + seg.value, 0);
  if (total === 0) return null;
  return (
    <div className="space-y-2">
      <div className="flex h-2.5 rounded-full overflow-hidden bg-white/[0.04]">
        {segments.filter(s => s.pct > 0).map((seg) => (
          <div
            key={seg.label}
            className={`${seg.color} transition-all duration-500`}
            style={{ width: `${seg.pct}%` }}
            title={`${seg.label}: ${formatCurrency(seg.value)} (${seg.pct.toFixed(1)}%)`}
          />
        ))}
      </div>
      <div className="flex gap-4">
        {segments.filter(s => s.pct > 0).map((seg) => (
          <div key={seg.label} className="flex items-center gap-1.5">
            <span className={`w-2 h-2 rounded-full ${seg.color}`} />
            <span className="text-[10px] text-muted-foreground/60">{seg.label}</span>
            <span className="text-[10px] font-bold tabular-nums">{seg.pct.toFixed(0)}%</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Position Row Component ─────────────────────────────

function PositionWeight({ value, total }: { value: number; total: number }) {
  const pct = total > 0 ? (Math.abs(value) / total) * 100 : 0;
  return (
    <div className="hidden md:flex items-center gap-1.5 min-w-[60px]">
      <div className="flex-1 h-1 rounded-full bg-white/[0.06] overflow-hidden">
        <div className="h-full rounded-full bg-white/20" style={{ width: `${Math.min(100, pct)}%` }} />
      </div>
      <span className="text-[9px] text-muted-foreground/40 tabular-nums w-6 text-right">{pct.toFixed(0)}%</span>
    </div>
  );
}

// ── Main Page ──────────────────────────────────────────

export default function DashboardPage() {
  const { data: account, isLoading: accountLoading } = useAccount();
  const { data: positions, isLoading: positionsLoading } = usePositions();
  const [regime, setRegime] = useState<RegimeData | null>(null);
  const [futures, setFutures] = useState<FuturesData | null>(null);
  const [futuresQuotes, setFuturesQuotes] = useState<FuturesQuote[]>([]);
  const [portfolioHistory, setPortfolioHistory] = useState<{ timestamp: number[]; equity: number[] } | null>(null);

  useEffect(() => {
    fetch("/api/regime").then((r) => r.json()).then((d) => { if (!d.error) setRegime(d); }).catch(() => {});
    fetch("/api/futures/positions").then((r) => r.json()).then((d) => { if (!d.error) setFutures(d); }).catch(() => {});
    fetch("/api/futures/quotes").then((r) => r.json()).then((d) => { if (Array.isArray(d)) setFuturesQuotes(d); }).catch(() => {});
    fetch("/api/portfolio-history?period=1M&timeframe=1D").then((r) => r.json()).then((d) => { if (!d.error && d.timestamp) setPortfolioHistory(d); }).catch(() => {});

    const futuresInterval = setInterval(() => {
      fetch("/api/futures/positions").then((r) => r.json()).then((d) => { if (!d.error) setFutures(d); }).catch(() => {});
    }, 10000);
    const quotesInterval = setInterval(() => {
      fetch("/api/futures/quotes").then((r) => r.json()).then((d) => { if (Array.isArray(d)) setFuturesQuotes(d); }).catch(() => {});
    }, 15000);

    return () => { clearInterval(futuresInterval); clearInterval(quotesInterval); };
  }, []);

  // ── Alpaca metrics ──
  const alpacaEquity = account ? parseFloat(account.equity) : 0;
  const alpacaLastEquity = account ? parseFloat(account.last_equity) : 0;
  const alpacaDailyPnl = alpacaEquity - alpacaLastEquity;
  const alpacaCash = account ? parseFloat(account.cash) : 0;
  const alpacaBuyingPower = account ? parseFloat(account.buying_power) : 0;
  const alpacaUnrealized = positions?.reduce((s, p) => s + parseFloat(p.unrealized_pl), 0) || 0;

  // Split Alpaca positions
  const stockPositions = useMemo(() => positions?.filter((p) => !parseOptionSymbol(p.symbol)) || [], [positions]);
  const optionPositions = useMemo(() => positions?.filter((p) => !!parseOptionSymbol(p.symbol)) || [], [positions]);

  // ── Futures metrics ──
  const futuresEquity = futures?.account?.netLiq || 0;
  const futuresBalance = futures?.account?.balance || 0;
  const futuresSOD = futures?.startOfDayBalance;
  const futuresDailyPnl = (futuresSOD != null && futuresBalance)
    ? futuresBalance - futuresSOD
    : (futures?.account?.realizedPnl || 0);
  const futuresUnrealized = futures?.account?.unrealizedPnl || 0;
  const futuresMargin = futures?.account?.marginUsed || 0;

  // ── Combined metrics ──
  const combinedEquity = alpacaEquity + futuresEquity;
  const combinedDailyPnl = alpacaDailyPnl + futuresDailyPnl;
  const combinedDailyPct = (alpacaLastEquity + (futuresSOD || futuresBalance)) > 0
    ? combinedDailyPnl / (alpacaLastEquity + (futuresSOD || futuresBalance || 1))
    : 0;
  const combinedUnrealized = alpacaUnrealized + futuresUnrealized;
  const totalPositions = (positions?.length || 0) + (futures?.positions?.length || 0);

  // ── Risk / Allocation ──
  const stockMktVal = stockPositions.reduce((s, p) => s + Math.abs(parseFloat(p.market_value)), 0);
  const optionMktVal = optionPositions.reduce((s, p) => s + Math.abs(parseFloat(p.market_value)), 0);
  const futuresNotional = futures?.positions?.reduce((s, p) => s + (p.currentPrice * p.multiplier * p.quantity), 0) || 0;
  const totalExposure = stockMktVal + optionMktVal + futuresNotional;
  const leverageRatio = combinedEquity > 0 ? totalExposure / combinedEquity : 0;
  const marginUtilization = futuresEquity > 0 ? (futuresMargin / futuresEquity) * 100 : 0;
  const freeCash = alpacaCash + Math.max(0, futuresBalance - futuresMargin);
  const cashPct = combinedEquity > 0 ? (freeCash / combinedEquity) * 100 : 100;

  // Allocation segments
  const allocSegments = useMemo(() => {
    const total = stockMktVal + optionMktVal + futuresNotional + freeCash;
    if (total <= 0) return [];
    return [
      { label: "Stocks", value: stockMktVal, color: "bg-blue-500", pct: (stockMktVal / total) * 100 },
      { label: "Options", value: optionMktVal, color: "bg-purple-500", pct: (optionMktVal / total) * 100 },
      { label: "Futures", value: futuresNotional, color: "bg-amber-500", pct: (futuresNotional / total) * 100 },
      { label: "Cash", value: freeCash, color: "bg-emerald-500/40", pct: (freeCash / total) * 100 },
    ];
  }, [stockMktVal, optionMktVal, futuresNotional, freeCash]);

  // Recent activity (combined from both brokers, sorted by time)
  const recentActivity = useMemo(() => {
    const items: { id: string; symbol: string; action: string; pnl: number | null; time: string; source: "alpaca" | "futures" }[] = [];
    if (futures?.activity) {
      for (const a of futures.activity.slice(0, 10)) {
        items.push({ id: a.id, symbol: a.symbol, action: a.action.replace("futures_", "").replace(/_/g, " "), pnl: a.pnl, time: a.time, source: "futures" });
      }
    }
    return items.sort((a, b) => new Date(b.time).getTime() - new Date(a.time).getTime()).slice(0, 8);
  }, [futures?.activity]);

  // Equity sparkline data
  const sparkline = useMemo(() => {
    if (!portfolioHistory?.equity?.length) return null;
    const eq = portfolioHistory.equity;
    const min = Math.min(...eq);
    const max = Math.max(...eq);
    const range = max - min || 1;
    return eq.map((v) => ((v - min) / range) * 100);
  }, [portfolioHistory]);

  // Loading state
  const isLoading = accountLoading || positionsLoading;

  return (
    <div className="space-y-5">
      {/* ── Header ── */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-xl font-bold tracking-tight">Dashboard</h2>
          <p className="text-[11px] text-muted-foreground/50">
            Unified portfolio — Alpaca + Tradovate
          </p>
        </div>
        <div className="flex items-center gap-3">
          {futures?.engineStatus?.alive && (
            <span className="flex items-center gap-1.5 text-[10px] text-blue-400">
              <span className="relative flex h-1.5 w-1.5">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-blue-400 opacity-75" />
                <span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-blue-400" />
              </span>
              Engine Live
            </span>
          )}
          <div className="flex items-center gap-1.5">
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 live-dot" />
            <span className="text-[10px] text-muted-foreground/40">Live</span>
          </div>
        </div>
      </div>

      {/* ── Hero: Combined Portfolio + Sparkline ── */}
      <div className="grid grid-cols-1 md:grid-cols-[1fr_280px] gap-3">
        {/* Main metrics */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          {isLoading ? (
            Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="rounded-xl border border-white/[0.06] bg-white/[0.02] p-4">
                <div className="skeleton h-3 w-16 rounded mb-2" />
                <div className="skeleton h-6 w-24 rounded mb-1" />
                <div className="skeleton h-3 w-20 rounded" />
              </div>
            ))
          ) : (
            <>
              <div className="rounded-xl border border-white/[0.08] bg-white/[0.03] p-4">
                <p className="text-[10px] text-muted-foreground/50 uppercase tracking-wider font-bold">Total Equity</p>
                <p className="text-2xl font-black mt-1 tabular-nums">{formatCurrency(combinedEquity)}</p>
                <p className="text-[11px] mt-0.5 text-muted-foreground/40">{totalPositions} positions · 2 accounts</p>
              </div>
              <div className="rounded-xl border border-white/[0.06] bg-white/[0.02] p-4">
                <p className="text-[10px] text-muted-foreground/50 uppercase tracking-wider font-medium">Daily P&L</p>
                <p className={`text-2xl font-black mt-1 tabular-nums ${pnlColor(combinedDailyPnl)}`}>
                  {combinedDailyPnl >= 0 ? "+" : ""}{formatCurrency(combinedDailyPnl)}
                </p>
                <p className={`text-[11px] mt-0.5 tabular-nums ${pnlColor(combinedDailyPct)}`}>
                  {combinedDailyPct >= 0 ? "+" : ""}{(combinedDailyPct * 100).toFixed(2)}%
                </p>
              </div>
              <div className="rounded-xl border border-white/[0.06] bg-white/[0.02] p-4">
                <p className="text-[10px] text-muted-foreground/50 uppercase tracking-wider font-medium">Unrealized</p>
                <p className={`text-2xl font-black mt-1 tabular-nums ${pnlColor(combinedUnrealized)}`}>
                  {combinedUnrealized >= 0 ? "+" : ""}{formatCurrency(combinedUnrealized)}
                </p>
                <p className="text-[11px] mt-0.5 text-muted-foreground/50">
                  {totalPositions} across 2 brokers
                </p>
              </div>
              <div className="rounded-xl border border-white/[0.06] bg-white/[0.02] p-4">
                <p className="text-[10px] text-muted-foreground/50 uppercase tracking-wider font-medium">Cash</p>
                <p className="text-2xl font-black mt-1 tabular-nums">{formatCurrency(freeCash)}</p>
                <p className="text-[11px] mt-0.5 text-muted-foreground/50">{cashPct.toFixed(0)}% liquid</p>
              </div>
            </>
          )}
        </div>

        {/* Sparkline card */}
        <div className="rounded-xl border border-white/[0.06] bg-white/[0.02] p-4 flex flex-col justify-between">
          <p className="text-[10px] text-muted-foreground/50 uppercase tracking-wider font-medium mb-2">30-Day Equity</p>
          {sparkline ? (
            <div className="flex items-end gap-[2px] h-16 mt-auto">
              {sparkline.map((h, i) => {
                const isLast = i === sparkline.length - 1;
                const prevH = i > 0 ? sparkline[i - 1] : h;
                const isUp = h >= prevH;
                return (
                  <div
                    key={i}
                    className={`flex-1 min-w-[2px] rounded-t transition-all ${
                      isLast ? (isUp ? "bg-emerald-400" : "bg-red-400") :
                      isUp ? "bg-emerald-500/40" : "bg-red-500/40"
                    }`}
                    style={{ height: `${Math.max(3, h)}%` }}
                  />
                );
              })}
            </div>
          ) : (
            <div className="flex items-end gap-[2px] h-16 mt-auto">
              {Array.from({ length: 20 }).map((_, i) => (
                <div key={i} className="flex-1 skeleton rounded-t" style={{ height: `${35 + ((i * 17 + 7) % 45)}%` }} />
              ))}
            </div>
          )}
          <div className="flex justify-between mt-1.5 text-[9px] text-muted-foreground/30">
            <span>30d ago</span>
            <span>Today</span>
          </div>
        </div>
      </div>

      {/* ── Per-Broker Breakdown ── */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <div className="rounded-xl border border-blue-500/15 bg-gradient-to-br from-blue-500/[0.04] to-transparent p-4">
          <div className="flex items-center justify-between mb-2">
            <div className="flex items-center gap-2">
              <span className="w-2 h-2 rounded-full bg-blue-400" />
              <span className="text-xs font-bold">Alpaca</span>
              <span className="text-[10px] text-muted-foreground/40">Stocks & Options</span>
            </div>
            <Link href="/stocks" className="text-[10px] text-blue-400 hover:underline">View</Link>
          </div>
          <div className="grid grid-cols-3 gap-3">
            <div>
              <p className="text-[10px] text-muted-foreground/40">Equity</p>
              <p className="text-sm font-bold tabular-nums">{formatCurrency(alpacaEquity)}</p>
            </div>
            <div>
              <p className="text-[10px] text-muted-foreground/40">Day P&L</p>
              <p className={`text-sm font-bold tabular-nums ${pnlColor(alpacaDailyPnl)}`}>
                {alpacaDailyPnl >= 0 ? "+" : ""}{formatCurrency(alpacaDailyPnl)}
              </p>
            </div>
            <div>
              <p className="text-[10px] text-muted-foreground/40">Positions</p>
              <p className="text-sm font-bold">{stockPositions.length} stk · {optionPositions.length} opt</p>
            </div>
          </div>
        </div>

        <div className="rounded-xl border border-amber-500/15 bg-gradient-to-br from-amber-500/[0.04] to-transparent p-4">
          <div className="flex items-center justify-between mb-2">
            <div className="flex items-center gap-2">
              <span className="w-2 h-2 rounded-full bg-amber-400" />
              <span className="text-xs font-bold">Tradovate</span>
              <span className="text-[10px] text-muted-foreground/40">Micro Futures</span>
              {futures?.engineStatus?.alive && (
                <span className="relative flex h-1.5 w-1.5 ml-1">
                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-blue-400 opacity-75" />
                  <span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-blue-400" />
                </span>
              )}
            </div>
            <Link href="/futures" className="text-[10px] text-amber-400 hover:underline">View</Link>
          </div>
          <div className="grid grid-cols-3 gap-3">
            <div>
              <p className="text-[10px] text-muted-foreground/40">Net Liq</p>
              <p className="text-sm font-bold tabular-nums">{formatCurrency(futuresEquity)}</p>
            </div>
            <div>
              <p className="text-[10px] text-muted-foreground/40">Day P&L</p>
              <p className={`text-sm font-bold tabular-nums ${pnlColor(futuresDailyPnl)}`}>
                {futuresDailyPnl >= 0 ? "+" : ""}{formatCurrency(futuresDailyPnl)}
              </p>
            </div>
            <div>
              <p className="text-[10px] text-muted-foreground/40">Margin</p>
              <p className={`text-sm font-bold tabular-nums ${marginUtilization > 50 ? "text-red-400" : marginUtilization > 25 ? "text-amber-400" : ""}`}>
                {marginUtilization.toFixed(0)}% used
              </p>
            </div>
          </div>
        </div>
      </div>

      {/* ── Portfolio Allocation + Risk ── */}
      <div className="grid grid-cols-1 md:grid-cols-[1fr_320px] gap-3">
        {/* Allocation */}
        <div className="rounded-xl border border-white/[0.06] bg-white/[0.02] p-4">
          <p className="text-[10px] text-muted-foreground/50 uppercase tracking-wider font-medium mb-3">Portfolio Allocation</p>
          {allocSegments.length > 0 ? (
            <AllocationBar segments={allocSegments} />
          ) : (
            <p className="text-[11px] text-muted-foreground/30">No positions to display</p>
          )}
        </div>

        {/* Risk panel */}
        <div className="rounded-xl border border-white/[0.06] bg-white/[0.02] p-4">
          <p className="text-[10px] text-muted-foreground/50 uppercase tracking-wider font-medium mb-3">Risk Overview</p>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <p className="text-[10px] text-muted-foreground/40">Leverage</p>
              <p className={`text-lg font-bold tabular-nums ${leverageRatio > 2 ? "text-red-400" : leverageRatio > 1 ? "text-amber-400" : "text-emerald-400"}`}>
                {leverageRatio.toFixed(2)}x
              </p>
            </div>
            <div>
              <p className="text-[10px] text-muted-foreground/40">Buying Power</p>
              <p className="text-lg font-bold tabular-nums">{formatCurrency(alpacaBuyingPower)}</p>
            </div>
            <div>
              <p className="text-[10px] text-muted-foreground/40">Exposure</p>
              <p className="text-sm font-bold tabular-nums">{formatCurrency(totalExposure)}</p>
            </div>
            <div>
              <p className="text-[10px] text-muted-foreground/40">Max Position</p>
              <p className="text-sm font-bold tabular-nums">
                {(() => {
                  const allValues = [
                    ...stockPositions.map(p => Math.abs(parseFloat(p.market_value))),
                    ...(futures?.positions?.map(p => p.currentPrice * p.multiplier * p.quantity) || []),
                  ];
                  if (allValues.length === 0) return "—";
                  const maxVal = Math.max(...allValues);
                  return combinedEquity > 0 ? `${((maxVal / combinedEquity) * 100).toFixed(0)}%` : "—";
                })()}
              </p>
            </div>
          </div>
        </div>
      </div>

      {/* ── Market Regime ── */}
      {regime && (
        <div className={`rounded-xl border p-4 ${
          regime.regime === "bull" ? "border-emerald-500/20 bg-gradient-to-r from-emerald-500/[0.05] to-transparent" :
          regime.regime === "bear" ? "border-red-500/20 bg-gradient-to-r from-red-500/[0.05] to-transparent" :
          "border-amber-500/20 bg-gradient-to-r from-amber-500/[0.05] to-transparent"
        }`}>
          <div className="flex items-center gap-3 mb-1.5">
            <span className={`text-[10px] px-2 py-0.5 rounded-full font-black tracking-wider ${
              regime.regime === "bull" ? "bg-emerald-500/20 text-emerald-400" :
              regime.regime === "bear" ? "bg-red-500/20 text-red-400" :
              "bg-amber-500/20 text-amber-400"
            }`}>
              {regime.regime.toUpperCase()}
            </span>
            <span className="text-[11px] text-muted-foreground/60">
              SPY {(regime.spy1mReturn * 100).toFixed(1)}% · VIX {regime.volatility.toFixed(0)} · Size {regime.positionSizeMultiplier.toFixed(1)}x
            </span>
          </div>
          <p className="text-xs text-muted-foreground/60">{regime.recommendation}</p>
        </div>
      )}

      {/* ── Micro Futures Ticker Strip ── */}
      <div className="rounded-xl border border-white/[0.06] bg-white/[0.02] overflow-hidden">
        <div className="flex items-center justify-between px-4 py-2.5 border-b border-white/[0.06]">
          <p className="text-[10px] font-bold text-muted-foreground/50 uppercase tracking-wider">Micro Futures</p>
          <Link href="/futures" className="text-[10px] text-emerald-400 hover:underline">Open</Link>
        </div>
        <div className="grid grid-cols-5 divide-x divide-white/[0.04]">
          {["MES", "MNQ", "MGC", "MYM", "M2K"].map((sym) => {
            const q = futuresQuotes.find((x) => x.symbol === sym);
            if (!q) return (
              <div key={sym} className="px-3 py-2.5 text-center">
                <span className="text-[10px] font-bold text-muted-foreground/30">{sym}</span>
                <div className="skeleton h-4 w-12 mx-auto mt-1 rounded" />
              </div>
            );
            const isUp = q.change >= 0;
            return (
              <div key={sym} className="px-3 py-2.5 text-center group hover:bg-white/[0.02] transition-colors">
                <div className="flex items-center justify-center gap-1.5 mb-0.5">
                  <span className="text-[10px] font-bold">{sym}</span>
                  <span className={`text-[9px] font-black px-1 py-px rounded ${
                    isUp ? "bg-emerald-500/15 text-emerald-400" : "bg-red-500/15 text-red-400"
                  }`}>
                    {isUp ? "+" : ""}{q.changePercent.toFixed(2)}%
                  </span>
                </div>
                <p className={`text-sm font-bold tabular-nums ${isUp ? "text-emerald-400" : "text-red-400"}`}>
                  {q.price.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                </p>
              </div>
            );
          })}
        </div>
      </div>

      {/* ── Positions + Activity ── */}
      <div className="grid grid-cols-1 xl:grid-cols-[1fr_320px] gap-3">
        {/* All Open Positions */}
        <div className="rounded-xl border border-white/[0.06] bg-white/[0.02] overflow-hidden">
          <div className="flex items-center justify-between px-4 py-3 border-b border-white/[0.06]">
            <div className="flex items-center gap-2">
              <p className="text-xs font-medium">Open Positions</p>
              <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-white/[0.06] text-muted-foreground/60 tabular-nums">{totalPositions}</span>
            </div>
            <div className="flex gap-3">
              <Link href="/stocks" className="text-[10px] text-blue-400 hover:underline">Stocks</Link>
              <Link href="/options" className="text-[10px] text-purple-400 hover:underline">Options</Link>
              <Link href="/futures" className="text-[10px] text-amber-400 hover:underline">Futures</Link>
            </div>
          </div>

          {isLoading ? (
            <div className="divide-y divide-white/[0.04]">
              {Array.from({ length: 3 }).map((_, i) => (
                <div key={i} className="flex items-center justify-between px-4 py-3">
                  <div className="flex items-center gap-3">
                    <div className="skeleton h-4 w-12 rounded" />
                    <div className="skeleton h-3 w-8 rounded" />
                    <div className="skeleton h-3 w-16 rounded" />
                  </div>
                  <div className="flex items-center gap-4">
                    <div className="skeleton h-3 w-16 rounded" />
                    <div className="skeleton h-3 w-14 rounded" />
                  </div>
                </div>
              ))}
            </div>
          ) : totalPositions > 0 ? (
            <div className="divide-y divide-white/[0.04]">
              {/* Stock positions */}
              {stockPositions.map((pos) => {
                const pl = parseFloat(pos.unrealized_pl);
                const plPct = parseFloat(pos.unrealized_plpc) * 100;
                return (
                  <div key={pos.symbol} className="flex items-center justify-between px-4 py-2.5 hover:bg-white/[0.02] transition-colors">
                    <div className="flex items-center gap-2.5">
                      <Link href={`/research/${pos.symbol}`} className="font-bold text-sm hover:text-emerald-400 transition-colors w-12">{pos.symbol}</Link>
                      <span className="px-1.5 py-0.5 rounded text-[9px] bg-blue-500/15 text-blue-400 font-bold">STK</span>
                      <span className="text-[11px] text-muted-foreground/40">{pos.qty} sh</span>
                    </div>
                    <div className="flex items-center gap-3">
                      <PositionWeight value={parseFloat(pos.market_value)} total={combinedEquity} />
                      <span className="text-[11px] text-muted-foreground/50 tabular-nums w-16 text-right">{formatCurrency(pos.current_price)}</span>
                      <span className={`text-[11px] font-bold tabular-nums w-16 text-right ${pnlColor(pl)}`}>
                        {pl >= 0 ? "+" : ""}{formatCurrency(pl)}
                      </span>
                      <span className={`text-[10px] tabular-nums w-12 text-right ${pnlColor(plPct)}`}>
                        {plPct >= 0 ? "+" : ""}{plPct.toFixed(1)}%
                      </span>
                    </div>
                  </div>
                );
              })}

              {/* Options positions */}
              {optionPositions.map((pos) => {
                const opt = parseOptionSymbol(pos.symbol);
                const pl = parseFloat(pos.unrealized_pl);
                const plPct = parseFloat(pos.unrealized_plpc) * 100;
                return (
                  <div key={pos.symbol} className="flex items-center justify-between px-4 py-2.5 hover:bg-white/[0.02] transition-colors">
                    <div className="flex items-center gap-2.5">
                      <Link href={`/research/${opt?.underlying || pos.symbol}`} className="font-bold text-sm hover:text-emerald-400 transition-colors w-12">
                        {opt?.underlying || pos.symbol}
                      </Link>
                      <span className={`px-1.5 py-0.5 rounded text-[9px] font-bold ${
                        opt?.type === "CALL" ? "bg-emerald-500/15 text-emerald-400" : "bg-red-500/15 text-red-400"
                      }`}>{opt?.type || "OPT"}</span>
                      <span className="text-[11px] text-muted-foreground/40">${opt?.strike} {opt?.expiry} ({opt?.dte}d)</span>
                    </div>
                    <div className="flex items-center gap-3">
                      <PositionWeight value={parseFloat(pos.market_value)} total={combinedEquity} />
                      <span className="text-[11px] text-muted-foreground/50 tabular-nums w-16 text-right">${parseFloat(pos.current_price).toFixed(2)}</span>
                      <span className={`text-[11px] font-bold tabular-nums w-16 text-right ${pnlColor(pl)}`}>
                        {pl >= 0 ? "+" : ""}{formatCurrency(pl)}
                      </span>
                      <span className={`text-[10px] tabular-nums w-12 text-right ${pnlColor(plPct)}`}>
                        {plPct >= 0 ? "+" : ""}{plPct.toFixed(1)}%
                      </span>
                    </div>
                  </div>
                );
              })}

              {/* Futures positions */}
              {futures?.positions?.map((pos, i) => (
                <div key={`fut-${i}`} className="flex items-center justify-between px-4 py-2.5 hover:bg-white/[0.02] transition-colors">
                  <div className="flex items-center gap-2.5">
                    <Link href="/futures" className="font-bold text-sm hover:text-emerald-400 transition-colors w-12">{pos.symbol}</Link>
                    <span className="px-1.5 py-0.5 rounded text-[9px] bg-amber-500/15 text-amber-400 font-bold">FUT</span>
                    <span className={`text-[9px] px-1 py-0.5 rounded font-bold ${
                      pos.direction === "long" ? "bg-emerald-500/15 text-emerald-400" : "bg-red-500/15 text-red-400"
                    }`}>{pos.direction.toUpperCase()} {pos.quantity}x</span>
                  </div>
                  <div className="flex items-center gap-3">
                    <PositionWeight value={pos.currentPrice * pos.multiplier * pos.quantity} total={combinedEquity} />
                    <span className="text-[11px] text-muted-foreground/50 tabular-nums w-16 text-right">${pos.currentPrice.toLocaleString()}</span>
                    <span className={`text-[11px] font-bold tabular-nums w-16 text-right ${pos.unrealizedPnl >= 0 ? "text-emerald-500" : "text-red-500"}`}>
                      {pos.unrealizedPnl >= 0 ? "+" : ""}${pos.unrealizedPnl.toFixed(0)}
                    </span>
                    {pos.stopLoss && pos.target ? (
                      <span className="text-[10px] tabular-nums w-12 text-right text-muted-foreground/40">
                        {pos.pctToTarget != null ? `${pos.pctToTarget > 0 ? "+" : ""}${pos.pctToTarget.toFixed(1)}%` : "—"}
                      </span>
                    ) : <span className="w-12" />}
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="px-4 py-10 text-center">
              <p className="text-sm text-muted-foreground/40">No open positions</p>
              <p className="text-[11px] text-muted-foreground/25 mt-1">Positions from Alpaca and Tradovate will appear here</p>
            </div>
          )}
        </div>

      {/* Daily Futures Performance */}
      {futures?.fillBasedPnl && futures.fillBasedPnl.roundTrips.length > 0 && (() => {
        // Group round trips by exit date
        const dailyStats: Record<string, { trades: number; wins: number; losses: number; totalPnl: number }> = {};
        for (const rt of futures.fillBasedPnl.roundTrips) {
          const date = rt.exitTime.slice(0, 10);
          if (!dailyStats[date]) dailyStats[date] = { trades: 0, wins: 0, losses: 0, totalPnl: 0 };
          dailyStats[date].trades++;
          if (rt.pnl > 0) dailyStats[date].wins++;
          else dailyStats[date].losses++;
          dailyStats[date].totalPnl += rt.pnl;
        }
        const days = Object.entries(dailyStats)
          .sort(([a], [b]) => b.localeCompare(a)); // newest first

        return (
          <div className="rounded-xl border border-white/[0.06] bg-white/[0.02] overflow-hidden">
            <div className="flex items-center justify-between px-4 py-3 border-b border-white/[0.06]">
              <p className="text-xs font-medium">Daily Futures Performance</p>
              <span className="text-[10px] text-muted-foreground/50">
                {futures.fillBasedPnl.tradeCount} total trades &middot; {futures.fillBasedPnl.wins}W / {futures.fillBasedPnl.losses}L
              </span>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b border-white/[0.06] text-muted-foreground/50">
                    <th className="text-left px-4 py-2 font-medium">Date</th>
                    <th className="text-center px-2 py-2 font-medium">Trades</th>
                    <th className="text-center px-2 py-2 font-medium">Wins</th>
                    <th className="text-center px-2 py-2 font-medium">Losses</th>
                    <th className="text-center px-2 py-2 font-medium">Win Rate</th>
                    <th className="text-right px-2 py-2 font-medium">Total P&L</th>
                    <th className="text-right px-4 py-2 font-medium">Avg P&L</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-white/[0.04]">
                  {days.map(([date, stats]) => {
                    const winRate = stats.trades > 0 ? (stats.wins / stats.trades * 100) : 0;
                    const avgPnl = stats.trades > 0 ? stats.totalPnl / stats.trades : 0;
                    return (
                      <tr key={date} className="hover:bg-white/[0.02] transition-colors">
                        <td className="px-4 py-2 font-medium">{date}</td>
                        <td className="text-center px-2 py-2">{stats.trades}</td>
                        <td className="text-center px-2 py-2 text-emerald-400">{stats.wins}</td>
                        <td className="text-center px-2 py-2 text-red-400">{stats.losses}</td>
                        <td className="text-center px-2 py-2">
                          <span className={winRate >= 50 ? "text-emerald-400" : "text-red-400"}>
                            {winRate.toFixed(0)}%
                          </span>
                        </td>
                        <td className={`text-right px-2 py-2 font-medium ${pnlColor(stats.totalPnl)}`}>
                          {stats.totalPnl >= 0 ? "+" : ""}{formatCurrency(stats.totalPnl)}
                        </td>
                        <td className={`text-right px-4 py-2 ${pnlColor(avgPnl)}`}>
                          {avgPnl >= 0 ? "+" : ""}{formatCurrency(avgPnl)}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        );
      })()}

        {/* Recent Activity Feed */}
        <div className="rounded-xl border border-white/[0.06] bg-white/[0.02] overflow-hidden">
          <div className="px-4 py-3 border-b border-white/[0.06]">
            <p className="text-xs font-medium">Recent Activity</p>
          </div>
          {recentActivity.length > 0 ? (
            <div className="divide-y divide-white/[0.04]">
              {recentActivity.map((item) => (
                <div key={item.id} className="px-4 py-2 hover:bg-white/[0.02] transition-colors">
                  <div className="flex items-center justify-between mb-0.5">
                    <div className="flex items-center gap-2">
                      <span className={`w-1.5 h-1.5 rounded-full ${
                        item.action.includes("long") ? "bg-emerald-500" :
                        item.action.includes("short") ? "bg-red-500" :
                        item.pnl != null && item.pnl > 0 ? "bg-emerald-500" :
                        item.pnl != null && item.pnl < 0 ? "bg-red-500" :
                        "bg-white/20"
                      }`} />
                      <span className="text-[11px] font-bold">{item.symbol}</span>
                      <span className={`text-[9px] px-1 py-0.5 rounded font-bold ${
                        item.source === "futures" ? "bg-amber-500/10 text-amber-400" : "bg-blue-500/10 text-blue-400"
                      }`}>{item.action.toUpperCase()}</span>
                    </div>
                    {item.pnl != null && (
                      <span className={`text-[11px] font-bold tabular-nums ${pnlColor(item.pnl)}`}>
                        {item.pnl >= 0 ? "+" : ""}${item.pnl.toFixed(0)}
                      </span>
                    )}
                  </div>
                  <p className="text-[9px] text-muted-foreground/30 tabular-nums">
                    {new Date(item.time).toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", timeZone: "America/New_York" })}
                  </p>
                </div>
              ))}
            </div>
          ) : (
            <div className="px-4 py-8 text-center">
              <p className="text-[11px] text-muted-foreground/30">No recent activity</p>
            </div>
          )}
          <div className="px-4 py-2 border-t border-white/[0.06]">
            <Link href="/journal" className="text-[10px] text-emerald-400 hover:underline">View Full Journal</Link>
          </div>
        </div>
      </div>
    </div>
  );
}
