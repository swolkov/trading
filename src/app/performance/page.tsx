"use client";

import { useEffect, useState } from "react";
import useSWR from "swr";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { computeFuturesStats } from "./lib/compute-stats";
import { TrackRecordHeader } from "@/components/futures/track-record-header";

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

function pnl(val: number) {
  return val > 0 ? "text-emerald-400" : val < 0 ? "text-red-400" : "text-muted-foreground";
}

function fmt(val: number) {
  return val >= 0 ? `+$${val.toLocaleString()}` : `-$${Math.abs(val).toLocaleString()}`;
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
  const [futures, setFutures] = useState<FuturesPerfData | null>(null);
  const { data: modeData } = useSWR<{ modes: Record<string, string> }>("/api/trading-mode", swrFetcher, { refreshInterval: 10000 });
  const futuresViewMode = modeData?.modes?.futures || "paper";

  useEffect(() => {
    fetch("/api/trades/analysis").then((r) => r.json()).then(setData).catch(console.error);
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

  return (
    <div className="space-y-6 animate-fade-up">
      <div className="flex items-center gap-3">
        <div>
          <h1 className="text-xl font-bold tracking-tight">Performance</h1>
          <p className="text-[11px] text-muted-foreground/50">Trading analytics — futures (Tradovate)</p>
        </div>
        <span className={`px-2.5 py-1 rounded-full text-[10px] font-bold tracking-wider uppercase ${
          futuresViewMode === "live"
            ? "bg-red-500/15 text-red-400 ring-1 ring-red-500/30"
            : "bg-emerald-500/15 text-emerald-400 ring-1 ring-emerald-500/30"
        }`}>
          {futuresViewMode === "live" ? "LIVE" : "DEMO"}
        </span>
      </div>

      {futuresViewMode === "live" && <TrackRecordHeader />}

      {/* Futures Only */}
      <div className="flex gap-1.5">
        <span className="px-3 py-1.5 rounded-full text-xs font-medium bg-amber-500/15 text-amber-400 ring-1 ring-amber-500/30">
          Futures / Tradovate
        </span>
      </div>

      {(() => {
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
        // Sanity filter: reject entries where balance is outside a plausible range for this account.
        // Guards against cross-contamination (demo $50K values written to live $1K keys, or vice versa).
        const balSanityMin = STARTING_CAPITAL * 0.1;
        const balSanityMax = STARTING_CAPITAL * 20;
        const isSaneBalance = (v: number | null) => v == null || (v >= balSanityMin && v <= balSanityMax);
        const balanceHistory = (futures?.balanceHistory || [])
          .filter((b) => !EXCLUDED_DATES.includes(b.date))
          .filter((b) => isSaneBalance(b.startBalance) && isSaneBalance(b.endBalance));
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
                      <p className="text-[10px] text-muted-foreground/60 uppercase tracking-wider">Total P&L</p>
                      <p className={`text-xl font-bold mt-1 ${pnl(futures.account.balance - (futures.startingCapital ?? 50_000))}`}>{fmt(Math.round(futures.account.balance - (futures.startingCapital ?? 50_000)))}</p>
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

    </div>
  );
}
