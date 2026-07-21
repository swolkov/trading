"use client";

import { useEffect, useState, useCallback } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

interface AgentConfig {
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

interface TradingModes {
  modes: Record<string, string>;
  hasLiveKeys: Record<string, boolean>;
}

function pnlColor(val: number) {
  return val > 0 ? "text-emerald-500" : val < 0 ? "text-red-500" : "text-muted-foreground";
}

const CONFIG_GROUPS = [
  {
    label: "Futures — DEMO ($50K paper) · RESEARCH LAB (P&L is not proof)",
    modeKey: "futures_mode",
    modeLabelMap: { disabled: "Disabled", demo: "Demo — 24/7 Learning", live: "Live — RTH Mirror" } as Record<string, string>,
    icon: "D",
    color: "from-emerald-500 to-teal-500",
    fields: [
      { key: "futures_mode", label: "Futures Mode", type: "select" as const, options: ["disabled", "demo", "live"] },
      { key: "futures_risk_per_trade_pct", label: "Risk Per Trade %", type: "number" as const },
      { key: "futures_daily_loss_limit_pct", label: "Daily Loss Limit %", type: "number" as const },
      { key: "futures_max_drawdown_pct", label: "Max Drawdown Kill %", type: "number" as const },
      { key: "futures_max_contracts", label: "Max Contracts / Trade", type: "number" as const },
      { key: "futures_max_total_contracts", label: "Max Total Contracts", type: "number" as const },
      { key: "futures_max_trades_per_day", label: "Max Trades / Day", type: "number" as const },
      { key: "futures_atr_stop_multiplier", label: "ATR Stop Multiplier", type: "number" as const },
      { key: "futures_atr_target_multiplier", label: "ATR Target Multiplier", type: "number" as const },
      { key: "futures_simulated_equity", label: "Simulated Equity ($, 0=actual)", type: "number" as const },
    ],
  },
  {
    label: "Futures — LIVE ($1K real money) · validating execution, not proven alpha",
    icon: "L",
    color: "from-red-500 to-rose-500",
    fields: [
      { key: "live_futures_symbols", label: "Symbol Whitelist (blank = MGC,MNQ,MES)", type: "text" as const, placeholder: "MGC,MNQ,MES" },
      { key: "live_futures_risk_per_trade_pct", label: "Risk Per Trade %", type: "number" as const },
      { key: "live_futures_daily_loss_limit_pct", label: "Daily Loss Limit %", type: "number" as const },
      { key: "live_futures_max_drawdown_pct", label: "Max Drawdown Kill %", type: "number" as const },
      { key: "live_futures_max_contracts", label: "Max Contracts / Trade", type: "number" as const },
      { key: "live_futures_max_total_contracts", label: "Max Total Contracts", type: "number" as const },
      { key: "live_futures_max_trades_per_day", label: "Max Trades / Day", type: "number" as const },
      { key: "live_futures_max_positions", label: "Max Concurrent Positions", type: "number" as const },
      { key: "live_futures_atr_stop_multiplier", label: "ATR Stop Multiplier", type: "number" as const },
      { key: "live_futures_atr_target_multiplier", label: "ATR Target Multiplier", type: "number" as const },
    ],
  },
  {
    label: "Live Mirror (RTH Only)",
    icon: "L",
    color: "from-red-500 to-rose-500",
    fields: [
      { key: "max_positions", label: "Max Open Positions", type: "number" as const },
      { key: "drawdown_kill_pct", label: "Drawdown Kill (%)", type: "number" as const },
    ],
  },
] as { label: string; modeKey?: string; modeLabelMap?: Record<string, string>; icon: string; color: string; fields: { key: string; label: string; type: "number" | "select" | "text" | "toggle"; options?: string[]; placeholder?: string }[] }[];

export default function AgentHubPage() {
  const [config, setConfig] = useState<AgentConfig | null>(null);
  const [editConfig, setEditConfig] = useState<AgentConfig>({});
  const [activity, setActivity] = useState<Activity[]>([]);
  const [runResult, setRunResult] = useState<AgentRun | null>(null);
  const [futuresStatus, setFuturesStatus] = useState<{ connected: boolean; message?: string; accountName?: string } | null>(null);
  const [tradingModes, setTradingModes] = useState<TradingModes | null>(null);
  const [modePassword, setModePassword] = useState("");
  const [modeMessage, setModeMessage] = useState("");
  const [runningAgent, setRunningAgent] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveMessage, setSaveMessage] = useState("");

  const loadData = useCallback(async () => {
    const [configRes, activityRes, futuresRes, modesRes] = await Promise.all([
      fetch("/api/agent/config").then((r) => r.json()).catch(() => null),
      fetch("/api/agent/activity").then((r) => r.json()).catch(() => []),
      fetch("/api/futures").then((r) => r.json()).catch(() => ({ connected: false })),
      fetch("/api/trading-mode").then((r) => r.json()).catch(() => null),
    ]);
    if (configRes) {
      setConfig(configRes);
      setEditConfig(configRes);
    }
    if (Array.isArray(activityRes)) setActivity(activityRes);
    if (futuresRes) setFuturesStatus(futuresRes);
    if (modesRes) setTradingModes(modesRes);
  }, []);

  useEffect(() => {
    loadData();
    const interval = setInterval(loadData, 60000);
    return () => clearInterval(interval);
  }, [loadData]);

  const switchMode = async (type: string, mode: string) => {
    if (!modePassword) { setModeMessage("Enter password first"); return; }
    setModeMessage("");
    try {
      const res = await fetch("/api/trading-mode", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type, mode, password: modePassword }),
      });
      const data = await res.json();
      if (data.error) { setModeMessage(data.error); return; }
      setModeMessage(data.message);
      loadData();
    } catch { setModeMessage("Failed to switch mode"); }
  };

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

  const saveConfig = async () => {
    setSaving(true);
    setSaveMessage("");
    try {
      const changed: Record<string, string> = {};
      for (const [key, value] of Object.entries(editConfig)) {
        if (config && value !== config[key]) changed[key] = value;
      }
      if (Object.keys(changed).length === 0) {
        setSaveMessage("No changes");
        setSaving(false);
        return;
      }
      const res = await fetch("/api/agent/config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(changed),
      });
      const data = await res.json();
      if (data.error) { setSaveMessage(data.error); }
      else { setSaveMessage(`Saved ${Object.keys(changed).length} setting${Object.keys(changed).length > 1 ? "s" : ""}`); loadData(); }
    } catch { setSaveMessage("Failed to save"); }
    setSaving(false);
    setTimeout(() => setSaveMessage(""), 3000);
  };

  const hasChanges = config && Object.entries(editConfig).some(([k, v]) => config[k] !== v);

  const coreAgents = [
    {
      id: "futures",
      name: "Futures Engine",
      desc: "24/5 demo learning — ES, NQ, GC on Tradovate ($50K)",
      schedule: futuresStatus?.connected ? "Real-time 5s (Railway)" : "Waiting",
      endpoint: "/api/futures",
      canRun: futuresStatus?.connected || false,
      status: futuresStatus?.connected ? "active" : "waiting",
    },
    {
      id: "futures-cron",
      name: "Futures Cron (Live)",
      desc: "Fallback execution + live trading when activated",
      schedule: "Every 10m (market hrs)",
      endpoint: "/api/cron/futures",
      canRun: true,
    },
    {
      id: "premarket",
      name: "Pre-Market Briefing",
      desc: "Market regime, VIX, macro outlook, vault brain update",
      schedule: "9:00 AM ET",
      endpoint: "/api/cron/premarket",
      canRun: true,
    },
    {
      id: "review",
      name: "Post-Market Review",
      desc: "EOD summary, paper trade scoring, lesson extraction",
      schedule: "4:30 PM ET",
      endpoint: "/api/cron/review",
      canRun: true,
    },
  ];

  const supportAgents = [
    {
      id: "synthesis",
      name: "Synthesis",
      desc: "Pattern extraction, lesson updates, anti-patterns from trade history",
      schedule: "3x daily + every 10 trades",
      endpoint: "/api/cron/synthesis",
      canRun: true,
    },
    {
      id: "watchdog",
      name: "Watchdog",
      desc: "System health, heartbeat checks, cron staleness, position reconciliation",
      schedule: "Every 5m (24/7)",
      endpoint: "/api/cron/watchdog",
      canRun: true,
    },
    {
      id: "events",
      name: "Event Catalyst",
      desc: "FOMC, CPI, NFP — auto-reduces sizing around volatility events",
      schedule: "8:00 AM ET daily",
      endpoint: "/api/cron/events",
      canRun: true,
    },
    {
      id: "regime",
      name: "Regime Transition",
      desc: "Bull/Bear/Choppy detection — adjusts strategy sizing multiplier",
      schedule: "4x daily",
      endpoint: "/api/cron/regime-transition",
      canRun: true,
    },
    {
      id: "execution",
      name: "Execution Quality",
      desc: "Fill analysis, slippage tracking, A-F grading per trade",
      schedule: "5:00 PM ET daily",
      endpoint: "/api/cron/execution-review",
      canRun: true,
    },
    {
      id: "walk-forward",
      name: "Walk-Forward Validation",
      desc: "Weekly backtest vs actual — detects edge decay",
      schedule: "Sundays",
      endpoint: "/api/cron/walk-forward",
      canRun: true,
    },
  ];

  const brokers = [
    {
      name: "Tradovate",
      types: ["futures"] as const,
      desc: "Micro Futures",
      color: "blue",
      extra: futuresStatus?.connected
        ? `Connected: ${futuresStatus.accountName}`
        : "Not connected",
    },
  ];

  return (
    <div className="space-y-5 animate-fade-up">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold">Agent Hub</h1>
          <p className="text-sm text-muted-foreground">
            Command center — agents, brokers, risk controls.{" "}
            <a href="/admin/strategies" className="underline text-emerald-400 hover:text-emerald-300">
              Configure strategies →
            </a>
          </p>
        </div>
        <div className="flex gap-2">
          {hasChanges && (
            <Button onClick={saveConfig} disabled={saving} className="bg-blue-600 hover:bg-blue-700 text-white text-xs">
              {saving ? "Saving..." : "Save Changes"}
            </Button>
          )}
        </div>
      </div>
      {saveMessage && (
        <p className={`text-xs ${saveMessage.includes("Failed") || saveMessage.includes("error") ? "text-red-400" : "text-emerald-400"}`}>
          {saveMessage}
        </p>
      )}

      {/* Row 1: Agents + Brokers */}
      <div className="grid lg:grid-cols-[1fr_340px] gap-4">
        {/* Agent Cards */}
        <div className="space-y-4">
          {/* Core Agents */}
          <div>
            <p className="text-[10px] text-muted-foreground/50 uppercase tracking-widest font-semibold mb-2">Core Agents</p>
            <div className="grid sm:grid-cols-2 xl:grid-cols-3 gap-3">
              {coreAgents.map((agent) => {
                const status = agent.status || "active";
                return (
                  <div key={agent.id} className={`rounded-xl border bg-white/[0.02] p-3.5 space-y-2 ${
                    status === "active" ? "border-emerald-500/20" :
                    status === "waiting" ? "border-yellow-500/20" :
                    "border-red-500/20"
                  }`}>
                    <div className="flex items-center justify-between">
                      <span className="text-xs font-bold">{agent.name}</span>
                      <span className={`text-[9px] px-1.5 py-0.5 rounded-full font-semibold ${
                        status === "active" ? "bg-emerald-500/15 text-emerald-500" :
                        status === "waiting" ? "bg-yellow-500/15 text-yellow-500" :
                        "bg-red-500/15 text-red-500"
                      }`}>
                        {status === "active" && <span className="inline-block w-1 h-1 rounded-full bg-emerald-500 mr-1 animate-pulse" />}
                        {status.toUpperCase()}
                      </span>
                    </div>
                    <p className="text-[10px] text-muted-foreground/60">{agent.desc}</p>
                    <div className="flex items-center justify-between">
                      <span className="text-[9px] text-blue-400 font-medium">{agent.schedule}</span>
                      {agent.canRun && (
                        <Button
                          size="xs"
                          variant="outline"
                          className="text-[9px] h-5 px-2"
                          disabled={runningAgent !== null}
                          onClick={() => runAgent(agent.endpoint, agent.id)}
                        >
                          {runningAgent === agent.id ? "..." : "Run"}
                        </Button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          {/* Support Agents */}
          <div>
            <p className="text-[10px] text-muted-foreground/50 uppercase tracking-widest font-semibold mb-2">Support Agents</p>
            <div className="grid sm:grid-cols-2 xl:grid-cols-4 gap-2">
              {supportAgents.map((agent) => (
                <div key={agent.id} className="rounded-lg border border-white/[0.04] bg-white/[0.01] px-3 py-2 space-y-1">
                  <div className="flex items-center justify-between">
                    <span className="text-[10px] font-bold">{agent.name}</span>
                    <Button
                      size="xs"
                      variant="ghost"
                      className="text-[8px] h-4 px-1.5 text-muted-foreground/50 hover:text-foreground"
                      disabled={runningAgent !== null}
                      onClick={() => runAgent(agent.endpoint, agent.id)}
                    >
                      {runningAgent === agent.id ? "..." : "Run"}
                    </Button>
                  </div>
                  <p className="text-[9px] text-muted-foreground/40">{agent.desc}</p>
                  <span className="text-[8px] text-blue-400/50 font-medium">{agent.schedule}</span>
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* System Mode — Demo always runs. Live is a separate activation. */}
        <div>
          <p className="text-[10px] text-muted-foreground/50 uppercase tracking-widest font-semibold mb-2">Trading Control</p>
          <div className="space-y-3">
            {/* Demo Engine Status */}
            <div className="rounded-xl border border-emerald-500/20 bg-emerald-500/[0.03] p-4 space-y-2">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <span className="relative flex h-2.5 w-2.5">
                    <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75" />
                    <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-emerald-400" />
                  </span>
                  <span className="text-sm font-black text-emerald-400">DEMO ENGINE</span>
                </div>
                <span className="text-[9px] text-emerald-400/60 font-medium">Always running · 24/7 · Learning</span>
              </div>
              <p className="text-[9px] text-muted-foreground/50">Trading on demo account ($50K). Brain evolves from every trade. This never turns off.</p>
            </div>

            {/* Live Trading Activation */}
            <div className={`rounded-xl border p-4 space-y-3 ${
              tradingModes?.modes?.futures === "live"
                ? "border-red-500/20 bg-red-500/[0.03]"
                : "border-white/[0.06] bg-white/[0.02]"
            }`}>
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm font-black">{tradingModes?.modes?.futures === "live" ? "🔴 LIVE TRADING ACTIVE" : "LIVE TRADING"}</p>
                  <p className="text-[9px] text-muted-foreground/50 mt-0.5">
                    {tradingModes?.modes?.futures === "live"
                      ? "Real money at risk — Tradovate live account"
                      : "Activate to trade your real $1K account (proven windows only)"}
                  </p>
                </div>
                <button
                  disabled={!modePassword}
                  onClick={async () => {
                    if (!modePassword) return;
                    setModeMessage("");
                    const newMode = tradingModes?.modes?.futures === "live" ? "paper" : "live";
                    const res = await fetch("/api/trading-mode", {
                      method: "POST",
                      headers: { "Content-Type": "application/json" },
                      body: JSON.stringify({ type: "futures", mode: newMode, password: modePassword }),
                    });
                    const data = await res.json();
                    if (data.error) { setModeMessage(data.error); return; }
                    setModeMessage(newMode === "live" ? "LIVE TRADING ACTIVATED" : "Live trading deactivated — demo continues");
                    loadData();
                  }}
                  className={`px-4 py-2 rounded-lg text-xs font-bold uppercase transition-all ${
                    tradingModes?.modes?.futures === "live"
                      ? "bg-red-500/20 text-red-400 ring-1 ring-red-500/30 hover:bg-red-500/30"
                      : "bg-white/[0.06] text-muted-foreground/60 ring-1 ring-white/[0.08] hover:bg-white/[0.1] hover:text-foreground disabled:opacity-30"
                  }`}
                >
                  {tradingModes?.modes?.futures === "live" ? "DEACTIVATE" : "ACTIVATE"}
                </button>
              </div>

              {tradingModes?.modes?.futures === "live" && (
                <div className="flex items-center gap-2 text-[9px] text-red-400/70">
                  <span className="animate-pulse">●</span>
                  <span>Cron agent executing on live.tradovateapi.com during proven windows (9:45-11:30, 2:00-3:45 ET)</span>
                </div>
              )}
            </div>

            {/* Password */}
            <div className="flex items-center gap-2">
              <input
                type="password"
                placeholder="Password to control live trading"
                value={modePassword}
                onChange={(e) => setModePassword(e.target.value)}
                className="flex-1 bg-white/[0.04] border border-white/[0.06] rounded-lg px-3 py-1.5 text-[10px] placeholder:text-muted-foreground/30 focus:outline-none focus:ring-1 focus:ring-primary/30"
              />
              {modePassword && <span className="text-[9px] text-emerald-400/60">●</span>}
            </div>
            {modeMessage && (
              <p className={`text-[10px] font-semibold ${modeMessage.includes("ACTIVATED") || modeMessage.includes("LIVE") ? "text-red-400" : "text-emerald-400"}`}>
                {modeMessage}
              </p>
            )}
          </div>
        </div>
      </div>

      {/* Row 2: Config Settings */}
      <div>
        <p className="text-[10px] text-muted-foreground/50 uppercase tracking-widest font-semibold mb-2">Configuration</p>
        <div className="grid sm:grid-cols-2 xl:grid-cols-4 gap-3">
          {CONFIG_GROUPS.map((group) => (
            <div key={group.label} className="rounded-xl border border-white/[0.06] bg-white/[0.02] p-3.5 space-y-3">
              <div className="flex items-center gap-2">
                <div className={`w-5 h-5 rounded-md bg-gradient-to-br ${group.color} flex items-center justify-center`}>
                  <span className="text-[9px] text-white font-black">{group.icon}</span>
                </div>
                <span className="text-xs font-bold">
                  {group.label}
                  {group.modeKey && config?.[group.modeKey] && (
                    <span className="text-[9px] text-muted-foreground/50 font-normal ml-1">
                      ({group.modeLabelMap?.[config[group.modeKey]] ?? config[group.modeKey]})
                    </span>
                  )}
                </span>
              </div>
              <div className="space-y-2">
                {group.fields.map((field) => {
                  const value = editConfig[field.key] ?? "";
                  const changed = config && value !== config[field.key];
                  return (
                    <div key={field.key} className="flex items-center justify-between gap-2">
                      <label className="text-[10px] text-muted-foreground/70 shrink-0">{field.label}</label>
                      {field.type === "toggle" ? (
                        <button
                          onClick={() => setEditConfig({ ...editConfig, [field.key]: value === "true" ? "false" : "true" })}
                          className={`w-8 h-4 rounded-full transition-all relative ${
                            value === "true" ? "bg-emerald-500/40" : "bg-white/[0.08]"
                          } ${changed ? "ring-1 ring-blue-400/50" : ""}`}
                        >
                          <span className={`absolute top-0.5 w-3 h-3 rounded-full transition-all ${
                            value === "true" ? "left-4 bg-emerald-400" : "left-0.5 bg-muted-foreground/40"
                          }`} />
                        </button>
                      ) : field.type === "select" ? (
                        <select
                          value={value}
                          onChange={(e) => setEditConfig({ ...editConfig, [field.key]: e.target.value })}
                          className={`bg-white/[0.04] border border-white/[0.06] rounded px-1.5 py-0.5 text-[10px] text-right max-w-[100px] focus:outline-none focus:ring-1 focus:ring-primary/30 ${changed ? "ring-1 ring-blue-400/50" : ""}`}
                        >
                          {field.options?.map((opt) => (
                            <option key={opt} value={opt} className="bg-[#1a1a2e]">{opt}</option>
                          ))}
                        </select>
                      ) : field.type === "text" ? (
                        <input
                          type="text"
                          value={value}
                          placeholder={field.placeholder}
                          onChange={(e) => setEditConfig({ ...editConfig, [field.key]: e.target.value })}
                          className={`bg-white/[0.04] border border-white/[0.06] rounded px-1.5 py-0.5 text-[10px] text-right max-w-[120px] placeholder:text-muted-foreground/20 focus:outline-none focus:ring-1 focus:ring-primary/30 ${changed ? "ring-1 ring-blue-400/50" : ""}`}
                        />
                      ) : (
                        <input
                          type="number"
                          value={value}
                          onChange={(e) => setEditConfig({ ...editConfig, [field.key]: e.target.value })}
                          className={`bg-white/[0.04] border border-white/[0.06] rounded px-1.5 py-0.5 text-[10px] text-right w-16 tabular-nums focus:outline-none focus:ring-1 focus:ring-primary/30 ${changed ? "ring-1 ring-blue-400/50" : ""}`}
                        />
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Row 3: Activity + Output */}
      <Tabs defaultValue="activity">
        <TabsList>
          <TabsTrigger value="activity">Live Activity</TabsTrigger>
          <TabsTrigger value="output">Last Run</TabsTrigger>
        </TabsList>

        <TabsContent value="activity">
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm flex items-center gap-2">
                <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
                Live Activity (24h)
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="space-y-1.5 max-h-72 overflow-y-auto">
                {activity.length === 0 && <p className="text-xs text-muted-foreground">No recent activity</p>}
                {activity.slice(0, 40).map((a, i) => (
                  <div key={i} className={`flex items-start gap-3 text-xs border-l-2 pl-3 py-1 ${
                    a.type === "success" ? "border-emerald-500" :
                    a.type === "loss" ? "border-red-500" :
                    a.type === "trade" ? "border-blue-500" :
                    "border-muted"
                  }`}>
                    <span className="text-muted-foreground/50 whitespace-nowrap min-w-[52px] text-[10px]">
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
                            a.action.includes("paper") ? "text-yellow-500" :
                            "text-muted-foreground"
                          }`}>
                            {a.action.replace(/_/g, " ").toUpperCase()}
                          </span>
                          {a.symbol && <span className="ml-1 font-bold">{a.symbol}</span>}
                          {a.qty > 0 && <span className="text-muted-foreground ml-1">{a.qty}x</span>}
                          {a.pnl != null && (
                            <span className={`ml-2 font-medium ${pnlColor(a.pnl)}`}>
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
                        d.includes("PAPER") ? "text-yellow-500 font-medium" :
                        d.includes("MACRO") ? "text-purple-600" :
                        ""
                      }>{d}</div>
                    ))}
                  </div>
                </div>
              ) : (
                <p className="text-xs text-muted-foreground">Run an agent to see output here</p>
              )}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}
