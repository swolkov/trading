"use client";

import { useAccount } from "@/hooks/use-account";
import { formatCurrency, pnlColor } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";

export function TopBar() {
  const { data: account, error, isLoading } = useAccount();

  if (isLoading) {
    return (
      <header className="h-14 border-b bg-card flex items-center px-6">
        <span className="text-sm text-muted-foreground">Loading account...</span>
      </header>
    );
  }

  if (error || !account) {
    return (
      <header className="h-14 border-b bg-card flex items-center px-6">
        <span className="text-sm text-red-500">
          Failed to load account. Check your Alpaca API keys in .env
        </span>
      </header>
    );
  }

  const equity = parseFloat(account.equity);
  const lastEquity = parseFloat(account.last_equity);
  const dailyPnl = equity - lastEquity;
  const dailyPnlPct = lastEquity > 0 ? dailyPnl / lastEquity : 0;

  return (
    <header className="h-14 border-b bg-card flex items-center px-6 gap-6">
      <div className="flex items-center gap-2">
        <span className="text-sm text-muted-foreground">Equity</span>
        <span className="text-sm font-semibold">{formatCurrency(equity)}</span>
      </div>
      <div className="flex items-center gap-2">
        <span className="text-sm text-muted-foreground">Cash</span>
        <span className="text-sm font-semibold">
          {formatCurrency(account.cash)}
        </span>
      </div>
      <div className="flex items-center gap-2">
        <span className="text-sm text-muted-foreground">Buying Power</span>
        <span className="text-sm font-semibold">
          {formatCurrency(account.buying_power)}
        </span>
      </div>
      <div className="flex items-center gap-2">
        <span className="text-sm text-muted-foreground">Daily P&L</span>
        <span className={`text-sm font-semibold ${pnlColor(dailyPnl)}`}>
          {dailyPnl >= 0 ? "+" : ""}
          {formatCurrency(dailyPnl)} ({dailyPnlPct >= 0 ? "+" : ""}
          {(dailyPnlPct * 100).toFixed(2)}%)
        </span>
      </div>
      <div className="ml-auto">
        <Badge variant="secondary">
          {account.pattern_day_trader ? "PDT" : "Paper"}
        </Badge>
      </div>
    </header>
  );
}
