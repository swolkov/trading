"use client";

import Link from "next/link";
import { useEffect, useState, useMemo } from "react";
import { formatCurrency, pnlColor } from "@/lib/utils";

// ── Types ──────────────────────────────────────────────

interface AlpacaTrade {
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
}

interface FuturesActivity {
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

interface FuturesData {
  connected: boolean;
  activity: FuturesActivity[];
  account?: { balance: number } | null;
  startOfDayBalance?: number | null;
  balanceHistory?: { date: string; startBalance: number | null; endBalance: number | null }[];
}

interface JournalDay {
  date: string;
  dateLabel: string;
  weekday: string;
  alpacaTrades: AlpacaTrade[];
  futuresTrades: FuturesActivity[];
  totalPnl: number;
  alpacaPnl: number;
  futuresPnl: number;
  tradeCount: number;
  winCount: number;
  lossCount: number;
  alpacaWinCount: number;
  alpacaLossCount: number;
  futuresWinCount: number;
  futuresLossCount: number;
}

function formatET(iso: string) {
  return new Date(iso).toLocaleString("en-US", { hour: "2-digit", minute: "2-digit", timeZone: "America/New_York" });
}

// ── P&L Calendar Heatmap ───────────────────────────────

function PnlCalendar({ days }: { days: JournalDay[] }) {
  const dayMap = useMemo(() => {
    const m: Record<string, JournalDay> = {};
    for (const d of days) m[d.date] = d;
    return m;
  }, [days]);

  // Build 8-week calendar grid ending today
  const today = new Date();
  const weeks: { date: Date; key: string }[][] = [];
  const startDate = new Date(today);
  startDate.setDate(startDate.getDate() - (7 * 8 - 1) - startDate.getDay());

  let currentWeek: { date: Date; key: string }[] = [];
  for (let i = 0; i < 8 * 7; i++) {
    const d = new Date(startDate);
    d.setDate(d.getDate() + i);
    const key = d.toISOString().slice(0, 10);
    currentWeek.push({ date: d, key });
    if (currentWeek.length === 7) {
      weeks.push(currentWeek);
      currentWeek = [];
    }
  }

  // Find max absolute P&L for color scaling
  const allPnls = days.map(d => Math.abs(d.totalPnl)).filter(v => v > 0);
  const maxPnl = allPnls.length > 0 ? Math.max(...allPnls) : 1000;

  function getCellColor(dayData: JournalDay | undefined): string {
    if (!dayData || dayData.tradeCount === 0) return "bg-white/[0.03]";
    const intensity = Math.min(1, Math.abs(dayData.totalPnl) / maxPnl);
    if (dayData.totalPnl > 0) {
      if (intensity > 0.7) return "bg-emerald-500/60";
      if (intensity > 0.4) return "bg-emerald-500/35";
      return "bg-emerald-500/15";
    } else {
      if (intensity > 0.7) return "bg-red-500/60";
      if (intensity > 0.4) return "bg-red-500/35";
      return "bg-red-500/15";
    }
  }

  const dayLabels = ["S", "M", "T", "W", "T", "F", "S"];

  return (
    <div className="space-y-2">
      <div className="flex gap-1">
        {/* Day labels */}
        <div className="flex flex-col gap-1 mr-1">
          {dayLabels.map((label, i) => (
            <div key={i} className="w-3 h-3 flex items-center justify-center text-[7px] text-muted-foreground/30">
              {i % 2 === 1 ? label : ""}
            </div>
          ))}
        </div>
        {/* Weeks */}
        {weeks.map((week, wi) => (
          <div key={wi} className="flex flex-col gap-1">
            {week.map((day) => {
              const dayData = dayMap[day.key];
              const isToday = day.key === today.toISOString().slice(0, 10);
              const isFuture = day.date > today;
              return (
                <div
                  key={day.key}
                  className={`w-3 h-3 rounded-[2px] transition-colors ${
                    isFuture ? "bg-transparent" :
                    isToday ? `ring-1 ring-emerald-400/50 ${getCellColor(dayData)}` :
                    getCellColor(dayData)
                  }`}
                  title={dayData ? `${day.key}: ${dayData.totalPnl >= 0 ? "+" : ""}${formatCurrency(dayData.totalPnl)} (${dayData.tradeCount} trades)` : day.key}
                />
              );
            })}
          </div>
        ))}
      </div>
      {/* Legend */}
      <div className="flex items-center gap-2 text-[9px] text-muted-foreground/40">
        <span>Loss</span>
        <div className="flex gap-0.5">
          <div className="w-2.5 h-2.5 rounded-[2px] bg-red-500/60" />
          <div className="w-2.5 h-2.5 rounded-[2px] bg-red-500/35" />
          <div className="w-2.5 h-2.5 rounded-[2px] bg-red-500/15" />
          <div className="w-2.5 h-2.5 rounded-[2px] bg-white/[0.03]" />
          <div className="w-2.5 h-2.5 rounded-[2px] bg-emerald-500/15" />
          <div className="w-2.5 h-2.5 rounded-[2px] bg-emerald-500/35" />
          <div className="w-2.5 h-2.5 rounded-[2px] bg-emerald-500/60" />
        </div>
        <span>Profit</span>
      </div>
    </div>
  );
}

// ── Cumulative Equity Line ─────────────────────────────

function CumulativePnl({ days }: { days: JournalDay[] }) {
  const sorted = useMemo(() => [...days].sort((a, b) => a.date.localeCompare(b.date)), [days]);
  const points = useMemo(() => {
    let cum = 0;
    return sorted.map(d => { cum += d.totalPnl; return cum; });
  }, [sorted]);

  if (points.length < 2) return null;

  const min = Math.min(...points, 0);
  const max = Math.max(...points, 0);
  const range = max - min || 1;

  return (
    <div className="space-y-1">
      <div className="flex items-end gap-[2px] h-20">
        {points.map((v, i) => {
          const height = ((v - min) / range) * 100;
          return (
            <div
              key={i}
              className={`flex-1 min-w-[3px] rounded-t ${v >= 0 ? "bg-emerald-500/50" : "bg-red-500/50"}`}
              style={{ height: `${Math.max(3, height)}%` }}
              title={`${sorted[i].date}: ${v >= 0 ? "+" : ""}${formatCurrency(v)}`}
            />
          );
        })}
      </div>
      <div className="flex justify-between text-[9px] text-muted-foreground/30">
        <span>{sorted[0]?.date.slice(5)}</span>
        <span className={`font-bold ${pnlColor(points[points.length - 1])}`}>
          {points[points.length - 1] >= 0 ? "+" : ""}{formatCurrency(points[points.length - 1])}
        </span>
        <span>{sorted[sorted.length - 1]?.date.slice(5)}</span>
      </div>
    </div>
  );
}

// ── Main Page ──────────────────────────────────────────

export default function JournalPage() {
  const [alpacaData, setAlpacaData] = useState<{ trades: AlpacaTrade[] } | null>(null);
  const [futuresData, setFuturesData] = useState<FuturesData | null>(null);
  const [selectedDay, setSelectedDay] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<"all" | "stocks" | "futures">("all");
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    Promise.all([
      fetch("/api/trades/analysis").then((r) => r.json()).then((d) => { if (d && !d.error) setAlpacaData(d); }).catch(() => {}),
      fetch("/api/futures/positions").then((r) => r.json()).then((d) => { if (d && !d.error) setFuturesData(d); }).catch(() => {}),
    ]).finally(() => setIsLoading(false));
  }, []);

  // Build journal days
  const journalDays = useMemo(() => {
    const dayMap: Record<string, JournalDay> = {};

    function initDay(dateKey: string): JournalDay {
      const d = new Date(dateKey + "T12:00:00Z");
      return {
        date: dateKey,
        dateLabel: d.toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric", year: "numeric", timeZone: "America/New_York" }),
        weekday: d.toLocaleDateString("en-US", { weekday: "short", timeZone: "America/New_York" }),
        alpacaTrades: [], futuresTrades: [], totalPnl: 0, alpacaPnl: 0, futuresPnl: 0,
        tradeCount: 0, winCount: 0, lossCount: 0,
        alpacaWinCount: 0, alpacaLossCount: 0, futuresWinCount: 0, futuresLossCount: 0,
      };
    }

    for (const t of (alpacaData?.trades || [])) {
      const dateKey = t.openDate.slice(0, 10);
      if (!dayMap[dateKey]) dayMap[dateKey] = initDay(dateKey);
      dayMap[dateKey].alpacaTrades.push(t);
      dayMap[dateKey].tradeCount++;
      if (t.pnl != null) {
        dayMap[dateKey].alpacaPnl += t.pnl;
        dayMap[dateKey].totalPnl += t.pnl;
        if (t.pnl > 0) { dayMap[dateKey].winCount++; dayMap[dateKey].alpacaWinCount++; }
        else if (t.pnl < 0) { dayMap[dateKey].lossCount++; dayMap[dateKey].alpacaLossCount++; }
      }
    }

    // Futures activity: use trades for counts, but P&L from balance history (source of truth)
    // DB trade P&L values are unreliable (double-logging inflates them).
    // Tradovate account balance deltas are the only accurate P&L source.
    // Exclude May 13 2026 — Railway outage prevented trade closure (infrastructure failure)
    const EXCLUDED_DATES = new Set(["2026-05-13"]);
    for (const t of (futuresData?.activity || [])) {
      const dateKey = new Date(t.time).toISOString().slice(0, 10);
      if (EXCLUDED_DATES.has(dateKey)) continue;
      if (!dayMap[dateKey]) dayMap[dateKey] = initDay(dateKey);
      dayMap[dateKey].futuresTrades.push(t);
      dayMap[dateKey].tradeCount++;
      if (t.pnl != null) {
        // Only count wins/losses for display, NOT for P&L total
        if (t.pnl > 0) { dayMap[dateKey].winCount++; dayMap[dateKey].futuresWinCount++; }
        else if (t.pnl < 0) { dayMap[dateKey].lossCount++; dayMap[dateKey].futuresLossCount++; }
      }
    }

    // Override futures daily P&L with Tradovate balance deltas (source of truth)
    const balHist = futuresData?.balanceHistory || [];
    const balByDate: Record<string, { sod?: number; eod?: number }> = {};
    for (const b of balHist) {
      balByDate[b.date] = { sod: b.startBalance ?? undefined, eod: b.endBalance ?? undefined };
    }
    const todayKey = new Date().toISOString().slice(0, 10);
    const sortedBalDates = Object.keys(balByDate).sort();
    const datesWithBalancePnl = new Set<string>();
    for (let i = 0; i < sortedBalDates.length; i++) {
      const date = sortedBalDates[i];
      if (EXCLUDED_DATES.has(date)) continue; // Skip Railway outage days
      const bal = balByDate[date];
      const nextDate = sortedBalDates[i + 1];
      const nextBal = nextDate ? balByDate[nextDate] : null;
      let balancePnl: number | null = null;
      if (bal.eod != null && bal.sod != null) {
        balancePnl = bal.eod - bal.sod;
      } else if (nextBal?.sod != null && bal.sod != null) {
        balancePnl = nextBal.sod - bal.sod;
      }
      if (balancePnl != null) {
        if (!dayMap[date]) dayMap[date] = initDay(date);
        dayMap[date].futuresPnl += balancePnl;
        dayMap[date].totalPnl += balancePnl;
        datesWithBalancePnl.add(date);
      }
    }
    // Today: use live balance delta only if balance history didn't already cover it
    if (!datesWithBalancePnl.has(todayKey) && futuresData?.startOfDayBalance != null && futuresData?.account?.balance != null) {
      const todayFutPnl = futuresData.account.balance - futuresData.startOfDayBalance;
      if (!dayMap[todayKey]) dayMap[todayKey] = initDay(todayKey);
      dayMap[todayKey].futuresPnl += todayFutPnl;
      dayMap[todayKey].totalPnl += todayFutPnl;
    }

    return Object.values(dayMap).sort((a, b) => b.date.localeCompare(a.date));
  }, [alpacaData, futuresData]);

  const filteredDays = useMemo(() => {
    if (viewMode === "all") return journalDays;
    return journalDays
      .filter((d) => viewMode === "stocks" ? d.alpacaTrades.length > 0 : (d.futuresTrades.length > 0 || d.futuresPnl !== 0))
      .map((d) => ({
        ...d,
        totalPnl: viewMode === "stocks" ? d.alpacaPnl : d.futuresPnl,
        tradeCount: viewMode === "stocks" ? d.alpacaTrades.length : d.futuresTrades.length,
        winCount: viewMode === "stocks" ? d.alpacaWinCount : d.futuresWinCount,
        lossCount: viewMode === "stocks" ? d.alpacaLossCount : d.futuresLossCount,
      }));
  }, [journalDays, viewMode]);

  // Stats (safe for empty arrays)
  const totalDays = filteredDays.length;
  const winningDays = filteredDays.filter((d) => d.totalPnl > 0).length;
  const losingDays = filteredDays.filter((d) => d.totalPnl < 0).length;
  const totalPnl = filteredDays.reduce((s, d) => s + d.totalPnl, 0);
  const totalTrades = filteredDays.reduce((s, d) => s + d.tradeCount, 0);
  const bestDay = totalDays > 0 ? filteredDays.reduce((best, d) => d.totalPnl > best.totalPnl ? d : best) : null;
  const worstDay = totalDays > 0 ? filteredDays.reduce((worst, d) => d.totalPnl < worst.totalPnl ? d : worst) : null;

  // Streak
  const currentStreak = useMemo(() => {
    if (filteredDays.length === 0) return { count: 0, type: "none" as const };
    const sorted = [...filteredDays].sort((a, b) => b.date.localeCompare(a.date));
    const firstType = sorted[0].totalPnl >= 0 ? "win" : "loss";
    let count = 0;
    for (const d of sorted) {
      if ((firstType === "win" && d.totalPnl >= 0) || (firstType === "loss" && d.totalPnl < 0)) {
        count++;
      } else break;
    }
    return { count, type: firstType as "win" | "loss" };
  }, [filteredDays]);

  const activeDayData = selectedDay ? filteredDays.find((d) => d.date === selectedDay) : null;

  if (isLoading) {
    return (
      <div className="space-y-5 animate-fade-up">
        <div className="flex items-center justify-between">
          <div>
            <div className="skeleton h-6 w-24 rounded mb-2" />
            <div className="skeleton h-3 w-48 rounded" />
          </div>
        </div>
        <div className="grid grid-cols-2 md:grid-cols-6 gap-3">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="rounded-xl border border-white/[0.06] bg-white/[0.02] p-3">
              <div className="skeleton h-3 w-12 rounded mb-2" />
              <div className="skeleton h-5 w-16 rounded" />
            </div>
          ))}
        </div>
        <div className="skeleton h-40 w-full rounded-xl" />
      </div>
    );
  }

  return (
    <div className="space-y-5 animate-fade-up">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold tracking-tight">Journal</h1>
          <p className="text-[11px] text-muted-foreground/50">Trade journal — all activity across Alpaca + Tradovate</p>
        </div>
        <Link href="/performance" className="text-xs px-3 py-1.5 rounded-lg bg-white/[0.04] text-foreground hover:bg-white/[0.08] transition-colors border border-white/[0.06] font-medium">
          Performance
        </Link>
      </div>

      {/* Broker Filter */}
      <div className="flex gap-1.5">
        {(["all", "stocks", "futures"] as const).map((mode) => {
          const active = viewMode === mode;
          const colors = mode === "all"
            ? (active ? "bg-primary/20 text-primary ring-1 ring-primary/40" : "")
            : mode === "stocks"
            ? (active ? "bg-blue-500/15 text-blue-400 ring-1 ring-blue-500/30" : "")
            : (active ? "bg-amber-500/15 text-amber-400 ring-1 ring-amber-500/30" : "");
          return (
            <button
              key={mode}
              onClick={() => { setViewMode(mode); setSelectedDay(null); }}
              className={`px-3 py-1.5 rounded-full text-xs font-medium transition-all ${
                active ? colors : "bg-white/[0.04] text-muted-foreground hover:bg-white/[0.08]"
              }`}
            >
              {mode === "all" ? "All Brokers" : mode === "stocks" ? "Alpaca" : "Tradovate"}
            </button>
          );
        })}
      </div>

      {/* P&L Calendar Heatmap + Cumulative Line */}
      <div className="grid grid-cols-1 md:grid-cols-[1fr_1fr] gap-3">
        <div className="rounded-xl border border-white/[0.06] bg-white/[0.02] p-4">
          <p className="text-[10px] text-muted-foreground/50 uppercase tracking-wider font-medium mb-3">P&L Heatmap</p>
          <PnlCalendar days={filteredDays} />
        </div>
        <div className="rounded-xl border border-white/[0.06] bg-white/[0.02] p-4">
          <p className="text-[10px] text-muted-foreground/50 uppercase tracking-wider font-medium mb-3">Cumulative P&L</p>
          <CumulativePnl days={filteredDays} />
        </div>
      </div>

      {/* Day List + Detail */}
      <div className="grid grid-cols-1 xl:grid-cols-[380px_1fr] gap-3">
        {/* Day List */}
        <div className="rounded-xl border border-white/[0.06] bg-white/[0.02] overflow-hidden">
          <div className="px-4 py-3 border-b border-white/[0.06]">
            <p className="text-xs font-medium">Trading Days</p>
          </div>
          <div className="max-h-[600px] overflow-y-auto divide-y divide-white/[0.04]">
            {filteredDays.length === 0 ? (
              <div className="px-4 py-10 text-center">
                <p className="text-sm text-muted-foreground/40">No trading activity yet</p>
              </div>
            ) : filteredDays.map((day) => (
              <button
                key={day.date}
                onClick={() => setSelectedDay(day.date === selectedDay ? null : day.date)}
                className={`w-full text-left px-4 py-3 hover:bg-white/[0.03] transition-colors ${
                  selectedDay === day.date ? "bg-white/[0.04] border-l-2 border-l-primary" : ""
                }`}
              >
                <div className="flex items-center justify-between mb-1">
                  <div className="flex items-center gap-2">
                    <span className={`w-1.5 h-1.5 rounded-full ${day.totalPnl > 0 ? "bg-emerald-400" : day.totalPnl < 0 ? "bg-red-400" : "bg-white/20"}`} />
                    <span className="text-xs font-medium">{day.dateLabel}</span>
                  </div>
                  <span className={`text-sm font-black tabular-nums ${pnlColor(day.totalPnl)}`}>
                    {day.totalPnl >= 0 ? "+" : ""}{formatCurrency(day.totalPnl)}
                  </span>
                </div>
                <div className="flex items-center gap-2 text-[10px] text-muted-foreground/40 ml-3.5">
                  <span>{day.tradeCount} trades</span>
                  <span className="text-muted-foreground/20">|</span>
                  <span>{day.winCount}W {day.lossCount}L</span>
                  {day.alpacaTrades.length > 0 && <span className="px-1 py-px rounded bg-blue-500/10 text-blue-400 text-[9px]">ALP</span>}
                  {day.futuresTrades.length > 0 && <span className="px-1 py-px rounded bg-amber-500/10 text-amber-400 text-[9px]">FUT</span>}
                  {day.futuresTrades.some(t => t.action.startsWith("paper_")) && <span className="px-1 py-px rounded bg-violet-500/10 text-violet-400 text-[9px]">PAPER</span>}
                </div>
              </button>
            ))}
          </div>
        </div>

        {/* Day Detail */}
        <div className="space-y-3">
          {activeDayData ? (
            <>
              {/* Day summary */}
              <div className="rounded-xl border border-white/[0.06] bg-white/[0.02] p-4">
                <div className="flex items-center justify-between mb-2">
                  <h3 className="text-sm font-bold">{activeDayData.dateLabel}</h3>
                  <span className={`text-xl font-black tabular-nums ${pnlColor(activeDayData.totalPnl)}`}>
                    {activeDayData.totalPnl >= 0 ? "+" : ""}{formatCurrency(activeDayData.totalPnl)}
                  </span>
                </div>
                <div className="flex gap-4 text-[11px] text-muted-foreground/50">
                  <span>{activeDayData.tradeCount} trades</span>
                  <span>{activeDayData.winCount}W / {activeDayData.lossCount}L</span>
                  <span>WR: {activeDayData.tradeCount > 0 ? ((activeDayData.winCount / Math.max(1, activeDayData.winCount + activeDayData.lossCount)) * 100).toFixed(0) : 0}%</span>
                </div>
              </div>

              {/* Alpaca trades */}
              {activeDayData.alpacaTrades.length > 0 && (
                <div className="rounded-xl border border-blue-500/20 bg-blue-500/[0.02] overflow-hidden">
                  <div className="px-4 py-2.5 border-b border-blue-500/10 flex items-center gap-2">
                    <span className="w-2 h-2 rounded-full bg-blue-400" />
                    <p className="text-xs font-bold text-blue-400">Alpaca ({activeDayData.alpacaTrades.length})</p>
                  </div>
                  <div className="overflow-x-auto">
                    <table className="w-full text-xs">
                      <thead>
                        <tr className="text-muted-foreground/40 border-b border-white/[0.06]">
                          <th className="text-left px-4 py-2 font-medium">Symbol</th>
                          <th className="text-left px-2 py-2 font-medium">Type</th>
                          <th className="text-left px-2 py-2 font-medium">Side</th>
                          <th className="text-right px-2 py-2 font-medium">Qty</th>
                          <th className="text-right px-2 py-2 font-medium">Entry</th>
                          <th className="text-right px-2 py-2 font-medium">Exit</th>
                          <th className="text-right px-2 py-2 font-medium">P&L</th>
                          <th className="text-center px-4 py-2 font-medium">Result</th>
                        </tr>
                      </thead>
                      <tbody>
                        {activeDayData.alpacaTrades.map((t, i) => (
                          <tr key={i} className="border-b border-white/[0.03] hover:bg-white/[0.02]">
                            <td className="px-4 py-2 font-bold">{t.underlying || t.symbol}</td>
                            <td className="px-2 py-2">
                              <span className={`px-1.5 py-0.5 rounded text-[10px] font-bold ${
                                t.type === "CALL" ? "bg-emerald-500/15 text-emerald-400" :
                                t.type === "PUT" ? "bg-red-500/15 text-red-400" :
                                "bg-blue-500/15 text-blue-400"
                              }`}>{t.type}</span>
                            </td>
                            <td className="px-2 py-2">
                              <span className={t.openSide === "buy" ? "text-emerald-400" : "text-red-400"}>
                                {t.openSide.toUpperCase()}
                              </span>
                            </td>
                            <td className="px-2 py-2 text-right tabular-nums">{t.openQty}</td>
                            <td className="px-2 py-2 text-right tabular-nums">${t.openPrice.toFixed(2)}</td>
                            <td className="px-2 py-2 text-right tabular-nums">{t.closePrice ? `$${t.closePrice.toFixed(2)}` : "—"}</td>
                            <td className={`px-2 py-2 text-right font-bold tabular-nums ${t.pnl != null ? pnlColor(t.pnl) : ""}`}>
                              {t.pnl != null ? `${t.pnl >= 0 ? "+" : ""}${formatCurrency(t.pnl)}` : "Open"}
                            </td>
                            <td className="px-4 py-2 text-center">
                              {t.status === "open" ? (
                                <span className="px-2 py-0.5 rounded-full text-[10px] bg-blue-500/15 text-blue-400 font-bold">OPEN</span>
                              ) : t.status === "winner" ? (
                                <span className="px-2 py-0.5 rounded-full text-[10px] bg-emerald-500/15 text-emerald-400 font-bold">WIN</span>
                              ) : (
                                <span className="px-2 py-0.5 rounded-full text-[10px] bg-red-500/15 text-red-400 font-bold">LOSS</span>
                              )}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}

              {/* Futures trades */}
              {activeDayData.futuresTrades.length > 0 && (
                <div className="rounded-xl border border-amber-500/20 bg-amber-500/[0.02] overflow-hidden">
                  <div className="px-4 py-2.5 border-b border-amber-500/10 flex items-center gap-2">
                    <span className="w-2 h-2 rounded-full bg-amber-400" />
                    <p className="text-xs font-bold text-amber-400">Futures ({activeDayData.futuresTrades.length})</p>
                  </div>
                  <div className="overflow-x-auto">
                    <table className="w-full text-xs">
                      <thead>
                        <tr className="text-muted-foreground/40 border-b border-white/[0.06]">
                          <th className="text-left px-4 py-2 font-medium">Time</th>
                          <th className="text-left px-2 py-2 font-medium">Symbol</th>
                          <th className="text-left px-2 py-2 font-medium">Action</th>
                          <th className="text-right px-2 py-2 font-medium">Qty</th>
                          <th className="text-right px-2 py-2 font-medium">Price</th>
                          <th className="text-right px-2 py-2 font-medium">P&L</th>
                          <th className="text-left px-4 py-2 font-medium">Reason</th>
                        </tr>
                      </thead>
                      <tbody>
                        {activeDayData.futuresTrades.map((t) => (
                          <tr key={t.id} className="border-b border-white/[0.03] hover:bg-white/[0.02]">
                            <td className="px-4 py-2 text-muted-foreground/50 tabular-nums whitespace-nowrap">{formatET(t.time)}</td>
                            <td className="px-2 py-2 font-bold">{t.symbol}</td>
                            <td className="px-2 py-2">
                              <span className={`px-1.5 py-0.5 rounded text-[10px] font-bold ${
                                t.action.includes("long") ? "bg-emerald-500/15 text-emerald-400" :
                                t.action.includes("short") ? "bg-red-500/15 text-red-400" :
                                t.action.includes("stop") ? "bg-red-500/15 text-red-400" :
                                t.action.includes("take_profit") ? "bg-emerald-500/15 text-emerald-400" :
                                t.action.includes("close") ? "bg-amber-500/15 text-amber-400" :
                                "bg-white/10 text-muted-foreground"
                              }`}>{t.action.replace("futures_", "").replace("paper_", "").replace(/_/g, " ").toUpperCase()}</span>
                              {t.action.startsWith("paper_") && <span className="ml-1 px-1 py-0.5 rounded text-[9px] font-bold bg-violet-500/15 text-violet-400">PAPER</span>}
                            </td>
                            <td className="px-2 py-2 text-right tabular-nums">{t.qty}</td>
                            <td className="px-2 py-2 text-right tabular-nums">
                              {t.price ? `$${t.price.toLocaleString(undefined, { minimumFractionDigits: 2 })}` : "—"}
                            </td>
                            <td className={`px-2 py-2 text-right font-bold tabular-nums ${t.pnl != null ? pnlColor(t.pnl) : ""}`}>
                              {t.pnl != null ? `${t.pnl >= 0 ? "+" : ""}$${t.pnl.toFixed(0)}` : "—"}
                            </td>
                            <td className="px-4 py-2 text-muted-foreground/50 max-w-[250px]">
                              <span className="block truncate" title={t.reason}>{t.reason?.slice(0, 100)}</span>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
            </>
          ) : (
            <div className="rounded-xl border border-white/[0.06] bg-white/[0.02] p-12 text-center">
              <p className="text-sm text-muted-foreground/40">Select a trading day</p>
              <p className="text-[11px] text-muted-foreground/25 mt-1">Click any day to see detailed trade breakdown</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
