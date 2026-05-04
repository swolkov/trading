"use client";

import { useEffect, useState, useCallback } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { formatCurrency, pnlColor, formatDate } from "@/lib/utils";

interface AgentRun {
  id: number;
  runType: string;
  stocksScanned: number;
  tradesPlaced: number;
  positionsManaged: number;
  errors: number;
  summary: string;
  durationMs: number;
  createdAt: string;
}

interface TradeLog {
  id: number;
  symbol: string;
  action: string;
  qty: number;
  price: number | null;
  reason: string;
  aiScore: number | null;
  aiSignal: string | null;
  orderId: string | null;
  pnl: number | null;
  createdAt: string;
}

function actionBadge(action: string) {
  const colors: Record<string, string> = {
    buy: "bg-emerald-600",
    sell: "bg-red-600",
    stop_loss: "bg-red-500",
    take_profit: "bg-emerald-500",
    skip: "bg-muted text-muted-foreground",
  };
  return (
    <Badge className={colors[action] || "bg-muted"}>
      {action.replace("_", " ").toUpperCase()}
    </Badge>
  );
}

export default function AgentPage() {
  const [runs, setRuns] = useState<AgentRun[]>([]);
  const [trades, setTrades] = useState<TradeLog[]>([]);
  const [running, setRunning] = useState(false);
  const [runResult, setRunResult] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const loadData = useCallback(async () => {
    try {
      const [runsRes, tradesRes] = await Promise.all([
        fetch("/api/agent/logs?type=runs&limit=20").then((r) => r.json()),
        fetch("/api/agent/logs?limit=50").then((r) => r.json()),
      ]);
      if (Array.isArray(runsRes)) setRuns(runsRes);
      if (Array.isArray(tradesRes)) setTrades(tradesRes);
    } catch {
      // ignore
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    loadData();
  }, [loadData]);

  async function triggerAgent() {
    setRunning(true);
    setRunResult(null);
    try {
      const res = await fetch("/api/cron/trade", { method: "POST" });
      const data = await res.json();
      setRunResult(data.summary || JSON.stringify(data));
      loadData();
    } catch (err) {
      setRunResult(`Error: ${err}`);
    }
    setRunning(false);
  }

  // Stats
  const totalBuys = trades.filter((t) => t.action === "buy").length;
  const totalSells = trades.filter((t) =>
    ["sell", "stop_loss", "take_profit"].includes(t.action)
  ).length;
  const totalPnl = trades
    .filter((t) => t.pnl != null)
    .reduce((sum, t) => sum + (t.pnl || 0), 0);
  const profitableTrades = trades.filter(
    (t) => t.pnl != null && t.pnl > 0
  ).length;
  const losingTrades = trades.filter(
    (t) => t.pnl != null && t.pnl < 0
  ).length;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold tracking-tight">
            Auto-Trading Agent
          </h2>
          <p className="text-sm text-muted-foreground">
            Autonomous AI agent that scans, analyzes, and trades for you. Runs
            every 2 hours during market hours.
          </p>
        </div>
        <Button
          onClick={triggerAgent}
          disabled={running}
          className="bg-emerald-600 hover:bg-emerald-700"
        >
          {running ? "Agent running..." : "Run Agent Now"}
        </Button>
      </div>

      {runResult && (
        <Card>
          <CardContent className="pt-4">
            <p className="text-sm">{runResult}</p>
          </CardContent>
        </Card>
      )}

      {/* Stats */}
      <div className="grid grid-cols-1 md:grid-cols-5 gap-4">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm text-muted-foreground">
              Total Runs
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{runs.length}</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm text-muted-foreground">
              Buys / Sells
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">
              <span className="text-emerald-500">{totalBuys}</span>
              {" / "}
              <span className="text-red-500">{totalSells}</span>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm text-muted-foreground">
              Realized P&L
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className={`text-2xl font-bold ${pnlColor(totalPnl)}`}>
              {totalPnl >= 0 ? "+" : ""}
              {formatCurrency(totalPnl)}
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
            <div className="text-2xl font-bold">
              {profitableTrades + losingTrades > 0
                ? `${((profitableTrades / (profitableTrades + losingTrades)) * 100).toFixed(0)}%`
                : "N/A"}
            </div>
            <p className="text-xs text-muted-foreground">
              {profitableTrades}W / {losingTrades}L
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm text-muted-foreground">
              Last Run
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-sm font-medium">
              {runs[0]
                ? new Date(runs[0].createdAt).toLocaleString()
                : "Never"}
            </div>
            {runs[0] && (
              <p className="text-xs text-muted-foreground">
                {(runs[0].durationMs / 1000).toFixed(1)}s
              </p>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Risk Management Rules */}
      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Risk Management Rules</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
            <div>
              <span className="text-muted-foreground">Max Positions:</span>{" "}
              <strong>10</strong>
            </div>
            <div>
              <span className="text-muted-foreground">Max Per Stock:</span>{" "}
              <strong>5%</strong>
            </div>
            <div>
              <span className="text-muted-foreground">Stop Loss:</span>{" "}
              <strong className="text-red-500">-7%</strong>
            </div>
            <div>
              <span className="text-muted-foreground">Take Profit:</span>{" "}
              <strong className="text-emerald-500">+15%</strong>
            </div>
            <div>
              <span className="text-muted-foreground">Min AI Score:</span>{" "}
              <strong>55+</strong>
            </div>
            <div>
              <span className="text-muted-foreground">Min Confidence:</span>{" "}
              <strong>60%+</strong>
            </div>
            <div>
              <span className="text-muted-foreground">Cash Reserve:</span>{" "}
              <strong>20%</strong>
            </div>
            <div>
              <span className="text-muted-foreground">Max Daily Trades:</span>{" "}
              <strong>5</strong>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Tabs: Trades + Runs */}
      <Tabs defaultValue="trades">
        <TabsList>
          <TabsTrigger value="trades">Trade Log</TabsTrigger>
          <TabsTrigger value="runs">Agent Runs</TabsTrigger>
        </TabsList>

        <TabsContent value="trades">
          <Card>
            <CardContent className="pt-4">
              {loading ? (
                <p className="text-sm text-muted-foreground">Loading...</p>
              ) : trades.length === 0 ? (
                <p className="text-sm text-muted-foreground py-8 text-center">
                  No trades yet. Run the agent or wait for the next scheduled
                  run.
                </p>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Time</TableHead>
                      <TableHead>Symbol</TableHead>
                      <TableHead>Action</TableHead>
                      <TableHead className="text-right">Qty</TableHead>
                      <TableHead className="text-right">Price</TableHead>
                      <TableHead className="text-right">AI Score</TableHead>
                      <TableHead className="text-right">P&L</TableHead>
                      <TableHead>Reason</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {trades
                      .filter((t) => t.action !== "skip")
                      .map((trade) => (
                        <TableRow key={trade.id}>
                          <TableCell className="text-xs text-muted-foreground whitespace-nowrap">
                            {formatDate(trade.createdAt)}
                          </TableCell>
                          <TableCell className="font-medium">
                            {trade.symbol}
                          </TableCell>
                          <TableCell>{actionBadge(trade.action)}</TableCell>
                          <TableCell className="text-right">
                            {trade.qty || "-"}
                          </TableCell>
                          <TableCell className="text-right">
                            {trade.price ? formatCurrency(trade.price) : "-"}
                          </TableCell>
                          <TableCell className="text-right">
                            {trade.aiScore != null ? (
                              <span
                                className={
                                  trade.aiScore > 50
                                    ? "text-emerald-500"
                                    : trade.aiScore > 0
                                    ? "text-amber-500"
                                    : "text-red-500"
                                }
                              >
                                {trade.aiScore}
                              </span>
                            ) : (
                              "-"
                            )}
                          </TableCell>
                          <TableCell className="text-right">
                            {trade.pnl != null ? (
                              <span
                                className={`font-medium ${pnlColor(trade.pnl)}`}
                              >
                                {trade.pnl >= 0 ? "+" : ""}
                                {formatCurrency(trade.pnl)}
                              </span>
                            ) : (
                              "-"
                            )}
                          </TableCell>
                          <TableCell className="text-xs text-muted-foreground max-w-xs truncate">
                            {trade.reason}
                          </TableCell>
                        </TableRow>
                      ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="runs">
          <Card>
            <CardContent className="pt-4">
              {runs.length === 0 ? (
                <p className="text-sm text-muted-foreground py-8 text-center">
                  No agent runs yet.
                </p>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Time</TableHead>
                      <TableHead>Type</TableHead>
                      <TableHead className="text-right">Scanned</TableHead>
                      <TableHead className="text-right">Trades</TableHead>
                      <TableHead className="text-right">Managed</TableHead>
                      <TableHead className="text-right">Errors</TableHead>
                      <TableHead className="text-right">Duration</TableHead>
                      <TableHead>Summary</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {runs.map((run) => (
                      <TableRow key={run.id}>
                        <TableCell className="text-xs text-muted-foreground whitespace-nowrap">
                          {formatDate(run.createdAt)}
                        </TableCell>
                        <TableCell>
                          <Badge variant="outline">{run.runType}</Badge>
                        </TableCell>
                        <TableCell className="text-right">
                          {run.stocksScanned}
                        </TableCell>
                        <TableCell className="text-right">
                          {run.tradesPlaced}
                        </TableCell>
                        <TableCell className="text-right">
                          {run.positionsManaged}
                        </TableCell>
                        <TableCell className="text-right">
                          {run.errors > 0 ? (
                            <span className="text-red-500">{run.errors}</span>
                          ) : (
                            "0"
                          )}
                        </TableCell>
                        <TableCell className="text-right text-xs">
                          {(run.durationMs / 1000).toFixed(1)}s
                        </TableCell>
                        <TableCell className="text-xs text-muted-foreground max-w-xs truncate">
                          {run.summary}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}
