"use client";

import { useState } from "react";
import { SymbolSearch } from "@/components/trading/symbol-search";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { formatCurrency, pnlColor } from "@/lib/utils";

interface BacktestResult {
  totalReturnPct: number;
  totalReturn: number;
  finalCapital: number;
  winRate: number;
  winners: number;
  losers: number;
  avgWin: number;
  avgLoss: number;
  maxDrawdown: number;
  sharpeRatio: number;
  buyAndHoldReturn: number;
  alpha: number;
  trades: {
    date: string;
    action: string;
    price: number;
    qty: number;
    reason: string;
    pnl?: number;
    pnlPct?: number;
  }[];
  equityCurve: { date: string; equity: number }[];
}

export default function BacktestPage() {
  const [symbol, setSymbol] = useState("SPY");
  const [strategy, setStrategy] = useState("momentum");
  const [startDate, setStartDate] = useState("2025-01-01");
  const [endDate, setEndDate] = useState("2026-05-01");
  const [stopLoss, setStopLoss] = useState("7");
  const [takeProfit, setTakeProfit] = useState("15");
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<BacktestResult | null>(null);
  const [error, setError] = useState("");

  async function runBacktest() {
    setRunning(true);
    setResult(null);
    setError("");
    try {
      const res = await fetch("/api/backtest", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          symbol,
          startDate,
          endDate,
          strategy,
          initialCapital: 100000,
          positionSizePct: 50,
          stopLossPct: parseFloat(stopLoss),
          takeProfitPct: parseFloat(takeProfit),
        }),
      });
      const data = await res.json();
      if (data.error) setError(data.error);
      else setResult(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed");
    }
    setRunning(false);
  }

  return (
    <div className="space-y-6">
      <h2 className="text-2xl font-bold tracking-tight">Backtesting Engine</h2>
      <p className="text-sm text-muted-foreground">
        Test trading strategies against historical data before risking real money.
      </p>

      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Configure Backtest</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <div className="space-y-1">
              <label className="text-xs font-medium">Symbol</label>
              <SymbolSearch onSelect={setSymbol} value={symbol} />
            </div>
            <div className="space-y-1">
              <label className="text-xs font-medium">Strategy</label>
              <Select value={strategy} onValueChange={(v) => v && setStrategy(v)}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="sma_crossover">SMA Crossover (20/50)</SelectItem>
                  <SelectItem value="rsi_reversal">RSI Reversal (30/70)</SelectItem>
                  <SelectItem value="momentum">Momentum (trend following)</SelectItem>
                  <SelectItem value="mean_reversion">Mean Reversion</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <label className="text-xs font-medium">Start Date</label>
              <Input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} />
            </div>
            <div className="space-y-1">
              <label className="text-xs font-medium">End Date</label>
              <Input type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} />
            </div>
            <div className="space-y-1">
              <label className="text-xs font-medium">Stop Loss %</label>
              <Input type="number" value={stopLoss} onChange={(e) => setStopLoss(e.target.value)} />
            </div>
            <div className="space-y-1">
              <label className="text-xs font-medium">Take Profit %</label>
              <Input type="number" value={takeProfit} onChange={(e) => setTakeProfit(e.target.value)} />
            </div>
          </div>
          <Button onClick={runBacktest} disabled={running} className="mt-4 bg-emerald-600 hover:bg-emerald-700">
            {running ? "Running backtest..." : "Run Backtest"}
          </Button>
          {error && <p className="text-sm text-red-500 mt-2">{error}</p>}
        </CardContent>
      </Card>

      {result && (
        <>
          {/* Results Summary */}
          <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-xs text-muted-foreground">Total Return</CardTitle>
              </CardHeader>
              <CardContent>
                <div className={`text-2xl font-bold ${pnlColor(result.totalReturnPct)}`}>
                  {result.totalReturnPct >= 0 ? "+" : ""}{result.totalReturnPct.toFixed(2)}%
                </div>
                <p className="text-xs text-muted-foreground">{formatCurrency(result.totalReturn)}</p>
              </CardContent>
            </Card>
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-xs text-muted-foreground">Win Rate</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-bold">{(result.winRate * 100).toFixed(0)}%</div>
                <p className="text-xs text-muted-foreground">{result.winners}W / {result.losers}L</p>
              </CardContent>
            </Card>
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-xs text-muted-foreground">Max Drawdown</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-bold text-red-500">-{result.maxDrawdown.toFixed(2)}%</div>
              </CardContent>
            </Card>
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-xs text-muted-foreground">Sharpe Ratio</CardTitle>
              </CardHeader>
              <CardContent>
                <div className={`text-2xl font-bold ${result.sharpeRatio > 1 ? "text-emerald-500" : result.sharpeRatio > 0 ? "text-amber-500" : "text-red-500"}`}>
                  {result.sharpeRatio.toFixed(2)}
                </div>
              </CardContent>
            </Card>
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-xs text-muted-foreground">vs Buy & Hold</CardTitle>
              </CardHeader>
              <CardContent>
                <div className={`text-2xl font-bold ${pnlColor(result.alpha)}`}>
                  {result.alpha >= 0 ? "+" : ""}{result.alpha.toFixed(2)}%
                </div>
                <p className="text-xs text-muted-foreground">
                  B&H: {result.buyAndHoldReturn >= 0 ? "+" : ""}{result.buyAndHoldReturn.toFixed(2)}%
                </p>
              </CardContent>
            </Card>
          </div>

          {/* Performance Stats */}
          <Card>
            <CardHeader>
              <CardTitle className="text-sm">Performance Attribution</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
                <div>
                  <span className="text-muted-foreground">Avg Win:</span>{" "}
                  <span className="text-emerald-500 font-medium">+{result.avgWin.toFixed(2)}%</span>
                </div>
                <div>
                  <span className="text-muted-foreground">Avg Loss:</span>{" "}
                  <span className="text-red-500 font-medium">{result.avgLoss.toFixed(2)}%</span>
                </div>
                <div>
                  <span className="text-muted-foreground">Final Capital:</span>{" "}
                  <span className="font-medium">{formatCurrency(result.finalCapital)}</span>
                </div>
                <div>
                  <span className="text-muted-foreground">Total Trades:</span>{" "}
                  <span className="font-medium">{result.trades.length}</span>
                </div>
              </div>
            </CardContent>
          </Card>

          {/* Equity Curve (text) */}
          <Card>
            <CardHeader>
              <CardTitle className="text-sm">Equity Curve</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="max-h-48 overflow-auto space-y-0.5">
                {result.equityCurve.filter((_, i) => i % Math.max(1, Math.floor(result.equityCurve.length / 30)) === 0).map((point) => {
                  const returnPct = ((point.equity - 100000) / 100000) * 100;
                  return (
                    <div key={point.date} className="flex justify-between text-xs">
                      <span className="text-muted-foreground">{point.date}</span>
                      <span className="font-medium">{formatCurrency(point.equity)}</span>
                      <span className={pnlColor(returnPct)}>
                        {returnPct >= 0 ? "+" : ""}{returnPct.toFixed(2)}%
                      </span>
                    </div>
                  );
                })}
              </div>
            </CardContent>
          </Card>

          {/* Trade List */}
          <Card>
            <CardHeader>
              <CardTitle className="text-sm">Trade History ({result.trades.length} trades)</CardTitle>
            </CardHeader>
            <CardContent>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Date</TableHead>
                    <TableHead>Action</TableHead>
                    <TableHead className="text-right">Price</TableHead>
                    <TableHead className="text-right">Qty</TableHead>
                    <TableHead className="text-right">P&L</TableHead>
                    <TableHead className="text-right">P&L %</TableHead>
                    <TableHead>Reason</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {result.trades.map((trade, i) => (
                    <TableRow key={i}>
                      <TableCell className="text-xs">{trade.date}</TableCell>
                      <TableCell>
                        <Badge className={trade.action === "buy" ? "bg-emerald-600" : "bg-red-600"}>
                          {trade.action.toUpperCase()}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-right">{formatCurrency(trade.price)}</TableCell>
                      <TableCell className="text-right">{trade.qty}</TableCell>
                      <TableCell className={`text-right ${pnlColor(trade.pnl || 0)}`}>
                        {trade.pnl != null ? formatCurrency(trade.pnl) : "-"}
                      </TableCell>
                      <TableCell className={`text-right ${pnlColor(trade.pnlPct || 0)}`}>
                        {trade.pnlPct != null ? `${(trade.pnlPct * 100).toFixed(2)}%` : "-"}
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground">{trade.reason}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}
