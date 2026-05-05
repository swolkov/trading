"use client";

import { useAccount } from "@/hooks/use-account";
import { formatCurrency, pnlColor } from "@/lib/utils";

export function TopBar() {
  const { data: account, error, isLoading } = useAccount();

  if (isLoading) {
    return (
      <header className="h-11 border-b border-border bg-sidebar flex items-center px-5 gap-6">
        <div className="skeleton h-3 w-32" />
        <div className="skeleton h-3 w-24" />
        <div className="skeleton h-3 w-28" />
      </header>
    );
  }

  if (error || !account) {
    return (
      <header className="h-11 border-b border-border bg-sidebar flex items-center px-5">
        <span className="text-[11px] text-destructive">Check Alpaca API keys</span>
      </header>
    );
  }

  const equity = parseFloat(account.equity);
  const lastEquity = parseFloat(account.last_equity);
  const dailyPnl = equity - lastEquity;
  const dailyPnlPct = lastEquity > 0 ? dailyPnl / lastEquity : 0;

  const items = [
    { label: "Equity", value: formatCurrency(equity) },
    { label: "Cash", value: formatCurrency(account.cash) },
    { label: "Buying Power", value: formatCurrency(account.buying_power) },
  ];

  return (
    <header className="h-11 border-b border-border bg-sidebar flex items-center px-5 gap-6">
      {items.map((item) => (
        <div key={item.label} className="flex items-center gap-1.5">
          <span className="text-[10px] text-muted-foreground/50 uppercase tracking-wider font-medium">{item.label}</span>
          <span className="text-[12px] font-semibold tabular-nums">{item.value}</span>
        </div>
      ))}
      <div className="flex items-center gap-1.5">
        <span className="text-[10px] text-muted-foreground/50 uppercase tracking-wider font-medium">Daily P&L</span>
        <span className={`text-[12px] font-bold tabular-nums ${pnlColor(dailyPnl)}`}>
          {dailyPnl >= 0 ? "+" : ""}{formatCurrency(dailyPnl)}
          <span className="text-[10px] font-medium ml-0.5 opacity-70">
            ({dailyPnlPct >= 0 ? "+" : ""}{(dailyPnlPct * 100).toFixed(2)}%)
          </span>
        </span>
      </div>
      <div className="ml-auto flex items-center gap-1.5">
        <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 live-dot" />
        <span className="text-[9px] text-muted-foreground/50 uppercase tracking-wider font-medium">Paper</span>
      </div>
    </header>
  );
}
