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
  notification_webhook: string;
  webhook_futures: string;
  webhook_options: string;
  webhook_general: string;
  daily_loss_limit: string;
  daily_spend_cap: string;
  max_options_exposure: string;
  per_trade_max: string;
  drawdown_kill_pct: string;
}

interface RegimeData {
  regime: string;
  recommendation: string;
  positionSizeMultiplier: number;
  cashReservePct: number;
  spy1mReturn: number;
  spy3mReturn: number;
  rsi: number | null;
  volatility: number;
  goldenCross: boolean;
  deathCross: boolean;
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
  const [regime, setRegime] = useState<RegimeData | null>(null);
  const { data: positions } = usePositions();
  const { data: orders } = useOrders("all");

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [activity, setActivity] = useState<any[]>([]);

  const loadData = useCallback(async () => {
    try {
      const [runsRes, tradesRes, configRes, regimeRes, activityRes] = await Promise.all([
        fetch("/api/agent/logs?type=runs&limit=20").then((r) => r.json()),
        fetch("/api/agent/logs?limit=100").then((r) => r.json()),
        fetch("/api/agent/config").then((r) => r.json()),
        fetch("/api/regime").then((r) => r.json()).catch(() => null),
        fetch("/api/agent/activity").then((r) => r.json()).catch(() => []),
      ]);
      if (Array.isArray(runsRes)) setRuns(runsRes);
      if (Array.isArray(tradesRes)) setTrades(tradesRes);
      setSettings(configRes);
      if (regimeRes && !regimeRes.error) setRegime(regimeRes);
      if (Array.isArray(activityRes)) setActivity(activityRes);
    } catch {
      // ignore
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    loadData();
    // Auto-refresh every 60 seconds
    const interval = setInterval(loadData, 60000);
    return () => clearInterval(interval);
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

      {/* Market Regime */}
      {regime && (
        <Card className={regime.regime === "bull" ? "border-emerald-500/30" : regime.regime === "bear" ? "border-red-500/30" : "border-amber-500/30"}>
          <CardContent className="pt-4">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <Badge className={regime.regime === "bull" ? "bg-emerald-600" : regime.regime === "bear" ? "bg-red-600" : "bg-amber-500"}>
                  {regime.regime.toUpperCase()} MARKET
                </Badge>
                <span className="text-sm">{regime.recommendation}</span>
              </div>
              <div className="flex gap-4 text-xs text-muted-foreground">
                <span>SPY 1M: <span className={pnlColor(regime.spy1mReturn)}>{(regime.spy1mReturn * 100).toFixed(1)}%</span></span>
                <span>RSI: {regime.rsi?.toFixed(0) || "N/A"}</span>
                <span>Vol: {regime.volatility.toFixed(0)}%</span>
                <span>Sizing: {regime.positionSizeMultiplier.toFixed(1)}x</span>
                <span>{regime.goldenCross ? "Golden Cross" : regime.deathCross ? "Death Cross" : ""}</span>
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Live Activity Feed */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm flex items-center gap-2">
            <span className="w-2 h-2 rounded-full bg-emerald-500 live-dot" />
            Live Activity (Last 24h)
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="space-y-2 max-h-72 overflow-y-auto">
            {activity.length === 0 && <p className="text-xs text-muted-foreground">No recent activity</p>}
            {activity.slice(0, 20).map((a, i) => (
              <div key={i} className={`flex items-start gap-3 text-xs border-l-2 pl-3 py-1 ${
                a.type === "success" ? "border-emerald-500" :
                a.type === "loss" ? "border-red-500" :
                a.type === "trade" ? "border-blue-500" :
                a.type === "run" ? "border-white/20" :
                "border-white/10"
              }`}>
                <span className="text-muted-foreground/50 whitespace-nowrap min-w-[60px]">
                  {new Date(a.time).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                </span>
                <div className="flex-1 min-w-0">
                  {a.type === "run" ? (
                    <span className="text-muted-foreground">{a.reason}</span>
                  ) : (
                    <div>
                      <span className={`font-medium ${
                        a.action.includes("buy") ? "text-emerald-400" :
                        a.action.includes("sell") || a.action.includes("stop") ? "text-red-400" :
                        a.action.includes("skip") || a.action.includes("veto") ? "text-muted-foreground" :
                        "text-foreground"
                      }`}>
                        {a.action.replace(/_/g, " ").toUpperCase()}
                      </span>
                      {a.symbol && <span className="ml-1 font-bold">{a.symbol}</span>}
                      {a.qty > 0 && <span className="text-muted-foreground ml-1">{a.qty}x</span>}
                      {a.price && <span className="text-muted-foreground ml-1">@ ${a.price.toFixed(2)}</span>}
                      {a.pnl != null && (
                        <span className={`ml-2 ${a.pnl >= 0 ? "text-emerald-400" : "text-red-400"}`}>
                          P&L: ${a.pnl.toFixed(2)}
                        </span>
                      )}
                      {a.score != null && (
                        <span className="ml-2 text-muted-foreground/60">Score: {a.score}</span>
                      )}
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

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
                  <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                    <div className="space-y-1.5">
                      <label className="text-[10px] text-muted-foreground/60 uppercase tracking-wider font-medium">Strategy Mode</label>
                      <div className="flex gap-1.5">
                        {[
                          { value: "aggressive", label: "Aggressive", color: "bg-red-500/15 text-red-400 border-red-500/30" },
                          { value: "balanced", label: "Balanced", color: "bg-emerald-500/15 text-emerald-400 border-emerald-500/30" },
                          { value: "conservative", label: "Conservative", color: "bg-blue-500/15 text-blue-400 border-blue-500/30" },
                        ].map((s) => (
                          <button
                            key={s.value}
                            onClick={() => updateSetting("strategy", s.value)}
                            className={`px-3 py-1.5 rounded-lg text-xs font-medium border transition-all ${
                              settings.strategy === s.value ? s.color : "bg-white/[0.03] text-muted-foreground border-white/[0.06] hover:bg-white/[0.06]"
                            }`}
                          >
                            {s.label}
                          </button>
                        ))}
                      </div>
                    </div>
                    <div className="space-y-1.5">
                      <label className="text-[10px] text-muted-foreground/60 uppercase tracking-wider font-medium">Agent Status</label>
                      <div className="flex gap-1.5">
                        <button
                          onClick={() => updateSetting("enabled", "true")}
                          className={`px-4 py-1.5 rounded-lg text-xs font-medium border transition-all ${
                            settings.enabled === "true" ? "bg-emerald-500/15 text-emerald-400 border-emerald-500/30" : "bg-white/[0.03] text-muted-foreground border-white/[0.06] hover:bg-white/[0.06]"
                          }`}
                        >
                          Active
                        </button>
                        <button
                          onClick={() => updateSetting("enabled", "false")}
                          className={`px-4 py-1.5 rounded-lg text-xs font-medium border transition-all ${
                            settings.enabled === "false" ? "bg-red-500/15 text-red-400 border-red-500/30" : "bg-white/[0.03] text-muted-foreground border-white/[0.06] hover:bg-white/[0.06]"
                          }`}
                        >
                          Paused
                        </button>
                      </div>
                    </div>
                    <div className="space-y-1.5">
                      <label className="text-[10px] text-muted-foreground/60 uppercase tracking-wider font-medium">Trade Type</label>
                      <div className="flex gap-1.5">
                        <button
                          onClick={() => updateSetting("trade_options", "true")}
                          className={`px-4 py-1.5 rounded-lg text-xs font-medium border transition-all ${
                            settings.trade_options === "true" ? "bg-emerald-500/15 text-emerald-400 border-emerald-500/30" : "bg-white/[0.03] text-muted-foreground border-white/[0.06] hover:bg-white/[0.06]"
                          }`}
                        >
                          Options
                        </button>
                        <button
                          onClick={() => updateSetting("trade_options", "false")}
                          className={`px-4 py-1.5 rounded-lg text-xs font-medium border transition-all ${
                            settings.trade_options === "false" ? "bg-blue-500/15 text-blue-400 border-blue-500/30" : "bg-white/[0.03] text-muted-foreground border-white/[0.06] hover:bg-white/[0.06]"
                          }`}
                        >
                          Stocks Only
                        </button>
                      </div>
                    </div>
                  </div>
                </CardContent>
              </Card>

              <Card>
                <CardHeader>
                  <CardTitle className="text-sm">Risk Management</CardTitle>
                </CardHeader>
                <CardContent className="space-y-5">
                  {/* Position Limits */}
                  <div>
                    <p className="text-[10px] text-muted-foreground/50 uppercase tracking-wider font-medium mb-2">Position Limits</p>
                    <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                      {[
                        { key: "max_positions", label: "Max Positions", val: settings.max_positions },
                        { key: "max_per_sector", label: "Per Sector", val: settings.max_per_sector },
                        { key: "max_position_pct", label: "Size %", val: settings.max_position_pct, suffix: "%" },
                        { key: "cash_reserve_pct", label: "Cash Reserve", val: settings.cash_reserve_pct, suffix: "%" },
                      ].map((f) => (
                        <div key={f.key} className="space-y-1">
                          <label className="text-[11px] text-muted-foreground">{f.label}</label>
                          <Input type="number" className="h-9" value={f.val} onChange={(e) => updateSetting(f.key as keyof AgentSettings, e.target.value)} />
                        </div>
                      ))}
                    </div>
                  </div>

                  {/* Exit Rules */}
                  <div>
                    <p className="text-[10px] text-muted-foreground/50 uppercase tracking-wider font-medium mb-2">Exit Rules</p>
                    <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                      {[
                        { key: "stop_loss_atr", label: "Stop Loss (ATR)", val: settings.stop_loss_atr, step: "0.1" },
                        { key: "take_profit_pct", label: "Take Profit %", val: settings.take_profit_pct },
                        { key: "options_stop_loss_pct", label: "Options Stop %", val: settings.options_stop_loss_pct },
                        { key: "options_profit_pct", label: "Options Profit %", val: settings.options_profit_pct },
                      ].map((f) => (
                        <div key={f.key} className="space-y-1">
                          <label className="text-[11px] text-muted-foreground">{f.label}</label>
                          <Input type="number" step={f.step || "1"} className="h-9" value={f.val} onChange={(e) => updateSetting(f.key as keyof AgentSettings, e.target.value)} />
                        </div>
                      ))}
                    </div>
                  </div>

                  {/* AI & Frequency */}
                  <div>
                    <p className="text-[10px] text-muted-foreground/50 uppercase tracking-wider font-medium mb-2">AI Thresholds & Frequency</p>
                    <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                      {[
                        { key: "min_score", label: "Min AI Score", val: settings.min_score },
                        { key: "min_confidence", label: "Min Confidence %", val: settings.min_confidence },
                        { key: "max_daily_trades", label: "Max Daily Trades", val: settings.max_daily_trades },
                        { key: "cooldown_hours", label: "Cooldown (hrs)", val: settings.cooldown_hours },
                      ].map((f) => (
                        <div key={f.key} className="space-y-1">
                          <label className="text-[11px] text-muted-foreground">{f.label}</label>
                          <Input type="number" className="h-9" value={f.val} onChange={(e) => updateSetting(f.key as keyof AgentSettings, e.target.value)} />
                        </div>
                      ))}
                    </div>
                  </div>
                  {/* Spending & Safety Limits */}
                  <div>
                    <p className="text-[10px] text-muted-foreground/50 uppercase tracking-wider font-medium mb-2">Spending & Safety Limits (for live trading)</p>
                    <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
                      {[
                        { key: "daily_loss_limit", label: "Daily Loss Limit $", val: settings.daily_loss_limit },
                        { key: "daily_spend_cap", label: "Daily Spend Cap $", val: settings.daily_spend_cap },
                        { key: "max_options_exposure", label: "Max Options Exposure $", val: settings.max_options_exposure },
                        { key: "per_trade_max", label: "Per Trade Max $", val: settings.per_trade_max },
                        { key: "drawdown_kill_pct", label: "Kill Switch %", val: settings.drawdown_kill_pct },
                      ].map((f) => (
                        <div key={f.key} className="space-y-1">
                          <label className="text-[11px] text-muted-foreground">{f.label}</label>
                          <Input type="number" className="h-9" value={f.val} onChange={(e) => updateSetting(f.key as keyof AgentSettings, e.target.value)} />
                        </div>
                      ))}
                    </div>
                    <p className="text-[10px] text-muted-foreground/30 mt-2">Kill Switch pauses the agent if your account drops this % from its peak value.</p>
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

              <Card>
                <CardHeader>
                  <CardTitle className="text-sm">Notifications</CardTitle>
                </CardHeader>
                <CardContent className="space-y-3">
                  <div className="space-y-1">
                    <label className="text-xs font-medium">#futures Channel Webhook</label>
                    <Input
                      placeholder="https://hooks.slack.com/services/..."
                      value={settings.webhook_futures}
                      onChange={(e) => updateSetting("webhook_futures", e.target.value)}
                    />
                  </div>
                  <div className="space-y-1">
                    <label className="text-xs font-medium">#options Channel Webhook</label>
                    <Input
                      placeholder="https://hooks.slack.com/services/..."
                      value={settings.webhook_options}
                      onChange={(e) => updateSetting("webhook_options", e.target.value)}
                    />
                  </div>
                  <div className="space-y-1">
                    <label className="text-xs font-medium">#general Channel Webhook (errors + stocks)</label>
                    <Input
                      placeholder="https://hooks.slack.com/services/..."
                      value={settings.webhook_general}
                      onChange={(e) => updateSetting("webhook_general", e.target.value)}
                    />
                  </div>
                  <p className="text-xs text-muted-foreground">Create Slack webhooks at api.slack.com/messaging/webhooks — one per channel</p>
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
