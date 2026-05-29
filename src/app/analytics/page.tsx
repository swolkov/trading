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

interface DailyPnl { date: string; pnl: number }
interface MonthlyPnl { month: string; pnl: number }
interface TradeAnalysis {
  dailyPnl: DailyPnl[];
  monthlyPnl: MonthlyPnl[];
  stats: { totalPnl: number; totalTrades: number; winRate: number; openTrades: number };
}

interface StrategyPerf {
  strategy: string; trades: number; wins: number; losses: number;
  winRate: number; totalPnl: number; avgPnl: number; profitFactor: number;
  expectancy: number; kellyPct: number; bestDte: string; grade: string;
}

interface Playbook {
  dailyBudgetAllocation: { strategy: string; pctOfBudget: number; reasoning: string }[];
  avoidList: { strategy: string; reasoning: string }[];
  topRules: string[];
  estimatedDailyPnl: number;
  confidence: string;
}

interface OptimizerData {
  strategies: StrategyPerf[];
  playbook: Playbook;
  meta: { closedTrades: number; needsMoreData: boolean };
}

const PERIODS = [
  { label: "1W", value: "1W" },
  { label: "1M", value: "1M" },
  { label: "3M", value: "3M" },
  { label: "6M", value: "6M" },
  { label: "1Y", value: "1A" },
  { label: "All", value: "all" },
];

// ============ P&L CALENDAR HEATMAP ============
function PnlCalendar({ dailyPnl }: { dailyPnl: DailyPnl[] }) {
  const pnlMap = new Map(dailyPnl.map((d) => [d.date, d.pnl]));
  const now = new Date();
  const months: { year: number; month: number }[] = [];
  for (let i = 2; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    months.push({ year: d.getFullYear(), month: d.getMonth() });
  }
  const dayNames = ["S", "M", "T", "W", "T", "F", "S"];

  return (
    <div className="space-y-6">
      {months.map(({ year, month }) => {
        const firstDay = new Date(year, month, 1);
        const lastDay = new Date(year, month + 1, 0);
        const startDow = firstDay.getDay();
        const daysInMonth = lastDay.getDate();
        const monthName = firstDay.toLocaleDateString("en-US", { month: "long", year: "numeric" });

        let monthTotal = 0;
        let tradingDays = 0;
        for (let d = 1; d <= daysInMonth; d++) {
          const dateStr = `${year}-${String(month + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
          const pnl = pnlMap.get(dateStr);
          if (pnl !== undefined) { monthTotal += pnl; tradingDays++; }
        }

        const cells: (null | { day: number; pnl: number | undefined; dateStr: string })[] = [];
        for (let i = 0; i < startDow; i++) cells.push(null);
        for (let d = 1; d <= daysInMonth; d++) {
          const dateStr = `${year}-${String(month + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
          cells.push({ day: d, pnl: pnlMap.get(dateStr), dateStr });
        }
        while (cells.length % 7 !== 0) cells.push(null);

        return (
          <div key={`${year}-${month}`}>
            <div className="flex items-center justify-between mb-2">
              <h3 className="text-sm font-medium">{monthName}</h3>
              <div className="flex items-center gap-3 text-xs">
                <span className="text-muted-foreground">{tradingDays} days</span>
                <span className={`font-bold ${monthTotal > 0 ? "text-emerald-400" : monthTotal < 0 ? "text-red-400" : "text-muted-foreground"}`}>
                  {monthTotal >= 0 ? "+" : "-"}${Math.abs(Math.round(monthTotal)).toLocaleString()}
                </span>
              </div>
            </div>
            <div className="grid grid-cols-7 gap-1 mb-1">
              {dayNames.map((d, i) => (
                <div key={i} className="text-center text-[10px] text-muted-foreground/50 font-medium">{d}</div>
              ))}
            </div>
            <div className="grid grid-cols-7 gap-1">
              {cells.map((cell, i) => {
                if (!cell) return <div key={i} className="aspect-square" />;
                const hasTrade = cell.pnl !== undefined;
                const isToday = cell.dateStr === now.toISOString().split("T")[0];
                return (
                  <div key={i} className={`aspect-square rounded-md flex flex-col items-center justify-center relative group cursor-default
                    ${hasTrade ? cell.pnl! > 0 ? "bg-emerald-500/20 hover:bg-emerald-500/30" : cell.pnl! < 0 ? "bg-red-500/20 hover:bg-red-500/30" : "bg-white/5" : "bg-white/[0.02]"}
                    ${isToday ? "ring-1 ring-blue-400/50" : ""}`}>
                    <span className={`text-[10px] ${hasTrade ? "font-medium" : "text-muted-foreground/30"}`}>{cell.day}</span>
                    {hasTrade && (
                      <span className={`text-[8px] font-bold ${cell.pnl! > 0 ? "text-emerald-400" : cell.pnl! < 0 ? "text-red-400" : "text-muted-foreground"}`}>
                        {cell.pnl! >= 0 ? "+" : ""}{Math.abs(cell.pnl!) >= 1000 ? `${(cell.pnl! / 1000).toFixed(1)}k` : Math.round(cell.pnl!)}
                      </span>
                    )}
                    {hasTrade && (
                      <div className="absolute -top-10 left-1/2 -translate-x-1/2 bg-card border border-border rounded-lg px-2 py-1 text-[10px] whitespace-nowrap hidden group-hover:block z-20 shadow-lg">
                        <div className="text-muted-foreground">{new Date(cell.dateStr + "T12:00:00").toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" })}</div>
                        <div className={`font-bold ${cell.pnl! > 0 ? "text-emerald-400" : "text-red-400"}`}>
                          {cell.pnl! >= 0 ? "+" : "-"}${Math.abs(cell.pnl!).toLocaleString()}
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        );
      })}
      <div className="flex items-center gap-4 text-[10px] text-muted-foreground">
        <div className="flex items-center gap-1"><div className="w-3 h-3 rounded bg-emerald-500/20" /><span>Profit</span></div>
        <div className="flex items-center gap-1"><div className="w-3 h-3 rounded bg-red-500/20" /><span>Loss</span></div>
        <div className="flex items-center gap-1"><div className="w-3 h-3 rounded ring-1 ring-blue-400/50" /><span>Today</span></div>
      </div>
    </div>
  );
}

function gradeColor(grade: string) {
  if (grade === "A+" || grade === "A") return "text-emerald-400 bg-emerald-500/15";
  if (grade === "B") return "text-blue-400 bg-blue-500/15";
  if (grade === "C") return "text-yellow-400 bg-yellow-500/15";
  return "text-red-400 bg-red-500/15";
}

export default function AnalyticsPage() {
  const { data: account } = useAccount();
  const { data: positions } = usePositions();
  const [history, setHistory] = useState<PortfolioHistory | null>(null);
  const [activities, setActivities] = useState<Activity[]>([]);
  const [tradeData, setTradeData] = useState<TradeAnalysis | null>(null);
  const [optimizer, setOptimizer] = useState<OptimizerData | null>(null);
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
      .then((data) => { if (Array.isArray(data)) setActivities(data); });
    fetch("/api/trades/analysis").then((r) => r.json()).then(setTradeData).catch(() => {});
    fetch("/api/strategy-optimizer").then((r) => r.json()).then(setOptimizer).catch(() => {});
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
      <div><h1 className="text-xl font-bold tracking-tight">Analytics</h1><p className="text-[11px] text-muted-foreground/50">Aggregate P<h2 className="text-2xl font-bold tracking-tight">P&L Analytics</h2>L analysis and performance breakdown</p></div>

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

      {/* Tabs */}
      <Tabs defaultValue="calendar">
        <TabsList>
          <TabsTrigger value="calendar">P&L Calendar</TabsTrigger>
          <TabsTrigger value="optimizer">Strategy Optimizer</TabsTrigger>
          <TabsTrigger value="positions">Position P&L</TabsTrigger>
          <TabsTrigger value="trades">Trade History</TabsTrigger>
        </TabsList>

        {/* P&L Calendar Heatmap */}
        <TabsContent value="calendar">
          <div className="space-y-4">
            <Card>
              <CardHeader><CardTitle>P&L Calendar</CardTitle></CardHeader>
              <CardContent>
                {tradeData ? <PnlCalendar dailyPnl={tradeData.dailyPnl} /> : <p className="text-sm text-muted-foreground">Loading...</p>}
              </CardContent>
            </Card>
            {tradeData && tradeData.monthlyPnl.length > 0 && (
              <div className="grid md:grid-cols-3 gap-3">
                {tradeData.monthlyPnl.map((m) => (
                  <Card key={m.month}>
                    <CardContent className="pt-4 pb-3">
                      <p className="text-[10px] text-muted-foreground/60 uppercase tracking-wider">{m.month}</p>
                      <p className={`text-2xl font-bold mt-1 ${m.pnl > 0 ? "text-emerald-400" : m.pnl < 0 ? "text-red-400" : ""}`}>
                        {m.pnl >= 0 ? "+" : "-"}${Math.abs(m.pnl).toLocaleString()}
                      </p>
                    </CardContent>
                  </Card>
                ))}
              </div>
            )}
          </div>
        </TabsContent>

        {/* Strategy Optimizer */}
        <TabsContent value="optimizer">
          <div className="space-y-4">
            {optimizer && (
              <>
                {/* Optimal Playbook */}
                <Card className="border-2 border-blue-500/20">
                  <CardHeader>
                    <CardTitle>Optimal Daily Playbook</CardTitle>
                    <p className="text-xs text-muted-foreground">
                      Based on {optimizer.meta.closedTrades} closed trades | Confidence: {optimizer.playbook.confidence}
                    </p>
                  </CardHeader>
                  <CardContent className="space-y-4">
                    <div>
                      <p className="text-xs font-medium text-muted-foreground mb-2">Budget Allocation</p>
                      <div className="space-y-2">
                        {optimizer.playbook.dailyBudgetAllocation.map((a, i) => (
                          <div key={i} className="flex items-center gap-3">
                            <div className="w-12 text-right text-sm font-bold text-blue-400">{a.pctOfBudget}%</div>
                            <div className="flex-1">
                              <div className="h-2 bg-white/5 rounded-full overflow-hidden">
                                <div className="h-full bg-blue-500/50 rounded-full" style={{ width: `${a.pctOfBudget}%` }} />
                              </div>
                            </div>
                            <div className="w-56 text-xs font-medium">{a.strategy}</div>
                          </div>
                        ))}
                      </div>
                    </div>

                    <div>
                      <p className="text-xs font-medium text-muted-foreground mb-2">Rules From Your Data</p>
                      <div className="space-y-1.5">
                        {optimizer.playbook.topRules.map((rule, i) => (
                          <div key={i} className="flex items-start gap-2 text-xs">
                            <span className="text-blue-400 mt-0.5 shrink-0">{i + 1}.</span>
                            <span>{rule}</span>
                          </div>
                        ))}
                      </div>
                    </div>

                    {optimizer.playbook.avoidList.length > 0 && (
                      <div>
                        <p className="text-xs font-medium text-red-400 mb-2">Avoid These</p>
                        {optimizer.playbook.avoidList.map((a, i) => (
                          <div key={i} className="text-xs text-red-400/80">{a.strategy} — {a.reasoning}</div>
                        ))}
                      </div>
                    )}
                  </CardContent>
                </Card>

                {/* Strategy Report Card */}
                <Card>
                  <CardHeader>
                    <CardTitle>Strategy Report Card</CardTitle>
                    <p className="text-xs text-muted-foreground">Every strategy graded by actual performance</p>
                  </CardHeader>
                  <CardContent>
                    <div className="overflow-x-auto">
                      <table className="w-full text-xs">
                        <thead>
                          <tr className="text-muted-foreground/60 border-b border-white/10">
                            <th className="text-left py-2.5 font-medium">Strategy</th>
                            <th className="text-center py-2.5 font-medium">Grade</th>
                            <th className="text-right py-2.5 font-medium">Trades</th>
                            <th className="text-right py-2.5 font-medium">Win Rate</th>
                            <th className="text-right py-2.5 font-medium">Total P&L</th>
                            <th className="text-right py-2.5 font-medium">Avg P&L</th>
                            <th className="text-right py-2.5 font-medium">PF</th>
                            <th className="text-right py-2.5 font-medium">Kelly %</th>
                            <th className="text-right py-2.5 font-medium">Best DTE</th>
                          </tr>
                        </thead>
                        <tbody>
                          {optimizer.strategies
                            .filter((s) => !["Stop Loss", "Take Profit", "Trailing Stop", "Dead Money Exit", "Breakeven Stop", "Roll Forward", "Expiry Close", "Thesis Change", "Partial Profit", "Premium Defense"].includes(s.strategy))
                            .map((s, i) => (
                              <tr key={i} className="border-b border-white/[0.04] hover:bg-white/[0.02]">
                                <td className="py-2.5 font-medium">{s.strategy}</td>
                                <td className="py-2.5 text-center">
                                  <span className={`px-2 py-0.5 rounded text-[10px] font-bold ${gradeColor(s.grade)}`}>{s.grade}</span>
                                </td>
                                <td className="py-2.5 text-right">{s.trades}</td>
                                <td className="py-2.5 text-right">{s.winRate}%</td>
                                <td className={`py-2.5 text-right font-bold ${s.totalPnl > 0 ? "text-emerald-400" : s.totalPnl < 0 ? "text-red-400" : ""}`}>
                                  {s.totalPnl >= 0 ? "+" : "-"}${Math.abs(s.totalPnl).toLocaleString()}
                                </td>
                                <td className={`py-2.5 text-right ${s.avgPnl > 0 ? "text-emerald-400" : s.avgPnl < 0 ? "text-red-400" : ""}`}>
                                  {s.avgPnl >= 0 ? "+" : "-"}${Math.abs(s.avgPnl).toLocaleString()}
                                </td>
                                <td className="py-2.5 text-right">{s.profitFactor}x</td>
                                <td className="py-2.5 text-right">{s.kellyPct}%</td>
                                <td className="py-2.5 text-right text-muted-foreground">{s.bestDte}</td>
                              </tr>
                            ))}
                        </tbody>
                      </table>
                    </div>
                    {optimizer.meta.needsMoreData && (
                      <div className="mt-4 p-3 rounded-lg bg-yellow-500/10 border border-yellow-500/20 text-xs text-yellow-400">
                        Need 20+ closed trades for reliable optimization. Currently: {optimizer.meta.closedTrades}. Grades improve as data accumulates.
                      </div>
                    )}
                  </CardContent>
                </Card>
              </>
            )}
            {!optimizer && <p className="text-sm text-muted-foreground">Loading optimizer...</p>}
          </div>
        </TabsContent>

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
