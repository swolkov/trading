"use client";

import Link from "next/link";
import { useAccount } from "@/hooks/use-account";
import { usePositions } from "@/hooks/use-positions";
import { formatCurrency, pnlColor } from "@/lib/utils";
import { useEffect, useState, useMemo } from "react";
import useSWR from "swr";

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
  const { data: modeData } = useSWR<{ modes: Record<string, string> }>("/api/trading-mode", (u: string) => fetch(u).then((r) => r.json()), { refreshInterval: 10000 });
  const viewMode = modeData?.modes?.futures || "paper";

  useEffect(() => {
    fetch("/api/regime").then((r) => r.json()).then((d) => { if (!d.error) setRegime(d); }).catch(() => {});
    fetch("/api/futures/quotes").then((r) => r.json()).then((d) => { if (Array.isArray(d)) setFuturesQuotes(d); }).catch(() => {});

    const quotesInterval = setInterval(() => {
      fetch("/api/futures/quotes").then((r) => r.json()).then((d) => { if (Array.isArray(d)) setFuturesQuotes(d); }).catch(() => {});
    }, 15000);

    return () => { clearInterval(quotesInterval); };
  }, []);

  // Re-fetch futures data when view mode changes (LIVE ↔ DEMO)
  useEffect(() => {
    setFutures(null);
    fetch("/api/futures/positions").then((r) => r.json()).then((d) => { if (!d.error) setFutures(d); }).catch(() => {});

    const futuresInterval = setInterval(() => {
      fetch("/api/futures/positions").then((r) => r.json()).then((d) => { if (!d.error) setFutures(d); }).catch(() => {});
    }, 10000);

    return () => { clearInterval(futuresInterval); };
  }, [viewMode]);

  // ── Futures metrics (primary — Tradovate) ──
  const futuresEquity = futures?.account?.netLiq || 0;
  const futuresBalance = futures?.account?.balance || 0;
  const futuresSOD = futures?.startOfDayBalance;
  // Daily P&L = balance - start-of-day balance (source of truth)
  // If no SOD snapshot exists, show today's realizedPnl ONLY if it's reasonable
  // (Tradovate sometimes returns cumulative values, not just today's)
  const futuresDailyPnl = (futuresSOD != null && futuresBalance)
    ? futuresBalance - futuresSOD
    : 0;
  const futuresUnrealized = futures?.account?.unrealizedPnl || 0;
  const futuresMargin = futures?.account?.marginUsed || 0;

  // ── Portfolio metrics (futures-only for now) ──
  const combinedEquity = futuresEquity;
  const combinedDailyPnl = futuresDailyPnl;
  const combinedDailyPct = (futuresSOD || futuresBalance) > 0
    ? combinedDailyPnl / (futuresSOD || futuresBalance || 1)
    : 0;
  const combinedUnrealized = futuresUnrealized;
  const totalPositions = futures?.positions?.length || 0;

  // ── Alpaca (stocks & crypto) ──
  const alpacaEquity = account ? parseFloat(account.equity) : 0;
  const stockPositions = useMemo(() => positions?.filter((p) => !parseOptionSymbol(p.symbol) && p.asset_class !== "crypto") || [], [positions]);
  const optionPositions = useMemo(() => positions?.filter((p) => !!parseOptionSymbol(p.symbol)) || [], [positions]);

  // ── Risk / Allocation ──
  const marginUtilization = futuresEquity > 0 ? (futuresMargin / futuresEquity) * 100 : 0;
  const freeCash = Math.max(0, futuresBalance - futuresMargin);
  const cashPct = combinedEquity > 0 ? (freeCash / combinedEquity) * 100 : 100;


  // Loading state
  const isLoading = accountLoading || positionsLoading;

  return (
    <div className="space-y-5">
      {/* ── Header ── */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-xl font-bold tracking-tight">Dashboard</h2>
          <p className="text-[11px] text-muted-foreground/50">
            Multi-asset portfolio — Tradovate & Alpaca
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
            <span className={`w-1.5 h-1.5 rounded-full ${viewMode === "live" ? "bg-red-400 animate-pulse" : "bg-emerald-400"} live-dot`} />
            <span className={`text-[10px] ${viewMode === "live" ? "text-red-400/60" : "text-muted-foreground/40"}`}>
              {viewMode === "live" ? "Live Account" : "Demo Account"}
            </span>
          </div>
        </div>
      </div>

      {/* ── Hero Metrics ── */}
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
            <div className="rounded-xl border border-white/[0.10] bg-gradient-to-br from-white/[0.05] to-white/[0.02] p-4 shadow-sm">
              <p className="text-[10px] text-muted-foreground/60 uppercase tracking-wider font-bold">Total Equity</p>
              <p className="text-3xl font-black mt-1 tabular-nums tracking-tight">{formatCurrency(combinedEquity)}</p>
              <p className="text-[11px] mt-0.5 text-muted-foreground/40">{totalPositions} position{totalPositions !== 1 ? "s" : ""}</p>
            </div>
            <div className={`rounded-xl border p-4 ${
              combinedDailyPnl >= 0
                ? "border-emerald-500/20 bg-gradient-to-br from-emerald-500/[0.04] to-transparent"
                : "border-red-500/20 bg-gradient-to-br from-red-500/[0.04] to-transparent"
            }`}>
              <p className="text-[10px] text-muted-foreground/50 uppercase tracking-wider font-medium">Daily P&L</p>
              <p className={`text-2xl font-black mt-1 tabular-nums ${pnlColor(combinedDailyPnl)}`}>
                {combinedDailyPnl >= 0 ? "+" : ""}{formatCurrency(combinedDailyPnl)}
              </p>
              <p className={`text-[11px] mt-0.5 tabular-nums ${pnlColor(combinedDailyPct)}`}>
                {combinedDailyPct >= 0 ? "+" : ""}{(combinedDailyPct * 100).toFixed(2)}%
              </p>
            </div>
            <div className={`rounded-xl border p-4 ${
              combinedUnrealized >= 0
                ? "border-emerald-500/10 bg-gradient-to-br from-emerald-500/[0.02] to-transparent"
                : "border-red-500/10 bg-gradient-to-br from-red-500/[0.02] to-transparent"
            }`}>
              <p className="text-[10px] text-muted-foreground/50 uppercase tracking-wider font-medium">Unrealized</p>
              <p className={`text-2xl font-black mt-1 tabular-nums ${pnlColor(combinedUnrealized)}`}>
                {combinedUnrealized >= 0 ? "+" : ""}{formatCurrency(combinedUnrealized)}
              </p>
              <p className="text-[11px] mt-0.5 text-muted-foreground/50">
                {totalPositions} open
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

      {/* ── Broker Accounts ── */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        {/* Tradovate */}
        <div className="rounded-xl border border-amber-500/15 bg-gradient-to-br from-amber-500/[0.04] to-transparent p-4">
          <div className="flex items-center justify-between mb-2">
            <div className="flex items-center gap-2">
              <span className="w-2 h-2 rounded-full bg-amber-400" />
              <span className="text-xs font-bold">Tradovate</span>
              <span className="text-[10px] text-muted-foreground/40">Futures</span>
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

        {/* Alpaca */}
        <div className="rounded-xl border border-blue-500/15 bg-gradient-to-br from-blue-500/[0.04] to-transparent p-4">
          <div className="flex items-center justify-between mb-2">
            <div className="flex items-center gap-2">
              <span className="w-2 h-2 rounded-full bg-blue-400" />
              <span className="text-xs font-bold">Alpaca</span>
              <span className="text-[10px] text-muted-foreground/40">Options & Long-term</span>
            </div>
            <div className="flex gap-2">
              <Link href="/options" className="text-[10px] text-blue-400 hover:underline">Options</Link>
            </div>
          </div>
          <div className="grid grid-cols-3 gap-3">
            <div>
              <p className="text-[10px] text-muted-foreground/40">Equity</p>
              <p className="text-sm font-bold tabular-nums">{formatCurrency(alpacaEquity)}</p>
            </div>
            <div>
              <p className="text-[10px] text-muted-foreground/40">Positions</p>
              <p className="text-sm font-bold tabular-nums">{stockPositions.length + optionPositions.length}</p>
            </div>
            <div>
              <p className="text-[10px] text-muted-foreground/40">Buying Power</p>
              <p className="text-sm font-bold tabular-nums">{account ? formatCurrency(parseFloat(account.buying_power)) : "—"}</p>
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
          <p className="text-[10px] font-bold text-muted-foreground/50 uppercase tracking-wider">Futures</p>
          <Link href="/futures" className="text-[10px] text-emerald-400 hover:underline">Open</Link>
        </div>
        <div className={`grid ${viewMode === "live" ? "grid-cols-2" : "grid-cols-3"} divide-x divide-white/[0.04]`}>
          {(viewMode === "live" ? ["MES", "MNQ"] : ["ES", "NQ", "GC"]).map((sym) => {
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

      {/* ── Open Positions ── */}
      <div>
        <div className="rounded-xl border border-white/[0.06] bg-white/[0.02] overflow-hidden">
          <div className="flex items-center justify-between px-4 py-3 border-b border-white/[0.06]">
            <div className="flex items-center gap-2">
              <p className="text-xs font-medium">Open Positions</p>
              <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-white/[0.06] text-muted-foreground/60 tabular-nums">{totalPositions}</span>
            </div>
            <div className="flex gap-3">
              <Link href="/futures" className="text-[10px] text-amber-400 hover:underline">Futures</Link>
              <Link href="/options" className="text-[10px] text-blue-400 hover:underline">Options</Link>
              <Link href="/kraken" className="text-[10px] text-purple-400 hover:underline">Kraken</Link>
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
              {stockPositions.length > 0 && (
                <div className="flex items-center gap-2 px-4 py-1.5 bg-blue-500/[0.03]">
                  <span className="text-[9px] font-bold text-blue-400 uppercase tracking-wider">Stocks</span>
                  <span className="text-[9px] text-muted-foreground/30">{stockPositions.length}</span>
                  <div className="flex-1 border-t border-blue-500/10" />
                  <Link href="/options" className="text-[9px] text-blue-400/60 hover:text-blue-400">View all</Link>
                </div>
              )}
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
              {optionPositions.length > 0 && (
                <div className="flex items-center gap-2 px-4 py-1.5 bg-purple-500/[0.03]">
                  <span className="text-[9px] font-bold text-purple-400 uppercase tracking-wider">Options</span>
                  <span className="text-[9px] text-muted-foreground/30">{optionPositions.length}</span>
                  <div className="flex-1 border-t border-purple-500/10" />
                  <Link href="/options" className="text-[9px] text-purple-400/60 hover:text-purple-400">View all</Link>
                </div>
              )}
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
              {futures?.positions && futures.positions.length > 0 && (
                <div className="flex items-center gap-2 px-4 py-1.5 bg-amber-500/[0.03]">
                  <span className="text-[9px] font-bold text-amber-400 uppercase tracking-wider">Futures</span>
                  <span className="text-[9px] text-muted-foreground/30">{futures.positions.length}</span>
                  <div className="flex-1 border-t border-amber-500/10" />
                  <Link href="/futures" className="text-[9px] text-amber-400/60 hover:text-amber-400">View all</Link>
                </div>
              )}
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
              <p className="text-[11px] text-muted-foreground/25 mt-1">Positions from Tradovate and Alpaca will appear here when active</p>
            </div>
          )}
        </div>

      </div>
    </div>
  );
}
