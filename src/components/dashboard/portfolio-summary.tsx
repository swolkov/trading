"use client";

import { useAccount } from "@/hooks/use-account";
import { formatCurrency, pnlColor } from "@/lib/utils";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export function PortfolioSummary() {
  const { data: account, isLoading } = useAccount();

  if (isLoading || !account) {
    return (
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        {[...Array(4)].map((_, i) => (
          <Card key={i}>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium text-muted-foreground">
                Loading...
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="h-7 w-24 bg-muted animate-pulse rounded" />
            </CardContent>
          </Card>
        ))}
      </div>
    );
  }

  const equity = parseFloat(account.equity);
  const lastEquity = parseFloat(account.last_equity);
  const dailyPnl = equity - lastEquity;
  const dailyPnlPct = lastEquity > 0 ? dailyPnl / lastEquity : 0;

  const cards = [
    { label: "Portfolio Value", value: formatCurrency(equity) },
    { label: "Cash", value: formatCurrency(account.cash) },
    { label: "Buying Power", value: formatCurrency(account.buying_power) },
    {
      label: "Daily P&L",
      value: `${dailyPnl >= 0 ? "+" : ""}${formatCurrency(dailyPnl)}`,
      sub: `${dailyPnlPct >= 0 ? "+" : ""}${(dailyPnlPct * 100).toFixed(2)}%`,
      color: pnlColor(dailyPnl),
    },
  ];

  return (
    <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
      {cards.map((card) => (
        <Card key={card.label}>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              {card.label}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className={`text-2xl font-bold ${card.color || ""}`}>
              {card.value}
            </div>
            {card.sub && (
              <p className={`text-xs ${card.color || "text-muted-foreground"}`}>
                {card.sub}
              </p>
            )}
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
