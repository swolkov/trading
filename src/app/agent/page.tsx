"use client";

import { useEffect, useState, useCallback } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
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
import { usePositions } from "@/hooks/use-positions";
import { useOrders } from "@/hooks/use-orders";

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

interface AgentSettings {
  strategy: string;
  enabled: string;
  max_positions: string;
  max_per_sector: string;
  max_position_pct: string;
  min_score: string;
  min_confidence: string;
  stop_loss_atr: string;
  take_profit_pct: string;
  cash_reserve_pct: string;
  max_daily_trades: string;
  trade_options: string;
  options_stop_loss_pct: string;
  options_profit_pct: string;
  focus_symbols: string;
  blacklist: string;
  cooldown_hours: string;
}

function actionBadge(action: string) {
  const colors: Record<string, string> = {
    buy: "bg-emerald-600",
    sell: "bg-red-600",
    stop_loss: "bg-red-500",
    take_profit: "bg-emerald-500",
    trailing_stop: "bg-amber-500",
    thesis_change: "bg-purple-500",
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
  const [runResult, setRunResult] = useState<string[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [settings, setSettings] = useState<AgentSettings | null>(null);
  const [saving, setSaving] = useState(false);
  const { data: positions } = usePositions();
  const { data: orders } = useOrders("all");

  const loadData = useCallback(async () => {
    try {
      const [runsRes, tradesRes, configRes] = await Promise.all([
        fetch("/api/agent/logs?type=runs&limit=20").then((r) => r.json()),
        fetch("/api/agent/logs?limit=100").then((r) => r.json()),
        fetch("/api/agent/config").then((r) => r.json()),
      ]);
      if (Array.isArray(runsRes)) setRuns(runsRes);
      if (Array.isArray(tradesRes)) setTrades(tradesRes);
      setSettings(configRes);
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
      setRunResult(data.details || [data.summary || JSON.stringify(data)]);
      loadData();
    } catch (err) {
      setRunResult([`Error: ${err}`]);
    }
    setRunning(false);
  }

  async function saveSettings() {
    if (!settings) return;
    setSaving(true);
    try {
      await fetch("/api/agent/config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(settings),
      });
    } catch {
      // ignore
    }
    setSaving(false);
  }

  function updateSetting(key: keyof AgentSettings, value: string) {
    if (!settings) return;
    setSettings({ ...settings, [key]: value });
  }

  // Stats from agent trades
  const agentBuys = trades.filter((t) => t.action === "buy").length;
  const agentSells = trades.filter((t) =>
    ["sell", "stop_loss", "take_profit", "trailing_stop", "thesis_change"].includes(t.action)
  ).length;
  const totalPnl = trades
    .filter((t) => t.pnl != null)
    .reduce((sum, t) => sum + (t.pnl || 0), 0);
  const profitableTrades = trades.filter((t) => t.pnl != null && t.pnl > 0).length;
  const losingTrades = trades.filter((t) => t.pnl != null && t.pnl < 0).length;

  // Current positions P&L
  const totalUnrealizedPnl = positions?.reduce((sum, p) => sum + parseFloat(p.unrealized_pl), 0) || 0;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold tracking-tight">Auto-Trading Agent</h2>
          <p className="text-sm text-muted-foreground">
            AI-powered autonomous trader. Scans, analyzes, and trades with risk management.
          </p>
        </div>
        <div className="flex gap-2">
          <Badge
            variant={settings?.enabled === "true" ? "default" : "secondary"}
            className={settings?.enabled === "true" ? "bg-emerald-600" : ""}
          >
            {settings?.enabled === "true" ? "Agent Active" : "Agent Paused"}
          </Badge>
          <Button
            onClick={triggerAgent}
            disabled={running}
            className="bg-emerald-600 hover:bg-emerald-700"
          >
            {running ? "Running..." : "Run Agent Now"}
          </Button>
        </div>
      </div>

      {/* Agent Run Output */}
      {runResult && (
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Agent Run Output</CardTitle>
          </CardHeader>
          <CardContent>
            <pre className="text-xs font-mono whitespace-pre-wrap bg-muted p-3 rounded max-h-64 overflow-auto">
              {runResult.join("\n")}
            </pre>
          </CardContent>
        </Card>
      )}

      {/* Stats */}
      <div className="grid grid-cols-2 md:grid-cols-6 gap-4">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-xs text-muted-foreground">Total Runs</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{runs.length}</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-xs text-muted-foreground">Agent Buys / Sells</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">
              <span className="text-emerald-500">{agentBuys}</span>
              {" / "}
              <span className="text-red-500">{agentSells}</span>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-xs text-muted-foreground">Realized P&L</CardTitle>
          </CardHeader>
          <CardContent>
            <div className={`text-2xl font-bold ${pnlColor(totalPnl)}`}>
              {totalPnl >= 0 ? "+" : ""}{formatCurrency(totalPnl)}
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-xs text-muted-foreground">Unrealized P&L</CardTitle>
          </CardHeader>
          <CardContent>
            <div className={`text-2xl font-bold ${pnlColor(totalUnrealizedPnl)}`}>
              {totalUnrealizedPnl >= 0 ? "+" : ""}{formatCurrency(totalUnrealizedPnl)}
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-xs text-muted-foreground">Win Rate</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">
              {profitableTrades + losingTrades > 0
                ? `${((profitableTrades / (profitableTrades + losingTrades)) * 100).toFixed(0)}%`
                : "N/A"}
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-xs text-muted-foreground">Active Positions</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{positions?.length || 0}</div>
          </CardContent>
        </Card>
      </div>

      <Tabs defaultValue="positions">
        <TabsList>
          <TabsTrigger value="positions">Live Positions ({positions?.length || 0})</TabsTrigger>
          <TabsTrigger value="trades">Agent Trade Log</TabsTrigger>
          <TabsTrigger value="orders">All Orders ({orders?.length || 0})</TabsTrigger>
          <TabsTrigger value="runs">Agent Runs</TabsTrigger>
          <TabsTrigger value="settings">Settings</TabsTrigger>
        </TabsList>

        {/* Live Positions */}
        <TabsContent value="positions">
          <Card>
            <CardContent className="pt-4">
              {positions && positions.length > 0 ? (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Symbol</TableHead>
                      <TableHead className="text-right">Qty</TableHead>
                      <TableHead className="text-right">Entry</TableHead>
                      <TableHead className="text-right">Current</TableHead>
                      <TableHead className="text-right">P&L</TableHead>
                      <TableHead className="text-right">P&L %</TableHead>
                      <TableHead className="text-right">Value</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {positions.map((pos) => {
                      const plPct = parseFloat(pos.unrealized_plpc) * 100;
                      return (
                        <TableRow key={pos.symbol}>
                          <TableCell className="font-medium">{pos.symbol}</TableCell>
                          <TableCell className="text-right">{pos.qty}</TableCell>
                          <TableCell className="text-right">{formatCurrency(pos.avg_entry_price)}</TableCell>
                          <TableCell className="text-right">{formatCurrency(pos.current_price)}</TableCell>
                          <TableCell className={`text-right font-medium ${pnlColor(pos.unrealized_pl)}`}>
                            {parseFloat(pos.unrealized_pl) >= 0 ? "+" : ""}{formatCurrency(pos.unrealized_pl)}
                          </TableCell>
                          <TableCell className={`text-right ${pnlColor(pos.unrealized_plpc)}`}>
                            {plPct >= 0 ? "+" : ""}{plPct.toFixed(2)}%
                          </TableCell>
                          <TableCell className="text-right">{formatCurrency(pos.market_value)}</TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              ) : (
                <p className="text-sm text-muted-foreground text-center py-4">No open positions</p>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* Agent Trade Log */}
        <TabsContent value="trades">
          <Card>
            <CardContent className="pt-4">
              {trades.length === 0 ? (
                <p className="text-sm text-muted-foreground py-8 text-center">
                  No agent trades yet. Run the agent during market hours.
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
                    {trades.map((trade) => (
                      <TableRow key={trade.id}>
                        <TableCell className="text-xs text-muted-foreground whitespace-nowrap">
                          {formatDate(trade.createdAt)}
                        </TableCell>
                        <TableCell className="font-medium">{trade.symbol}</TableCell>
                        <TableCell>{actionBadge(trade.action)}</TableCell>
                        <TableCell className="text-right">{trade.qty || "-"}</TableCell>
                        <TableCell className="text-right">
                          {trade.price ? formatCurrency(trade.price) : "-"}
                        </TableCell>
                        <TableCell className="text-right">
                          {trade.aiScore != null ? (
                            <span className={trade.aiScore > 50 ? "text-emerald-500" : trade.aiScore > 0 ? "text-amber-500" : "text-red-500"}>
                              {trade.aiScore}
                            </span>
                          ) : "-"}
                        </TableCell>
                        <TableCell className="text-right">
                          {trade.pnl != null ? (
                            <span className={`font-medium ${pnlColor(trade.pnl)}`}>
                              {trade.pnl >= 0 ? "+" : ""}{formatCurrency(trade.pnl)}
                            </span>
                          ) : "-"}
                        </TableCell>
                        <TableCell className="text-xs text-muted-foreground max-w-sm">
                          {trade.reason.slice(0, 200)}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* All Orders */}
        <TabsContent value="orders">
          <Card>
            <CardContent className="pt-4">
              {orders && orders.length > 0 ? (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Time</TableHead>
                      <TableHead>Symbol</TableHead>
                      <TableHead>Side</TableHead>
                      <TableHead>Type</TableHead>
                      <TableHead className="text-right">Qty</TableHead>
                      <TableHead className="text-right">Fill Price</TableHead>
                      <TableHead>Status</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {orders.map((order) => (
                      <TableRow key={order.id}>
                        <TableCell className="text-xs text-muted-foreground whitespace-nowrap">
                          {formatDate(order.submitted_at)}
                        </TableCell>
                        <TableCell className="font-medium">{order.symbol}</TableCell>
                        <TableCell>
                          <span className={order.side === "buy" ? "text-emerald-500" : "text-red-500"}>
                            {order.side.toUpperCase()}
                          </span>
                        </TableCell>
                        <TableCell>{order.type}</TableCell>
                        <TableCell className="text-right">{order.qty}</TableCell>
                        <TableCell className="text-right">
                          {order.filled_avg_price ? formatCurrency(order.filled_avg_price) : "-"}
                        </TableCell>
                        <TableCell>
                          <Badge variant={order.status === "filled" ? "default" : "secondary"}
                            className={order.status === "filled" ? "bg-emerald-600" : ""}>
                            {order.status}
                          </Badge>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              ) : (
                <p className="text-sm text-muted-foreground text-center py-4">No orders</p>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* Agent Runs */}
        <TabsContent value="runs">
          <Card>
            <CardContent className="pt-4">
              {runs.length === 0 ? (
                <p className="text-sm text-muted-foreground py-8 text-center">No agent runs yet.</p>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Time</TableHead>
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
                        <TableCell className="text-right">{run.stocksScanned}</TableCell>
                        <TableCell className="text-right">{run.tradesPlaced}</TableCell>
                        <TableCell className="text-right">{run.positionsManaged}</TableCell>
                        <TableCell className="text-right">
                          {run.errors > 0 ? <span className="text-red-500">{run.errors}</span> : "0"}
                        </TableCell>
                        <TableCell className="text-right text-xs">{(run.durationMs / 1000).toFixed(1)}s</TableCell>
                        <TableCell className="text-xs text-muted-foreground max-w-xs truncate">{run.summary}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* Settings */}
        <TabsContent value="settings">
          {settings && (
            <div className="space-y-4">
              <Card>
                <CardHeader>
                  <CardTitle className="text-sm">Strategy & Controls</CardTitle>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
                    <div className="space-y-1">
                      <label className="text-xs font-medium">Strategy Mode</label>
                      <Select value={settings.strategy} onValueChange={(v) => v && updateSetting("strategy", v)}>
                        <SelectTrigger><SelectValue /></SelectTrigger>
                        <SelectContent>
                          <SelectItem value="aggressive">Aggressive (higher risk/reward)</SelectItem>
                          <SelectItem value="balanced">Balanced (recommended)</SelectItem>
                          <SelectItem value="conservative">Conservative (capital preservation)</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="space-y-1">
                      <label className="text-xs font-medium">Agent Enabled</label>
                      <Select value={settings.enabled} onValueChange={(v) => v && updateSetting("enabled", v)}>
                        <SelectTrigger><SelectValue /></SelectTrigger>
                        <SelectContent>
                          <SelectItem value="true">Active — trades automatically</SelectItem>
                          <SelectItem value="false">Paused — scan only, no trades</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="space-y-1">
                      <label className="text-xs font-medium">Trade Options</label>
                      <Select value={settings.trade_options} onValueChange={(v) => v && updateSetting("trade_options", v)}>
                        <SelectTrigger><SelectValue /></SelectTrigger>
                        <SelectContent>
                          <SelectItem value="true">Yes — manage options positions</SelectItem>
                          <SelectItem value="false">No — stocks only</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                  </div>
                </CardContent>
              </Card>

              <Card>
                <CardHeader>
                  <CardTitle className="text-sm">Risk Management</CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                    <div className="space-y-1">
                      <label className="text-xs font-medium">Max Positions</label>
                      <Input type="number" value={settings.max_positions} onChange={(e) => updateSetting("max_positions", e.target.value)} />
                    </div>
                    <div className="space-y-1">
                      <label className="text-xs font-medium">Max Per Sector</label>
                      <Input type="number" value={settings.max_per_sector} onChange={(e) => updateSetting("max_per_sector", e.target.value)} />
                    </div>
                    <div className="space-y-1">
                      <label className="text-xs font-medium">Max Position %</label>
                      <Input type="number" value={settings.max_position_pct} onChange={(e) => updateSetting("max_position_pct", e.target.value)} />
                    </div>
                    <div className="space-y-1">
                      <label className="text-xs font-medium">Cash Reserve %</label>
                      <Input type="number" value={settings.cash_reserve_pct} onChange={(e) => updateSetting("cash_reserve_pct", e.target.value)} />
                    </div>
                    <div className="space-y-1">
                      <label className="text-xs font-medium">Stop Loss (ATR mult)</label>
                      <Input type="number" step="0.1" value={settings.stop_loss_atr} onChange={(e) => updateSetting("stop_loss_atr", e.target.value)} />
                    </div>
                    <div className="space-y-1">
                      <label className="text-xs font-medium">Take Profit %</label>
                      <Input type="number" value={settings.take_profit_pct} onChange={(e) => updateSetting("take_profit_pct", e.target.value)} />
                    </div>
                    <div className="space-y-1">
                      <label className="text-xs font-medium">Min AI Score</label>
                      <Input type="number" value={settings.min_score} onChange={(e) => updateSetting("min_score", e.target.value)} />
                    </div>
                    <div className="space-y-1">
                      <label className="text-xs font-medium">Min Confidence %</label>
                      <Input type="number" value={settings.min_confidence} onChange={(e) => updateSetting("min_confidence", e.target.value)} />
                    </div>
                    <div className="space-y-1">
                      <label className="text-xs font-medium">Max Daily Trades</label>
                      <Input type="number" value={settings.max_daily_trades} onChange={(e) => updateSetting("max_daily_trades", e.target.value)} />
                    </div>
                    <div className="space-y-1">
                      <label className="text-xs font-medium">Cooldown (hours)</label>
                      <Input type="number" value={settings.cooldown_hours} onChange={(e) => updateSetting("cooldown_hours", e.target.value)} />
                    </div>
                    <div className="space-y-1">
                      <label className="text-xs font-medium">Options Stop %</label>
                      <Input type="number" value={settings.options_stop_loss_pct} onChange={(e) => updateSetting("options_stop_loss_pct", e.target.value)} />
                    </div>
                    <div className="space-y-1">
                      <label className="text-xs font-medium">Options Profit %</label>
                      <Input type="number" value={settings.options_profit_pct} onChange={(e) => updateSetting("options_profit_pct", e.target.value)} />
                    </div>
                  </div>
                </CardContent>
              </Card>

              <Card>
                <CardHeader>
                  <CardTitle className="text-sm">Focus & Blacklist</CardTitle>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="space-y-1">
                    <label className="text-xs font-medium">Focus Symbols (agent will prioritize these)</label>
                    <Input
                      placeholder="e.g. AAPL, NVDA, TSLA, MSFT, AMZN"
                      value={settings.focus_symbols}
                      onChange={(e) => updateSetting("focus_symbols", e.target.value)}
                    />
                    <p className="text-xs text-muted-foreground">Comma-separated. Agent will analyze these first before scanning the market.</p>
                  </div>
                  <div className="space-y-1">
                    <label className="text-xs font-medium">Blacklist (never trade these)</label>
                    <Input
                      placeholder="e.g. GME, AMC, BBBY"
                      value={settings.blacklist}
                      onChange={(e) => updateSetting("blacklist", e.target.value)}
                    />
                    <p className="text-xs text-muted-foreground">Comma-separated. Agent will skip these symbols entirely.</p>
                  </div>
                </CardContent>
              </Card>

              <Button onClick={saveSettings} disabled={saving} className="w-full">
                {saving ? "Saving..." : "Save Settings"}
              </Button>
            </div>
          )}
        </TabsContent>
      </Tabs>
    </div>
  );
}
