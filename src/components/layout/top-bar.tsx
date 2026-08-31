"use client";

import { formatCurrency, pnlColor } from "@/lib/utils";
import useSWR from "swr";

const fetcher = (url: string) => fetch(url).then((r) => r.json());

interface KrakenStatus {
  connected?: boolean;
  enabled?: boolean;
  validateOnly?: boolean;
  totalValue?: number;
  strategyPnl?: number;
  strategyCapital?: number;
}

// Kraken-only top bar. Futures/Tradovate was retired Aug 2026 — the old bar's
// futures equity, session clock, and demo/live view switcher went with it.
// Crypto trades 24/7, so there is no market-open countdown here.
export function TopBar() {
  const { data: krk, isLoading } = useSWR<KrakenStatus>("/api/kraken-agent", fetcher, {
    refreshInterval: 60000,
  });

  if (isLoading) {
    return (
      <header className="h-11 border-b border-border bg-sidebar flex items-center px-3 md:px-5 gap-3 md:gap-6">
        <div className="w-8 md:hidden shrink-0" />
        <div className="skeleton h-3.5 w-28 rounded" />
        <div className="skeleton h-3 w-20 rounded" />
      </header>
    );
  }

  const equity = krk?.connected ? krk.totalValue || 0 : 0;
  const pnl = krk?.connected ? krk.strategyPnl ?? null : null;
  const pnlPct = pnl != null && (krk?.strategyCapital || 0) > 0
    ? pnl / (krk!.strategyCapital as number)
    : null;
  const armed = Boolean(krk?.connected && krk?.enabled && !krk?.validateOnly);

  return (
    <header className={`h-11 border-b flex items-center transition-colors relative ${
      armed ? "border-red-500/20 bg-red-950/20" : "border-border bg-sidebar"
    }`}>
      <div className="flex items-center gap-2 md:gap-5 px-3 md:px-5 overflow-x-auto flex-1 h-full">
        {/* Spacer for mobile hamburger */}
        <div className="w-8 md:hidden shrink-0" />

        <div className="flex items-center gap-1.5" title="Kraken account value (strategy + own book)">
          <span className="text-[10px] text-muted-foreground/50 uppercase tracking-wider font-medium">Kraken</span>
          <span className="text-[13px] font-bold tabular-nums">{formatCurrency(equity)}</span>
        </div>

        {pnl != null && (
          <>
            <div className="w-px h-4 bg-border hidden md:block" />
            <div className="flex items-center gap-1.5" title="Strategy P&L vs deposited capital (Kraken ledger)">
              <span className="text-[10px] text-muted-foreground/40 uppercase tracking-wider font-medium hidden md:inline">Strategy P&L</span>
              <span className={`text-[12px] font-bold tabular-nums ${pnlColor(pnl)}`}>
                {pnl >= 0 ? "+" : ""}{formatCurrency(pnl)}
              </span>
              {pnlPct != null && (
                <span className={`text-[10px] font-medium tabular-nums opacity-60 ${pnlColor(pnl)}`}>
                  ({pnlPct >= 0 ? "+" : ""}{(pnlPct * 100).toFixed(1)}%)
                </span>
              )}
            </div>
          </>
        )}
      </div>

      {/* Right side: bot arm state */}
      <div className="flex items-center gap-3 shrink-0 pr-3 md:pr-5">
        <span className={`flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[9px] font-bold uppercase tracking-wider ${
          armed
            ? "bg-red-500/15 text-red-400 ring-1 ring-red-500/30"
            : "bg-emerald-500/15 text-emerald-400 ring-1 ring-emerald-500/30"
        }`}>
          <span className={`w-1.5 h-1.5 rounded-full ${armed ? "bg-red-400 animate-pulse" : "bg-emerald-400"}`} />
          {armed ? "Bot Live" : "Validate"}
        </span>
      </div>
    </header>
  );
}
