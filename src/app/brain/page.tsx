"use client";

import { useEffect, useState, useCallback } from "react";
import useSWR from "swr";

const fetcher = (url: string) => fetch(url).then((r) => r.json());

// ============================================================
// J.A.R.V.I.S. BRAIN — Unified Trading Intelligence Center
// ============================================================

interface BrainState {
  regime: { trend: string; vix: string; classification: string; lastUpdated: string | null };
  volatility: { environment: string; lastUpdated: string | null };
  macro: { summary: string | null; lastUpdated: string | null };
  crypto: { regime: string; lastUpdated: string | null };
}

interface AgentStatus {
  id: string;
  name: string;
  type: "core" | "support";
  heartbeat: string | null;
  mode: string;
  icon: string;
}

interface Task {
  priority: "high" | "medium" | "low";
  label: string;
  context: string;
}

interface ActivityItem {
  type: string;
  text: string;
  detail: string;
  time: string;
}

interface BrainData {
  brain: BrainState;
  agents: AgentStatus[];
  tasks: Task[];
  activity: ActivityItem[];
  lessons: string[];
  stats: {
    todayPnl: number;
    todayTradeCount: number;
    drawdownMode: string;
    effectiveMultiplier: number;
    futuresMode: string;
    cryptoMode: string;
    stocksMode: string;
  };
}

function timeAgo(iso: string | null): string {
  if (!iso) return "Never";
  const ms = Date.now() - new Date(iso).getTime();
  const mins = ms / 60000;
  if (mins < 1) return "Just now";
  if (mins < 60) return `${Math.floor(mins)}m ago`;
  if (mins < 1440) return `${(mins / 60).toFixed(1)}h ago`;
  return `${Math.floor(mins / 1440)}d ago`;
}

function agentAlive(heartbeat: string | null, mode: string): "alive" | "stale" | "dead" | "disabled" {
  if (mode === "disabled") return "disabled";
  if (!heartbeat) return "dead";
  const mins = (Date.now() - new Date(heartbeat).getTime()) / 60000;
  if (mins < 15) return "alive";
  if (mins < 60) return "stale";
  return "dead";
}

const REGIME_COLORS: Record<string, string> = {
  BULL: "from-emerald-500 to-green-400",
  BEAR: "from-red-500 to-rose-400",
  CHOPPY: "from-amber-500 to-yellow-400",
  UNKNOWN: "from-zinc-500 to-zinc-400",
};

const REGIME_GLOW: Record<string, string> = {
  BULL: "shadow-emerald-500/30",
  BEAR: "shadow-red-500/30",
  CHOPPY: "shadow-amber-500/30",
  UNKNOWN: "shadow-zinc-500/20",
};

const STATUS_STYLES = {
  alive: { dot: "bg-emerald-400", ring: "ring-emerald-400/30", label: "ONLINE", color: "text-emerald-400" },
  stale: { dot: "bg-amber-400", ring: "ring-amber-400/30", label: "STALE", color: "text-amber-400" },
  dead: { dot: "bg-red-500", ring: "ring-red-500/30", label: "OFFLINE", color: "text-red-500" },
  disabled: { dot: "bg-zinc-600", ring: "ring-zinc-600/20", label: "OFF", color: "text-zinc-500" },
};

const ACTIVITY_COLORS: Record<string, string> = {
  win: "text-emerald-400",
  loss: "text-red-400",
  trade: "text-blue-400",
  skip: "text-zinc-500",
  run: "text-violet-400",
};

const ACTIVITY_ICONS: Record<string, string> = {
  win: "\u25B2",
  loss: "\u25BC",
  trade: "\u25C6",
  skip: "\u25CB",
  run: "\u25A0",
};

export default function BrainPage() {
  const { data, isLoading } = useSWR<BrainData>("/api/brain", fetcher, {
    refreshInterval: 15000,
  });
  const [now, setNow] = useState(Date.now());
  const [hoveredAgent, setHoveredAgent] = useState<string | null>(null);

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  if (isLoading || !data) {
    return (
      <div className="flex items-center justify-center h-[80vh]">
        <div className="text-center space-y-4">
          <div className="relative w-16 h-16 mx-auto">
            <div className="absolute inset-0 rounded-full border-2 border-emerald-500/30 animate-ping" />
            <div className="absolute inset-2 rounded-full border-2 border-emerald-500/50 animate-pulse" />
            <div className="absolute inset-4 rounded-full bg-emerald-500/20 animate-pulse" />
          </div>
          <p className="text-xs tracking-[0.3em] uppercase text-emerald-500/60 font-mono">Initializing Brain</p>
        </div>
      </div>
    );
  }

  const { brain, agents, tasks, activity, lessons, stats } = data;
  const regime = brain.regime.classification || "UNKNOWN";
  const coreAgents = agents.filter((a) => a.type === "core");
  const supportAgents = agents.filter((a) => a.type === "support");
  const aliveCount = agents.filter((a) => agentAlive(a.heartbeat, a.mode) === "alive").length;
  const totalEnabled = agents.filter((a) => a.mode !== "disabled").length;

  return (
    <div className="space-y-4 animate-fade-up pb-8">
      {/* ── HEADER BAR ── */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          {/* Brain icon with regime-colored pulse */}
          <div className={`relative w-10 h-10 rounded-xl bg-gradient-to-br ${REGIME_COLORS[regime] || REGIME_COLORS.UNKNOWN} flex items-center justify-center shadow-lg ${REGIME_GLOW[regime] || REGIME_GLOW.UNKNOWN}`}>
            <span className="text-white text-lg">&#x1F9E0;</span>
            <span className="absolute -top-0.5 -right-0.5 w-3 h-3 rounded-full bg-emerald-400 border-2 border-background animate-pulse" />
          </div>
          <div>
            <h1 className="text-xl font-bold tracking-tight">J.A.R.V.I.S.</h1>
            <p className="text-[10px] tracking-[0.2em] uppercase text-muted-foreground/50 font-mono">
              Trading Intelligence System
            </p>
          </div>
        </div>

        <div className="flex items-center gap-3">
          {/* Agent status summary */}
          <div className="glass-card px-3 py-1.5 flex items-center gap-2">
            <span className="relative flex h-2 w-2">
              <span className={`animate-ping absolute inline-flex h-full w-full rounded-full opacity-75 ${aliveCount === totalEnabled ? "bg-emerald-400" : aliveCount > 0 ? "bg-amber-400" : "bg-red-500"}`} />
              <span className={`relative inline-flex rounded-full h-2 w-2 ${aliveCount === totalEnabled ? "bg-emerald-400" : aliveCount > 0 ? "bg-amber-400" : "bg-red-500"}`} />
            </span>
            <span className="text-xs font-mono font-bold">{aliveCount}/{totalEnabled}</span>
            <span className="text-[9px] text-muted-foreground/50 uppercase">agents</span>
          </div>

          {/* Size override */}
          <div className={`glass-card px-3 py-1.5 text-center ${stats.effectiveMultiplier < 0.7 ? "border-red-500/30" : stats.effectiveMultiplier < 1 ? "border-amber-500/30" : ""}`}>
            <p className="text-[8px] text-muted-foreground/40 uppercase tracking-wider">Size</p>
            <p className={`text-sm font-mono font-bold ${stats.effectiveMultiplier < 0.7 ? "text-red-500" : stats.effectiveMultiplier < 1 ? "text-amber-500" : "text-foreground"}`}>
              {(stats.effectiveMultiplier * 100).toFixed(0)}%
            </p>
          </div>

          {/* Today P&L */}
          <div className="glass-card px-3 py-1.5 text-center">
            <p className="text-[8px] text-muted-foreground/40 uppercase tracking-wider">Today</p>
            <p className={`text-sm font-mono font-bold ${stats.todayPnl > 0 ? "text-emerald-500" : stats.todayPnl < 0 ? "text-red-500" : "text-muted-foreground"}`}>
              {stats.todayPnl >= 0 ? "+" : ""}{stats.todayPnl.toFixed(0)}
            </p>
          </div>
        </div>
      </div>

      {/* ── BRAIN STATE — Regime + Vol + Macro ── */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {/* Market Regime — large card */}
        <div className={`glass-card col-span-2 p-4 relative overflow-hidden`}>
          <div className={`absolute inset-0 bg-gradient-to-br ${REGIME_COLORS[regime] || REGIME_COLORS.UNKNOWN} opacity-[0.04]`} />
          <div className="relative">
            <div className="flex items-center justify-between mb-3">
              <p className="text-[9px] tracking-[0.2em] uppercase text-muted-foreground/40 font-mono">Market Regime</p>
              <span className="text-[9px] text-muted-foreground/30 font-mono">{timeAgo(brain.regime.lastUpdated)}</span>
            </div>
            <div className="flex items-end gap-3">
              <span className={`text-3xl font-black tracking-tight bg-gradient-to-r ${REGIME_COLORS[regime] || REGIME_COLORS.UNKNOWN} bg-clip-text text-transparent`}>
                {regime}
              </span>
              <div className="mb-1 space-y-0.5">
                <p className="text-xs text-muted-foreground">
                  <span className="text-muted-foreground/40">Trend:</span> {brain.regime.trend}
                </p>
                <p className="text-xs text-muted-foreground">
                  <span className="text-muted-foreground/40">VIX:</span>{" "}
                  <span className={parseFloat(brain.regime.vix) > 25 ? "text-red-400 font-bold" : parseFloat(brain.regime.vix) > 20 ? "text-amber-400" : "text-emerald-400"}>
                    {brain.regime.vix}
                  </span>
                </p>
              </div>
            </div>
          </div>
        </div>

        {/* Volatility */}
        <div className="glass-card p-4">
          <p className="text-[9px] tracking-[0.2em] uppercase text-muted-foreground/40 font-mono mb-2">Volatility</p>
          <p className="text-lg font-bold">{brain.volatility.environment}</p>
          <p className="text-[9px] text-muted-foreground/30 font-mono mt-1">{timeAgo(brain.volatility.lastUpdated)}</p>
        </div>

        {/* Crypto Regime */}
        <div className="glass-card p-4">
          <p className="text-[9px] tracking-[0.2em] uppercase text-muted-foreground/40 font-mono mb-2">Crypto</p>
          <p className="text-lg font-bold">{brain.crypto.regime}</p>
          <p className="text-[9px] text-muted-foreground/30 font-mono mt-1">{timeAgo(brain.crypto.lastUpdated)}</p>
        </div>
      </div>

      {/* ── TASKS / ALERTS ── */}
      {tasks.length > 0 && (
        <div className="glass-card p-3 border-l-2 border-l-amber-500/50">
          <p className="text-[9px] tracking-[0.2em] uppercase text-amber-500/60 font-mono mb-2">Attention Required</p>
          <div className="space-y-1.5">
            {tasks.map((task, i) => (
              <div key={i} className="flex items-center gap-2">
                <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${task.priority === "high" ? "bg-red-500 animate-pulse" : task.priority === "medium" ? "bg-amber-500" : "bg-blue-400"}`} />
                <span className="text-xs font-medium">{task.label}</span>
                <span className="text-[10px] text-muted-foreground/40 truncate">{task.context}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ── AGENTS GRID ── */}
      <div>
        <p className="text-[9px] tracking-[0.2em] uppercase text-muted-foreground/40 font-mono mb-2 px-1">Core Agents</p>
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-5 gap-2">
          {coreAgents.map((agent) => {
            const status = agentAlive(agent.heartbeat, agent.mode);
            const style = STATUS_STYLES[status];
            return (
              <div
                key={agent.id}
                className={`glass-card p-3 transition-all duration-200 cursor-default ${hoveredAgent === agent.id ? "ring-1 " + style.ring + " scale-[1.02]" : ""}`}
                onMouseEnter={() => setHoveredAgent(agent.id)}
                onMouseLeave={() => setHoveredAgent(null)}
              >
                <div className="flex items-center justify-between mb-2">
                  <span className="relative flex h-2 w-2">
                    {status === "alive" && (
                      <span className={`animate-ping absolute inline-flex h-full w-full rounded-full opacity-75 ${style.dot}`} />
                    )}
                    <span className={`relative inline-flex rounded-full h-2 w-2 ${style.dot}`} />
                  </span>
                  <span className={`text-[8px] font-mono font-bold tracking-wider ${style.color}`}>{style.label}</span>
                </div>
                <p className="text-[11px] font-semibold truncate">{agent.name}</p>
                <p className="text-[9px] text-muted-foreground/40 font-mono mt-0.5">{timeAgo(agent.heartbeat)}</p>
                <div className="mt-1.5">
                  <span className={`text-[8px] px-1.5 py-0.5 rounded font-mono font-bold tracking-wider ${
                    agent.mode === "live" ? "bg-red-500/10 text-red-400" :
                    agent.mode === "demo" || agent.mode === "paper" ? "bg-blue-500/10 text-blue-400" :
                    "bg-zinc-500/10 text-zinc-500"
                  }`}>
                    {agent.mode.toUpperCase()}
                  </span>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      <div>
        <p className="text-[9px] tracking-[0.2em] uppercase text-muted-foreground/40 font-mono mb-2 px-1">Support Agents</p>
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-5 gap-2">
          {supportAgents.map((agent) => {
            const status = agentAlive(agent.heartbeat, agent.mode);
            const style = STATUS_STYLES[status];
            return (
              <div
                key={agent.id}
                className={`glass-card p-2.5 transition-all duration-200 cursor-default ${hoveredAgent === agent.id ? "ring-1 " + style.ring : ""}`}
                onMouseEnter={() => setHoveredAgent(agent.id)}
                onMouseLeave={() => setHoveredAgent(null)}
              >
                <div className="flex items-center gap-1.5">
                  <span className={`inline-flex rounded-full h-1.5 w-1.5 shrink-0 ${style.dot}`} />
                  <p className="text-[10px] font-medium truncate">{agent.name}</p>
                </div>
                <p className="text-[8px] text-muted-foreground/30 font-mono mt-0.5 pl-3">{timeAgo(agent.heartbeat)}</p>
              </div>
            );
          })}
        </div>
      </div>

      {/* ── ACTIVITY FEED + LESSONS ── */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        {/* Activity feed — takes 2 cols */}
        <div className="col-span-2 glass-card p-4">
          <p className="text-[9px] tracking-[0.2em] uppercase text-muted-foreground/40 font-mono mb-3">Live Feed</p>
          <div className="space-y-1 max-h-[320px] overflow-y-auto pr-1">
            {activity.length === 0 ? (
              <p className="text-xs text-muted-foreground/30 italic">No activity in last 24h</p>
            ) : (
              activity.map((item, i) => (
                <div key={i} className="flex items-start gap-2 py-1 border-b border-border/30 last:border-0">
                  <span className={`text-xs mt-0.5 ${ACTIVITY_COLORS[item.type] || "text-zinc-400"}`}>
                    {ACTIVITY_ICONS[item.type] || "\u25CB"}
                  </span>
                  <div className="flex-1 min-w-0">
                    <p className={`text-[11px] font-medium ${ACTIVITY_COLORS[item.type] || "text-foreground"}`}>
                      {item.text}
                    </p>
                    {item.detail && (
                      <p className="text-[9px] text-muted-foreground/40 truncate">{item.detail}</p>
                    )}
                  </div>
                  <span className="text-[9px] text-muted-foreground/25 font-mono shrink-0 mt-0.5">
                    {new Date(item.time).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true })}
                  </span>
                </div>
              ))
            )}
          </div>
        </div>

        {/* Lessons sidebar */}
        <div className="glass-card p-4">
          <p className="text-[9px] tracking-[0.2em] uppercase text-muted-foreground/40 font-mono mb-3">Active Lessons</p>
          <div className="space-y-2">
            {lessons.length === 0 ? (
              <p className="text-xs text-muted-foreground/30 italic">No active lessons</p>
            ) : (
              lessons.map((lesson, i) => (
                <div key={i} className="flex gap-2">
                  <span className="text-[10px] text-emerald-500/40 mt-0.5 shrink-0">{i + 1}.</span>
                  <p className="text-[10px] text-muted-foreground/60 leading-relaxed">{lesson}</p>
                </div>
              ))
            )}
          </div>

          {/* Drawdown state */}
          {stats.drawdownMode !== "NORMAL" && (
            <div className="mt-4 pt-3 border-t border-border/30">
              <p className="text-[9px] tracking-[0.2em] uppercase text-red-500/60 font-mono mb-1">Drawdown Protocol</p>
              <span className="text-xs font-mono font-bold text-red-400">{stats.drawdownMode}</span>
            </div>
          )}

          {/* Mode summary */}
          <div className="mt-4 pt-3 border-t border-border/30 space-y-1">
            <p className="text-[9px] tracking-[0.2em] uppercase text-muted-foreground/40 font-mono mb-1.5">Active Modes</p>
            {[
              { label: "Futures", mode: stats.futuresMode },
              { label: "Crypto", mode: stats.cryptoMode },
              { label: "Stocks", mode: stats.stocksMode },
            ].map(({ label, mode }) => (
              <div key={label} className="flex items-center justify-between">
                <span className="text-[10px] text-muted-foreground/50">{label}</span>
                <span className={`text-[9px] font-mono font-bold ${
                  mode === "live" ? "text-red-400" :
                  mode === "demo" || mode === "paper" ? "text-blue-400" :
                  "text-zinc-500"
                }`}>{mode.toUpperCase()}</span>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* ── FOOTER PULSE ── */}
      <div className="flex items-center justify-center gap-2 pt-2">
        <div className="w-1 h-1 rounded-full bg-emerald-500/30 animate-pulse" />
        <p className="text-[9px] text-muted-foreground/20 font-mono tracking-wider">
          Auto-refreshing every 15s &middot; {stats.todayTradeCount} trades today &middot; {new Date(now).toLocaleTimeString()}
        </p>
        <div className="w-1 h-1 rounded-full bg-emerald-500/30 animate-pulse" />
      </div>
    </div>
  );
}
