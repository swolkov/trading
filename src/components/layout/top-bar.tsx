"use client";

import { useAccount } from "@/hooks/use-account";
import { formatCurrency, pnlColor } from "@/lib/utils";

export function TopBar() {
  const { data: account, error, isLoading } = useAccount();

  if (isLoading) {
    return (
      <header className="h-11 border-b border-border bg-sidebar flex items-center px-3 md:px-5 gap-3 md:gap-6">
        <div className="skeleton h-3 w-24" />
        <div className="skeleton h-3 w-20" />
      </header>
    );
  }

  if (error || !account) {
    return (
      <header className="h-11 border-b border-border bg-sidebar flex items-center px-3 md:px-5">
        <span className="text-[11px] text-destructive ml-10 md:ml-0">Check Alpaca API keys</span>
      </header>
    );
  }

  const equity = parseFloat(account.equity);
  const lastEquity = parseFloat(account.last_equity);
  const dailyPnl = equity - lastEquity;
  const dailyPnlPct = lastEquity > 0 ? dailyPnl / lastEquity : 0;

  return (
    <header className="h-11 border-b border-border bg-sidebar flex items-center px-3 md:px-5 gap-3 md:gap-6 overflow-x-auto">
      {/* Spacer for mobile hamburger */}
      <div className="w-8 md:hidden shrink-0" />

      {/* Desktop: show all items */}
      <div className="hidden md:flex items-center gap-6">
        <div className="flex items-center gap-1.5">
          <span className="text-[10px] text-muted-foreground/50 uppercase tracking-wider font-medium">Equity</span>
          <span className="text-[12px] font-semibold tabular-nums">{formatCurrency(equity)}</span>
        </div>
        <div className="flex items-center gap-1.5">
          <span className="text-[10px] text-muted-foreground/50 uppercase tracking-wider font-medium">Cash</span>
          <span className="text-[12px] font-semibold tabular-nums">{formatCurrency(account.cash)}</span>
        </div>
        <div className="flex items-center gap-1.5">
          <span className="text-[10px] text-muted-foreground/50 uppercase tracking-wider font-medium">Buying Power</span>
          <span className="text-[12px] font-semibold tabular-nums">{formatCurrency(account.buying_power)}</span>
        </div>
      </div>

      {/* Mobile: compact view */}
      <div className="flex md:hidden items-center gap-3">
        <span className="text-[12px] font-bold tabular-nums">{formatCurrency(equity)}</span>
      </div>

      {/* Daily P&L — always visible */}
      <div className="flex items-center gap-1.5 shrink-0">
        <span className="hidden md:inline text-[10px] text-muted-foreground/50 uppercase tracking-wider font-medium">Daily P&L</span>
        <span className={`text-[12px] font-bold tabular-nums ${pnlColor(dailyPnl)}`}>
          {dailyPnl >= 0 ? "+" : ""}{formatCurrency(dailyPnl)}
          <span className="text-[10px] font-medium ml-0.5 opacity-70">
            ({dailyPnlPct >= 0 ? "+" : ""}{(dailyPnlPct * 100).toFixed(2)}%)
          </span>
        </span>
      </div>

      <div className="ml-auto flex items-center gap-1.5 shrink-0">
        <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 live-dot" />
        <span className="text-[9px] text-muted-foreground/50 uppercase tracking-wider font-medium">Paper</span>
      </div>
    </header>
  );
}
