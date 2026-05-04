"use client";

import { useEffect, useState, useCallback } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useAccount } from "@/hooks/use-account";
import { usePositions } from "@/hooks/use-positions";
import { formatCurrency, formatDate, pnlColor } from "@/lib/utils";

interface PortfolioHistory {
  timestamp: number[];
  equity: number[];
  profit_loss: number[];
  profit_loss_pct: number[];
  base_value: number;
}

interface Activity {
  id: string;
  symbol: string;
  side: string;
  qty: string;
  price: string;
  transaction_time: string;
  net_amount?: string;
}

const PERIODS = [
  { label: "1W", value: "1W" },
  { label: "1M", value: "1M" },
  { label: "3M", value: "3M" },
  { label: "6M", value: "6M" },
  { label: "1Y", value: "1A" },
  { label: "All", value: "all" },
];

export default function AnalyticsPage() {
  const { data: account } = useAccount();
  const { data: positions } = usePositions();
  const [history, setHistory] = useState<PortfolioHistory | null>(null);
  const [activities, setActivities] = useState<Activity[]>([]);
  const [period, setPeriod] = useState("1M");
  const [loadingHistory, setLoadingHistory] = useState(false);

  const loadHistory = useCallback(async (p: string) => {
    setLoadingHistory(true);
    try {
      const res = await fetch(`/api/portfolio-history?period=${p}`);
      const data = await res.json();
      setHistory(data);
    } catch {
      // ignore
    }
    setLoadingHistory(false);
  }, []);

  useEffect(() => {
    loadHistory(period);
    fetch("/api/activities")
      .then((r) => r.json())
      .then((data) => {
        if (Array.isArray(data)) setActivities(data);
      });
  }, [period, loadHistory]);

  // Calculate portfolio stats
  const equity = account ? parseFloat(account.equity) : 0;
  const lastEquity = account ? parseFloat(account.last_equity) : 0;
  const dailyPnl = equity - lastEquity;
  const cash = account ? parseFloat(account.cash) : 0;
  const marketValue = equity - cash;

  // Position-level stats
  const totalUnrealizedPnl =
    positions?.reduce((sum, p) => sum + parseFloat(p.unrealized_pl), 0) || 0;
  const winners =
    positions?.filter((p) => parseFloat(p.unrealized_pl) > 0) || [];
  const losers =
    positions?.filter((p) => parseFloat(p.unrealized_pl) < 0) || [];
  const winRate =
    positions && positions.length > 0
      ? (winners.length / positions.length) * 100
      : 0;

  // History stats
  const totalReturn = history?.profit_loss_pct?.length
    ? history.profit_loss_pct[history.profit_loss_pct.length - 1]
    : 0;
  const maxEquity = history?.equity ? Math.max(...history.equity) : equity;
  const minEquity = history?.equity ? Math.min(...history.equity) : equity;
  const drawdown = maxEquity > 0 ? ((maxEquity - minEquity) / maxEquity) * 100 : 0;

  return (
    <div className="space-y-6">
      <h2 className="text-2xl font-bold tracking-tight">P&L Analytics</h2>

      {/* Summary Cards */}
      <div className="grid grid-cols-1 md:grid-cols-5 gap-4">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm text-muted-foreground">
              Total Equity
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{formatCurrency(equity)}</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm text-muted-foreground">
              Today&apos;s P&L
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className={`text-2xl font-bold ${pnlColor(dailyPnl)}`}>
              {dailyPnl >= 0 ? "+" : ""}
              {formatCurrency(dailyPnl)}
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm text-muted-foreground">
              Unrealized P&L
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div
              className={`text-2xl font-bold ${pnlColor(totalUnrealizedPnl)}`}
            >
              {totalUnrealizedPnl >= 0 ? "+" : ""}
              {formatCurrency(totalUnrealizedPnl)}
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm text-muted-foreground">
              Win Rate
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{winRate.toFixed(0)}%</div>
            <p className="text-xs text-muted-foreground">
              {winners.length}W / {losers.length}L of {positions?.length || 0}
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm text-muted-foreground">
              Max Drawdown
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-red-500">
              {drawdown.toFixed(2)}%
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Portfolio History */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <CardTitle>Portfolio Value Over Time</CardTitle>
            <div className="flex gap-1">
              {PERIODS.map((p) => (
                <button
                  key={p.value}
                  onClick={() => setPeriod(p.value)}
                  className={`px-3 py-1 rounded text-xs font-medium transition-colors ${
                    period === p.value
                      ? "bg-primary text-primary-foreground"
                      : "bg-muted text-muted-foreground hover:bg-accent"
                  }`}
                >
                  {p.label}
                </button>
              ))}
            </div>
          </div>
        </CardHeader>
        <CardContent>
          {loadingHistory ? (
            <div className="h-48 flex items-center justify-center text-muted-foreground">
              Loading history...
            </div>
          ) : history?.timestamp && history.timestamp.length > 0 ? (
            <div className="space-y-4">
              <div className="grid grid-cols-3 gap-4">
                <div>
                  <p className="text-xs text-muted-foreground">Period Return</p>
                  <p
                    className={`text-lg font-semibold ${pnlColor(totalReturn)}`}
                  >
                    {totalReturn >= 0 ? "+" : ""}
                    {(totalReturn * 100).toFixed(2)}%
                  </p>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground">
                    Starting Value
                  </p>
                  <p className="text-lg font-semibold">
                    {formatCurrency(history.base_value)}
                  </p>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground">
                    Current Value
                  </p>
                  <p className="text-lg font-semibold">
                    {formatCurrency(equity)}
                  </p>
                </div>
              </div>

              {/* Simple text-based equity display */}
              <div className="border rounded-md p-4 space-y-1 max-h-64 overflow-auto">
                {history.timestamp.map((ts, i) => (
                  <div key={ts} className="flex justify-between text-xs">
                    <span className="text-muted-foreground">
                      {new Date(ts * 1000).toLocaleDateString()}
                    </span>
                    <span className="font-medium">
                      {formatCurrency(history.equity[i])}
                    </span>
                    <span className={pnlColor(history.profit_loss[i])}>
                      {history.profit_loss[i] >= 0 ? "+" : ""}
                      {formatCurrency(history.profit_loss[i])}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">
              No portfolio history available yet. Place some trades to start
              tracking.
            </p>
          )}
        </CardContent>
      </Card>

      {/* Tabs: Positions P&L + Trade History */}
      <Tabs defaultValue="positions">
        <TabsList>
          <TabsTrigger value="positions">Position P&L</TabsTrigger>
          <TabsTrigger value="trades">Trade History</TabsTrigger>
        </TabsList>

        <TabsContent value="positions">
          <Card>
            <CardContent className="pt-4">
              {positions && positions.length > 0 ? (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Symbol</TableHead>
                      <TableHead className="text-right">Qty</TableHead>
                      <TableHead className="text-right">Avg Entry</TableHead>
                      <TableHead className="text-right">Current</TableHead>
                      <TableHead className="text-right">Cost Basis</TableHead>
                      <TableHead className="text-right">Market Value</TableHead>
                      <TableHead className="text-right">
                        Unrealized P&L
                      </TableHead>
                      <TableHead className="text-right">P&L %</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {[...(positions || [])]
                      .sort(
                        (a, b) =>
                          Math.abs(parseFloat(b.unrealized_pl)) -
                          Math.abs(parseFloat(a.unrealized_pl))
                      )
                      .map((pos) => {
                        const plPct = parseFloat(pos.unrealized_plpc) * 100;
                        return (
                          <TableRow key={pos.symbol}>
                            <TableCell className="font-medium">
                              {pos.symbol}
                            </TableCell>
                            <TableCell className="text-right">
                              {pos.qty}
                            </TableCell>
                            <TableCell className="text-right">
                              {formatCurrency(pos.avg_entry_price)}
                            </TableCell>
                            <TableCell className="text-right">
                              {formatCurrency(pos.current_price)}
                            </TableCell>
                            <TableCell className="text-right">
                              {formatCurrency(pos.cost_basis)}
                            </TableCell>
                            <TableCell className="text-right">
                              {formatCurrency(pos.market_value)}
                            </TableCell>
                            <TableCell
                              className={`text-right font-medium ${pnlColor(
                                pos.unrealized_pl
                              )}`}
                            >
                              {parseFloat(pos.unrealized_pl) >= 0 ? "+" : ""}
                              {formatCurrency(pos.unrealized_pl)}
                            </TableCell>
                            <TableCell
                              className={`text-right ${pnlColor(
                                pos.unrealized_plpc
                              )}`}
                            >
                              {plPct >= 0 ? "+" : ""}
                              {plPct.toFixed(2)}%
                            </TableCell>
                          </TableRow>
                        );
                      })}
                  </TableBody>
                </Table>
              ) : (
                <p className="text-sm text-muted-foreground py-4 text-center">
                  No open positions.
                </p>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="trades">
          <Card>
            <CardContent className="pt-4">
              {activities.length > 0 ? (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Symbol</TableHead>
                      <TableHead>Side</TableHead>
                      <TableHead className="text-right">Qty</TableHead>
                      <TableHead className="text-right">Price</TableHead>
                      <TableHead className="text-right">Amount</TableHead>
                      <TableHead>Time</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {activities.map((a) => (
                      <TableRow key={a.id}>
                        <TableCell className="font-medium">
                          {a.symbol}
                        </TableCell>
                        <TableCell>
                          <span
                            className={
                              a.side === "buy"
                                ? "text-emerald-500"
                                : "text-red-500"
                            }
                          >
                            {a.side?.toUpperCase()}
                          </span>
                        </TableCell>
                        <TableCell className="text-right">{a.qty}</TableCell>
                        <TableCell className="text-right">
                          {formatCurrency(a.price)}
                        </TableCell>
                        <TableCell className="text-right">
                          {a.net_amount
                            ? formatCurrency(a.net_amount)
                            : formatCurrency(
                                parseFloat(a.qty) * parseFloat(a.price)
                              )}
                        </TableCell>
                        <TableCell className="text-xs text-muted-foreground">
                          {formatDate(a.transaction_time)}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              ) : (
                <p className="text-sm text-muted-foreground py-4 text-center">
                  No trade history yet.
                </p>
              )}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}
