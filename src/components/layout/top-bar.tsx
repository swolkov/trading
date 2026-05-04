"use client";

import { useAccount } from "@/hooks/use-account";
import { formatCurrency, pnlColor } from "@/lib/utils";

export function TopBar() {
  const { data: account, error, isLoading } = useAccount();

  if (isLoading) {
    return (
      <header className="h-12 border-b border-white/[0.06] bg-[oklch(0.13_0.005_260)] flex items-center px-6">
        <div className="h-3 w-48 bg-white/5 animate-pulse rounded" />
      </header>
    );
  }

  if (error || !account) {
    return (
      <header className="h-12 border-b border-white/[0.06] bg-[oklch(0.13_0.005_260)] flex items-center px-6">
        <span className="text-xs text-red-400">
          Failed to load account. Check your Alpaca API keys.
        </span>
      </header>
    );
  }

  const equity = parseFloat(account.equity);
  const lastEquity = parseFloat(account.last_equity);
  const dailyPnl = equity - lastEquity;
  const dailyPnlPct = lastEquity > 0 ? dailyPnl / lastEquity : 0;

  return (
    <header className="h-12 border-b border-white/[0.06] bg-[oklch(0.13_0.005_260)] flex items-center px-6 gap-8">
      <div className="flex items-center gap-1.5">
        <span className="text-[10px] text-muted-foreground/60 uppercase tracking-wider">Equity</span>
        <span className="text-sm font-bold">{formatCurrency(equity)}</span>
      </div>
      <div className="flex items-center gap-1.5">
        <span className="text-[10px] text-muted-foreground/60 uppercase tracking-wider">Cash</span>
        <span className="text-sm font-semibold">{formatCurrency(account.cash)}</span>
      </div>
      <div className="flex items-center gap-1.5">
        <span className="text-[10px] text-muted-foreground/60 uppercase tracking-wider">Buying Power</span>
        <span className="text-sm font-semibold">{formatCurrency(account.buying_power)}</span>
      </div>
      <div className="flex items-center gap-1.5">
        <span className="text-[10px] text-muted-foreground/60 uppercase tracking-wider">Daily P&L</span>
        <span className={`text-sm font-bold ${pnlColor(dailyPnl)}`}>
          {dailyPnl >= 0 ? "+" : ""}
          {formatCurrency(dailyPnl)}
          <span className="text-[10px] ml-1 opacity-70">
            ({dailyPnlPct >= 0 ? "+" : ""}{(dailyPnlPct * 100).toFixed(2)}%)
          </span>
        </span>
      </div>
      <div className="ml-auto">
        <span className="text-[10px] px-2 py-0.5 rounded-full bg-emerald-500/10 text-emerald-400/80 font-medium tracking-wider border border-emerald-500/20">
          PAPER
        </span>
      </div>
    </header>
  );
}
