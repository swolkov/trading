"use client";

import { useEffect, useState, useCallback } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

interface AgentConfig {
  enabled: string;
  strategy: string;
  min_score: string;
  min_confidence: string;
  trade_options: string;
  [key: string]: string;
}

interface Activity {
  type: string;
  symbol: string;
  action: string;
  qty: number;
  price: number | null;
  pnl: number | null;
  reason: string;
  score: number | null;
  time: string;
}

interface AgentRun {
  summary: string;
  tradesPlaced: number;
  stocksScanned: number;
  positionsManaged: number;
  details: string[];
}

function pnl(val: number) {
  return val > 0 ? "text-emerald-500" : val < 0 ? "text-red-500" : "text-muted-foreground";
}

export default function AgentHubPage() {
  const [config, setConfig] = useState<AgentConfig | null>(null);
  const [activity, setActivity] = useState<Activity[]>([]);
  const [running, setRunning] = useState(false);
  const [runResult, setRunResult] = useState<AgentRun | null>(null);
  const [futuresStatus, setFuturesStatus] = useState<{ connected: boolean; message?: string } | null>(null);

  const loadData = useCallback(async () => {
    const [configRes, activityRes, futuresRes] = await Promise.all([
      fetch("/api/agent/config").then((r) => r.json()).catch(() => null),
      fetch("/api/agent/activity").then((r) => r.json()).catch(() => []),
      fetch("/api/futures").then((r) => r.json()).catch(() => ({ connected: false })),
    ]);
    if (configRes) setConfig(configRes);
    if (Array.isArray(activityRes)) setActivity(activityRes);
    if (futuresRes) setFuturesStatus(futuresRes);
  }, []);

  useEffect(() => {
    loadData();
    const interval = setInterval(loadData, 60000);
    return () => clearInterval(interval);
  }, [loadData]);

  const [runningAgent, setRunningAgent] = useState<string | null>(null);

  const runAgent = async (endpoint: string, agentId: string) => {
    setRunningAgent(agentId);
    try {
      const res = await fetch(endpoint, { method: "POST" });
      const data = await res.json();
      setRunResult(data);
    } catch { /* ignore */ }
    setRunningAgent(null);
    loadData();
  };

  const agents = [
    {
      id: "premarket",
      name: "Pre-Market Research",
      description: "Scans overnight news, sector health, gap alerts on held positions",
      status: "active",
      schedule: "9:00 AM ET (before open)",
      strategy: "News analysis, sector scanning, gap detection, morning briefing",
      details: [
        "Overnight news for focus symbols",
        "Sector breakout/weakness detection",
        "Gap alerts on existing positions",
        "Sends morning briefing notification",
      ],
      endpoint: "/api/cron/premarket",
      canRun: true,
    },
    {
      id: "trading",
      name: "Trading Agent",
      description: "Full scan — finds new trades, AI analysis, executes buys/sells",
      status: config?.enabled === "true" ? "active" : "paused",
      schedule: "Every 30 min during market hours (16x/day)",
      strategy: "Premium Selling + Sector Breakouts + Quick Plays + High Conviction",
      details: [
        `Min Score: ${config?.min_score || "55"}`,
        `Strategy: ${config?.strategy || "balanced"}`,
        "Iron condors, credit spreads, directional calls/puts",
        "Sector scanner, relative value, gap plays",
        "5-expert AI committee with adversarial review",
      ],
      endpoint: "/api/cron/trade",
      canRun: true,
    },
    {
      id: "monitor",
      name: "Position Monitor",
      description: "Watches positions for stops, profits, premium defense",
      status: "active",
      schedule: "Every 15 min during market hours (36x/day)",
      strategy: "Stop losses, partial profits, breakeven stops, premium defense, dead money",
      details: [
        "Spread-aware management (never splits legs)",
        "Partial profit-taking (+30% sell half)",
        "Breakeven stop after partial take",
        "Premium defense: roll tested strikes",
        "Dead money exits (>7d, <10% move)",
      ],
      endpoint: "/api/cron/monitor",
      canRun: true,
    },
    {
      id: "review",
      name: "Post-Market Review",
      description: "End-of-day summary, learning engine update, performance report",
      status: "active",
      schedule: "4:30 PM ET (after close)",
      strategy: "Daily P&L review, lesson extraction, performance notification",
      details: [
        "Daily win/loss summary",
        "Updates learning engine",
        "Extracts patterns from trades",
        "Sends EOD notification",
      ],
      endpoint: "/api/cron/review",
      canRun: true,
    },
    {
      id: "futures",
      name: "Futures Agent",
      description: "Micro E-mini futures (MES, MNQ, MYM, M2K) via IBKR",
      status: futuresStatus?.connected ? "active" : "waiting",
      schedule: "TBD — waiting for IBKR connection",
      strategy: "EMA crossover + RSI + VWAP + AI confirmation",
      details: [
        futuresStatus?.connected ? "IBKR Connected" : "Waiting for IBKR",
        "Contracts: MES, MNQ, MYM, M2K",
        "Risk: $200 max per trade",
      ],
      endpoint: "/api/futures/trade",
      canRun: futuresStatus?.connected || false,
    },
  ];

  return (
    <div className="space-y-6 animate-fade-up">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Agent Hub</h1>
          <p className="text-sm text-muted-foreground">All AI agents in one place — status, controls, activity</p>
        </div>
        <Button onClick={() => runAgent("/api/cron/trade", "trading")} disabled={runningAgent !== null} className="bg-emerald-600 hover:bg-emerald-700 text-white">
          {runningAgent === "trading" ? "Running..." : "Run Trading Agent"}
        </Button>
      </div>

      {/* Agent Cards */}
      <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-4">
        {agents.map((agent) => (
          <Card key={agent.id} className={`relative overflow-hidden ${agent.status === "active" ? "border-emerald-500/20" : agent.status === "waiting" ? "border-yellow-500/20" : "border-red-500/20"}`}>
            <CardHeader className="pb-2">
              <div className="flex items-center justify-between">
                <CardTitle className="text-sm font-bold">{agent.name}</CardTitle>
                <span className={`text-[10px] px-2 py-0.5 rounded-full font-medium ${
                  agent.status === "active" ? "bg-emerald-500/15 text-emerald-600" :
                  agent.status === "waiting" ? "bg-yellow-500/15 text-yellow-600" :
                  "bg-red-500/15 text-red-600"
                }`}>
                  {agent.status.toUpperCase()}
                </span>
              </div>
              <p className="text-[11px] text-muted-foreground">{agent.description}</p>
            </CardHeader>
            <CardContent className="space-y-2">
              <p className="text-[10px] text-blue-400 font-medium">{agent.schedule}</p>
              <p className="text-[10px] text-muted-foreground/60 uppercase tracking-wider">Strategy</p>
              <p className="text-xs">{agent.strategy}</p>
              <div className="space-y-1 mt-2">
                {agent.details.map((d, i) => (
                  <p key={i} className="text-[11px] text-muted-foreground">{d}</p>
                ))}
              </div>
              {agent.canRun && (
                <Button
                  size="sm"
                  variant="outline"
                  className="w-full mt-2 text-xs"
                  disabled={runningAgent !== null}
                  onClick={() => runAgent(agent.endpoint, agent.id)}
                >
                  {runningAgent === agent.id ? "Running..." : `Run ${agent.name}`}
                </Button>
              )}
            </CardContent>
          </Card>
        ))}
      </div>

      <Tabs defaultValue="activity">
        <TabsList>
          <TabsTrigger value="activity">Live Activity</TabsTrigger>
          <TabsTrigger value="output">Last Run Output</TabsTrigger>
          <TabsTrigger value="lessons">Permanent Lessons</TabsTrigger>
        </TabsList>

        <TabsContent value="activity">
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm flex items-center gap-2">
                <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
                Live Activity (Last 24h) — Auto-refreshes every 60s
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="space-y-2 max-h-96 overflow-y-auto">
                {activity.length === 0 && <p className="text-xs text-muted-foreground">No recent activity</p>}
                {activity.slice(0, 30).map((a, i) => (
                  <div key={i} className={`flex items-start gap-3 text-xs border-l-2 pl-3 py-1 ${
                    a.type === "success" ? "border-emerald-500" :
                    a.type === "loss" ? "border-red-500" :
                    a.type === "trade" ? "border-blue-500" :
                    "border-muted"
                  }`}>
                    <span className="text-muted-foreground/50 whitespace-nowrap min-w-[60px]">
                      {new Date(a.time).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                    </span>
                    <div className="flex-1">
                      {a.type === "run" ? (
                        <span className="text-muted-foreground">{a.reason}</span>
                      ) : (
                        <div>
                          <span className={`font-medium ${
                            a.action.includes("buy") ? "text-emerald-600" :
                            a.action.includes("sell") || a.action.includes("stop") ? "text-red-600" :
                            "text-muted-foreground"
                          }`}>
                            {a.action.replace(/_/g, " ").toUpperCase()}
                          </span>
                          {a.symbol && <span className="ml-1 font-bold">{a.symbol}</span>}
                          {a.qty > 0 && <span className="text-muted-foreground ml-1">{a.qty}x</span>}
                          {a.pnl != null && (
                            <span className={`ml-2 font-medium ${pnl(a.pnl)}`}>
                              P&L: ${a.pnl.toFixed(0)}
                            </span>
                          )}
                        </div>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="output">
          <Card>
            <CardHeader>
              <CardTitle className="text-sm">Last Agent Run Output</CardTitle>
            </CardHeader>
            <CardContent>
              {runResult ? (
                <div className="space-y-2">
                  <p className="text-sm font-medium">{runResult.summary}</p>
                  <p className="text-xs text-muted-foreground">
                    Scanned: {runResult.stocksScanned} | Trades: {runResult.tradesPlaced} | Managed: {runResult.positionsManaged}
                  </p>
                  <div className="bg-muted/50 rounded-lg p-3 max-h-80 overflow-y-auto font-mono text-[11px] space-y-0.5">
                    {runResult.details.map((d, i) => (
                      <div key={i} className={
                        d.includes("BUY") || d.includes("Bought") ? "text-emerald-600 font-medium" :
                        d.includes("STOP") || d.includes("LOSS") ? "text-red-600" :
                        d.includes("PREMIUM") || d.includes("QUICK") ? "text-blue-600 font-medium" :
                        d.includes("MACRO") ? "text-purple-600" :
                        ""
                      }>{d}</div>
                    ))}
                  </div>
                </div>
              ) : (
                <p className="text-xs text-muted-foreground">Click "Run Options Agent" to see output</p>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="lessons">
          <Card>
            <CardHeader>
              <CardTitle className="text-sm">What The Agent Has Learned</CardTitle>
              <p className="text-xs text-muted-foreground">Permanent rules from our first week of trading — never forgotten</p>
            </CardHeader>
            <CardContent>
              <div className="space-y-3">
                {[
                  "NEVER buy naked options in a choppy market — theta decay kills you. Only sell premium via credit spreads and iron condors.",
                  "Premium selling made +$2,517. Directional buying lost -$9,906. Sell premium is the edge.",
                  "TSLA short put was our best trade (+$1,145). Stock staying flat = profit when you sell premium.",
                  "Spreads that were too wide ($10) risked too much. Keep spreads $2.50-$5 wide, scale with account size.",
                  "PDT restriction locked us out for days. NEVER open and close positions same day. Hold overnight minimum.",
                  "Penny stock options went to zero instantly. Minimum $20 stock price for any trade.",
                  "The AI committee scores everything bearish in choppy markets. Don't fight this — sell premium instead.",
                  "Focus on 65-70% probability trades. Win rate matters more than win size.",
                ].map((lesson, i) => (
                  <div key={i} className="flex gap-3 text-xs">
                    <span className="text-emerald-500 font-bold shrink-0">{i + 1}.</span>
                    <span>{lesson}</span>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}
