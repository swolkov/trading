"use client";

import Link from "next/link";
import { formatCurrency, pnlColor } from "@/lib/utils";
import useSWR from "swr";

const fetcher = (u: string) => fetch(u).then((r) => r.json());

interface Holding {
  coin: string;
  amount: number;
  price: number;
  value: number;
  aboveTrend: boolean;
  exitPrice: number | null;
  pctToExit: number | null;
}

interface KrakenStatus {
  connected: boolean;
  enabled: boolean;
  validateOnly: boolean;
  usd: number;
  holdings: Holding[];
  totalValue: number;
  strategyValue: number;
  strategyCapital: number;
  strategyPnl: number;
  otherValue: number;
  error?: string;
}

// Kraken-only dashboard. The old multi-asset version (Tradovate futures equity,
// micro-futures ticker, SPY/VIX regime card) was retired with futures in Aug 2026.
export default function DashboardPage() {
  const { data: krk, isLoading } = useSWR<KrakenStatus>("/api/kraken-agent", fetcher, {
    refreshInterval: 60000,
  });

  const equity = krk?.connected ? krk.totalValue || 0 : 0;
  const cash = krk?.connected ? krk.usd || 0 : 0;
  const cashPct = equity > 0 ? (cash / equity) * 100 : 0;
  const pnl = krk?.strategyPnl ?? 0;
  const pnlPct = (krk?.strategyCapital || 0) > 0 ? pnl / (krk!.strategyCapital || 1) : 0;
  const holdings = krk?.holdings || [];

  return (
    <div className="space-y-5">
      {/* ── Header ── */}
      <div>
        <h2 className="text-xl font-bold tracking-tight">Dashboard</h2>
        <p className="text-[11px] text-muted-foreground/50">Kraken crypto — margin trading</p>
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
              <p className="text-[10px] text-muted-foreground/60 uppercase tracking-wider font-bold">Account Value</p>
              <p className="text-3xl font-black mt-1 tabular-nums tracking-tight">{formatCurrency(equity)}</p>
              <p className="text-[11px] mt-0.5 text-muted-foreground/40">
                {holdings.length} coin{holdings.length !== 1 ? "s" : ""} held
              </p>
            </div>
            <div className={`rounded-xl border p-4 ${
              pnl >= 0
                ? "border-emerald-500/20 bg-gradient-to-br from-emerald-500/[0.04] to-transparent"
                : "border-red-500/20 bg-gradient-to-br from-red-500/[0.04] to-transparent"
            }`}>
              <p className="text-[10px] text-muted-foreground/50 uppercase tracking-wider font-medium">Holdings P&L</p>
              <p className={`text-2xl font-black mt-1 tabular-nums ${pnlColor(pnl)}`}>
                {pnl >= 0 ? "+" : ""}{formatCurrency(pnl)}
              </p>
              <p className={`text-[11px] mt-0.5 tabular-nums ${pnlColor(pnl)}`}>
                {pnlPct >= 0 ? "+" : ""}{(pnlPct * 100).toFixed(1)}% on deposits
              </p>
            </div>
            <div className="rounded-xl border border-white/[0.06] bg-white/[0.02] p-4">
              <p className="text-[10px] text-muted-foreground/50 uppercase tracking-wider font-medium">Cash</p>
              <p className="text-2xl font-black mt-1 tabular-nums">{formatCurrency(cash)}</p>
              <p className="text-[11px] mt-0.5 text-muted-foreground/50">{cashPct.toFixed(0)}% of account</p>
            </div>
            <div className="rounded-xl border border-white/[0.06] bg-white/[0.02] p-4">
              <p className="text-[10px] text-muted-foreground/50 uppercase tracking-wider font-medium">Own Book</p>
              <p className="text-2xl font-black mt-1 tabular-nums">{formatCurrency(krk?.otherValue || 0)}</p>
              <p className="text-[11px] mt-0.5 text-muted-foreground/50">hand-bought, untouched</p>
            </div>
          </>
        )}
      </div>

      {/* ── Quick links ── */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        <Link href="/margin" className="rounded-xl border border-purple-500/20 bg-gradient-to-br from-purple-500/[0.05] to-transparent p-4 hover:border-purple-500/40 transition-colors">
          <p className="text-xs font-bold">Margin Cockpit</p>
          <p className="text-[11px] text-muted-foreground/50 mt-1">Multi-timeframe charts, positions, liquidation distance, break-even math</p>
        </Link>
        <Link href="/margin/paper" className="rounded-xl border border-purple-500/20 bg-gradient-to-br from-purple-500/[0.05] to-transparent p-4 hover:border-purple-500/40 transition-colors">
          <p className="text-xs font-bold">Paper Trades</p>
          <p className="text-[11px] text-muted-foreground/50 mt-1">The shadow experiment — strategy scoreboard + trade log, scored on paper</p>
        </Link>
        <Link href="/orders" className="rounded-xl border border-white/[0.08] bg-white/[0.02] p-4 hover:border-white/[0.16] transition-colors">
          <p className="text-xs font-bold">Orders</p>
          <p className="text-[11px] text-muted-foreground/50 mt-1">Every order the system has placed</p>
        </Link>
      </div>
    </div>
  );
}
