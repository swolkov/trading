"use client";

import { useEffect, useState, useCallback } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";

// ============ COMMAND CENTER ============
// Operational control panel for all meta-agents.
// The Agent Hub controls WHAT trades. This monitors EVERYTHING ELSE.

interface CommandData {
  watchdog: { lastRun: string | null; recentRuns: { summary: string; errors: number; createdAt: string }[] };
  portfolioRisk: {
    timestamp: string;
    equity: number;
    cash: number;
    cashPct: number;
    dayPnl: number;
    dayPnlPct: number;
    totalPositions: number;
    equityPositions: number;
    optionsPositions: number;
    futuresPositions: number;
    longExposure: number;
    shortExposure: number;
    netExposure: number;
    grossExposure: number;
    leverageRatio: number;
    greeks: { totalDelta: number; totalGamma: number; totalTheta: number; totalVega: number; betaWeightedDelta: number };
    sectorExposures: { sector: string; symbols: string[]; notional: number; pctOfPortfolio: number }[];
    topConcentration: { symbol: string; pct: number };
    historicalVaR95: number;
    maxDrawdownPct: number;
    alerts: { severity: string; category: string; message: string }[];
  } | null;
  regimeTransition: {
    transition: string;
    confidence: number;
    description: string;
    actionableAdvice: string;
    agentAdjustments: { positionSizeMultiplier: number; preferredStrategies: string[]; avoidStrategies: string[]; urgency: string };
    metrics: { volatilityCompression: number; adLine5d: number; vixChange1d: number; vixChange5d: number; atrExpansion: number; priceVs20sma: number; volumeSurge: number };
  } | null;
  regimeSizeOverride: number;
  eventCalendar: {
    lastRun: string;
    eventsToday: string[];
    eventsTomorrow: string[];
    upcoming: number;
    effectiveMultiplier: number;
    newsAlerts: number;
  } | null;
  eventSizeOverride: number;
  executionQuality: {
    lastRun: string;
    totalFills: number;
    avgSlippageBps: string;
    totalSlippageDollars: string;
    grades: Record<string, number>;
    worstSymbols?: string[];
    recommendations: string[];
  } | null;
  effectiveMultiplier: number;
  preferredStrategies: string[];
  avoidStrategies: string[];
  heartbeats: Record<string, string | null>;
  recentRuns: { type: string; summary: string; errors: number; duration: number; time: string }[];
}

function StatusDot({ status }: { status: "ok" | "warning" | "critical" | "unknown" }) {
  const colors = {
    ok: "bg-emerald-500",
    warning: "bg-yellow-500",
    critical: "bg-red-500 animate-pulse",
    unknown: "bg-zinc-600",
  };
  return <span className={`inline-block w-2 h-2 rounded-full ${colors[status]}`} />;
}

function formatAge(isoDate: string | null): { text: string; status: "ok" | "warning" | "critical" | "unknown" } {
  if (!isoDate) return { text: "Never", status: "unknown" };
  const age = (Date.now() - new Date(isoDate).getTime()) / 60000;
  if (age < 0) return { text: "Just now", status: "ok" };
  if (age < 10) return { text: `${age.toFixed(0)}m ago`, status: "ok" };
  if (age < 30) return { text: `${age.toFixed(0)}m ago`, status: "warning" };
  if (age < 60) return { text: `${age.toFixed(0)}m ago`, status: "warning" };
  if (age < 1440) return { text: `${(age / 60).toFixed(1)}h ago`, status: "critical" };
  return { text: `${(age / 1440).toFixed(0)}d ago`, status: "critical" };
}

function pnlColor(val: number) {
  return val > 0 ? "text-emerald-500" : val < 0 ? "text-red-500" : "text-muted-foreground";
}

function gradeColor(grade: string) {
  if (grade === "A") return "text-emerald-500";
  if (grade === "B") return "text-blue-400";
  if (grade === "C") return "text-yellow-500";
  if (grade === "D") return "text-orange-500";
  return "text-red-500";
}

export default function CommandCenterPage() {
  const [data, setData] = useState<CommandData | null>(null);
  const [loading, setLoading] = useState(true);
  const [runningAgent, setRunningAgent] = useState<string | null>(null);

  const loadData = useCallback(async () => {
    try {
      const res = await fetch("/api/command");
      const json = await res.json();
      setData(json);
    } catch { /* ignore */ }
    setLoading(false);
  }, []);

  useEffect(() => {
    loadData();
    const interval = setInterval(loadData, 30000); // 30s refresh
    return () => clearInterval(interval);
  }, [loadData]);

  const runAgent = async (endpoint: string, id: string) => {
    setRunningAgent(id);
    try {
      await fetch(endpoint, { method: "POST" });
    } catch { /* ignore */ }
    setRunningAgent(null);
    loadData();
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="animate-spin w-8 h-8 border-2 border-emerald-500 border-t-transparent rounded-full" />
      </div>
    );
  }

  const risk = data?.portfolioRisk;
  const regime = data?.regimeTransition;
  const events = data?.eventCalendar;
  const exec = data?.executionQuality;
  const heartbeats = data?.heartbeats || {};

  // Count critical alerts
  const criticalAlerts = risk?.alerts?.filter((a) => a.severity === "critical") || [];
  const warningAlerts = risk?.alerts?.filter((a) => a.severity === "warning") || [];

  return (
    <div className="space-y-6 animate-fade-up">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Command Center</h1>
          <p className="text-sm text-muted-foreground">
            System health, risk, regime, events — auto-refreshes every 30s
          </p>
        </div>
        <div className="flex items-center gap-3">
          {/* Effective sizing */}
          <div className={`text-right px-3 py-1.5 rounded-lg border ${data?.effectiveMultiplier === 1.0 ? "border-zinc-700 bg-zinc-900" : data?.effectiveMultiplier && data.effectiveMultiplier < 0.7 ? "border-red-500/30 bg-red-500/10" : "border-yellow-500/30 bg-yellow-500/10"}`}>
            <p className="text-[9px] text-muted-foreground/60 uppercase tracking-wider">Size Override</p>
            <p className={`text-lg font-bold ${data?.effectiveMultiplier === 1.0 ? "text-muted-foreground" : data?.effectiveMultiplier && data.effectiveMultiplier < 0.7 ? "text-red-500" : "text-yellow-500"}`}>
              {((data?.effectiveMultiplier || 1) * 100).toFixed(0)}%
            </p>
          </div>
          <Button
            size="sm"
            variant="outline"
            className="text-xs"
            disabled={runningAgent !== null}
            onClick={() => runAgent("/api/cron/watchdog", "watchdog")}
          >
            {runningAgent === "watchdog" ? "Running..." : "Run Watchdog"}
          </Button>
        </div>
      </div>

      {/* Critical Alerts Banner */}
      {criticalAlerts.length > 0 && (
        <div className="bg-red-500/10 border border-red-500/30 rounded-lg p-4 space-y-2">
          <p className="text-sm font-bold text-red-500">CRITICAL ALERTS ({criticalAlerts.length})</p>
          {criticalAlerts.map((a, i) => (
            <p key={i} className="text-xs text-red-400">[{a.category}] {a.message}</p>
          ))}
        </div>
      )}

      {/* Row 1: System Health + Portfolio Risk Overview */}
      <div className="grid lg:grid-cols-3 gap-4">
        {/* System Health */}
        <Card className="border-zinc-800">
          <CardHeader className="pb-2">
            <div className="flex items-center justify-between">
              <CardTitle className="text-sm font-bold">System Health</CardTitle>
              <div className="flex items-center gap-1.5">
                <StatusDot status={formatAge(heartbeats.watchdog).status} />
                <span className="text-[10px] text-muted-foreground">{formatAge(heartbeats.watchdog).text}</span>
              </div>
            </div>
          </CardHeader>
          <CardContent className="space-y-2">
            {Object.entries(heartbeats).map(([key, val]) => {
              const age = formatAge(val);
              const label = key.replace(/([A-Z])/g, " $1").replace(/^./, (s) => s.toUpperCase()).replace("Cron", "");
              return (
                <div key={key} className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <StatusDot status={age.status} />
                    <span className="text-[11px]">{label}</span>
                  </div>
                  <span className="text-[10px] text-muted-foreground">{age.text}</span>
                </div>
              );
            })}
          </CardContent>
        </Card>

        {/* Portfolio Risk Summary */}
        <Card className="lg:col-span-2 border-zinc-800">
          <CardHeader className="pb-2">
            <div className="flex items-center justify-between">
              <CardTitle className="text-sm font-bold">Portfolio Risk</CardTitle>
              <div className="flex items-center gap-2">
                {warningAlerts.length > 0 && (
                  <span className="text-[10px] px-2 py-0.5 rounded-full bg-yellow-500/15 text-yellow-500 font-medium">
                    {warningAlerts.length} warning{warningAlerts.length > 1 ? "s" : ""}
                  </span>
                )}
                <Button
                  size="sm"
                  variant="ghost"
                  className="text-[10px] h-6 px-2"
                  disabled={runningAgent !== null}
                  onClick={() => runAgent("/api/cron/risk", "risk")}
                >
                  {runningAgent === "risk" ? "..." : "Refresh"}
                </Button>
              </div>
            </div>
          </CardHeader>
          <CardContent>
            {risk ? (
              <div className="space-y-3">
                {/* Top metrics */}
                <div className="grid grid-cols-4 gap-3">
                  <div>
                    <p className="text-[9px] text-muted-foreground/60 uppercase tracking-wider">Equity</p>
                    <p className="text-lg font-bold">${(risk.equity / 1000).toFixed(1)}k</p>
                  </div>
                  <div>
                    <p className="text-[9px] text-muted-foreground/60 uppercase tracking-wider">Day P&L</p>
                    <p className={`text-lg font-bold ${pnlColor(risk.dayPnl)}`}>
                      {risk.dayPnl >= 0 ? "+" : ""}${risk.dayPnl.toFixed(0)}
                    </p>
                  </div>
                  <div>
                    <p className="text-[9px] text-muted-foreground/60 uppercase tracking-wider">Leverage</p>
                    <p className={`text-lg font-bold ${risk.leverageRatio > 1.5 ? "text-red-500" : risk.leverageRatio > 1 ? "text-yellow-500" : ""}`}>
                      {risk.leverageRatio.toFixed(1)}x
                    </p>
                  </div>
                  <div>
                    <p className="text-[9px] text-muted-foreground/60 uppercase tracking-wider">VaR 95%</p>
                    <p className={`text-lg font-bold ${risk.historicalVaR95 > risk.equity * 0.02 ? "text-red-500" : ""}`}>
                      ${risk.historicalVaR95.toFixed(0)}
                    </p>
                  </div>
                </div>

                {/* Greeks */}
                <div className="grid grid-cols-4 gap-3 border-t border-zinc-800 pt-3">
                  <div>
                    <p className="text-[9px] text-muted-foreground/60 uppercase tracking-wider">Delta</p>
                    <p className="text-sm font-medium">{risk.greeks.totalDelta.toFixed(0)}</p>
                  </div>
                  <div>
                    <p className="text-[9px] text-muted-foreground/60 uppercase tracking-wider">Gamma</p>
                    <p className="text-sm font-medium">{risk.greeks.totalGamma.toFixed(1)}</p>
                  </div>
                  <div>
                    <p className="text-[9px] text-muted-foreground/60 uppercase tracking-wider">Theta</p>
                    <p className={`text-sm font-medium ${risk.greeks.totalTheta < -100 ? "text-red-500" : ""}`}>
                      ${risk.greeks.totalTheta.toFixed(0)}/d
                    </p>
                  </div>
                  <div>
                    <p className="text-[9px] text-muted-foreground/60 uppercase tracking-wider">Vega</p>
                    <p className="text-sm font-medium">${risk.greeks.totalVega.toFixed(0)}</p>
                  </div>
                </div>

                {/* Exposure bar */}
                <div className="border-t border-zinc-800 pt-3">
                  <div className="flex items-center justify-between text-[10px] text-muted-foreground mb-1">
                    <span>Long ${(risk.longExposure / 1000).toFixed(1)}k</span>
                    <span>Cash {risk.cashPct.toFixed(0)}%</span>
                    <span>Short ${(risk.shortExposure / 1000).toFixed(1)}k</span>
                  </div>
                  <div className="h-2 bg-zinc-800 rounded-full overflow-hidden flex">
                    <div
                      className="bg-emerald-500 h-full"
                      style={{ width: `${Math.min(100, (risk.longExposure / (risk.longExposure + risk.shortExposure + risk.cash || 1)) * 100)}%` }}
                    />
                    <div
                      className="bg-zinc-600 h-full"
                      style={{ width: `${Math.min(100, (risk.cash / (risk.longExposure + risk.shortExposure + risk.cash || 1)) * 100)}%` }}
                    />
                    <div
                      className="bg-red-500 h-full"
                      style={{ width: `${Math.min(100, (risk.shortExposure / (risk.longExposure + risk.shortExposure + risk.cash || 1)) * 100)}%` }}
                    />
                  </div>
                </div>

                {/* Sector concentration */}
                {risk.sectorExposures.length > 0 && (
                  <div className="border-t border-zinc-800 pt-3">
                    <p className="text-[9px] text-muted-foreground/60 uppercase tracking-wider mb-2">Sector Exposure</p>
                    <div className="space-y-1.5">
                      {risk.sectorExposures.slice(0, 5).map((s) => (
                        <div key={s.sector} className="flex items-center gap-2">
                          <span className="text-[11px] min-w-[80px]">{s.sector}</span>
                          <div className="flex-1 h-1.5 bg-zinc-800 rounded-full overflow-hidden">
                            <div
                              className={`h-full rounded-full ${s.pctOfPortfolio > 30 ? "bg-red-500" : s.pctOfPortfolio > 20 ? "bg-yellow-500" : "bg-emerald-500"}`}
                              style={{ width: `${Math.min(100, s.pctOfPortfolio)}%` }}
                            />
                          </div>
                          <span className={`text-[10px] min-w-[40px] text-right ${s.pctOfPortfolio > 30 ? "text-red-500" : "text-muted-foreground"}`}>
                            {s.pctOfPortfolio.toFixed(0)}%
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* Positions breakdown */}
                <div className="flex items-center gap-4 text-[10px] text-muted-foreground border-t border-zinc-800 pt-3">
                  <span>Equity: {risk.equityPositions}</span>
                  <span>Options: {risk.optionsPositions}</span>
                  <span>Futures: {risk.futuresPositions}</span>
                  <span>Top: {risk.topConcentration.symbol} ({risk.topConcentration.pct.toFixed(0)}%)</span>
                </div>
              </div>
            ) : (
              <p className="text-xs text-muted-foreground">No risk data yet — run the risk agent to populate</p>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Row 2: Regime + Events + Execution */}
      <div className="grid lg:grid-cols-3 gap-4">
        {/* Regime Transition */}
        <Card className={`border-zinc-800 ${regime?.transition !== "none" && regime?.transition ? "border-yellow-500/30" : ""}`}>
          <CardHeader className="pb-2">
            <div className="flex items-center justify-between">
              <CardTitle className="text-sm font-bold">Regime State</CardTitle>
              <Button
                size="sm"
                variant="ghost"
                className="text-[10px] h-6 px-2"
                disabled={runningAgent !== null}
                onClick={() => runAgent("/api/cron/regime-transition", "regime")}
              >
                {runningAgent === "regime" ? "..." : "Check"}
              </Button>
            </div>
          </CardHeader>
          <CardContent className="space-y-3">
            {regime ? (
              <>
                {/* Current transition */}
                <div className={`px-3 py-2 rounded-lg ${regime.transition !== "none" ? "bg-yellow-500/10 border border-yellow-500/20" : "bg-zinc-900 border border-zinc-800"}`}>
                  <p className="text-[9px] text-muted-foreground/60 uppercase tracking-wider">Transition</p>
                  <p className={`text-sm font-bold ${regime.transition !== "none" ? "text-yellow-500" : "text-muted-foreground"}`}>
                    {regime.transition === "none" ? "Stable — No transition" : regime.transition.replace(/_/g, " ").toUpperCase()}
                  </p>
                  {regime.confidence > 0 && (
                    <p className="text-[10px] text-muted-foreground mt-1">{regime.confidence}% confidence</p>
                  )}
                </div>

                {regime.transition !== "none" && (
                  <p className="text-[11px] text-muted-foreground">{regime.description}</p>
                )}

                {/* Metrics */}
                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <p className="text-[9px] text-muted-foreground/60">Vol Compression</p>
                    <p className="text-xs font-medium">{(regime.metrics.volatilityCompression * 100).toFixed(0)}%</p>
                  </div>
                  <div>
                    <p className="text-[9px] text-muted-foreground/60">ATR Expansion</p>
                    <p className="text-xs font-medium">{(regime.metrics.atrExpansion * 100).toFixed(0)}%</p>
                  </div>
                  <div>
                    <p className="text-[9px] text-muted-foreground/60">VIX 1d</p>
                    <p className={`text-xs font-medium ${regime.metrics.vixChange1d > 10 ? "text-red-500" : regime.metrics.vixChange1d < -10 ? "text-emerald-500" : ""}`}>
                      {regime.metrics.vixChange1d >= 0 ? "+" : ""}{regime.metrics.vixChange1d.toFixed(1)}%
                    </p>
                  </div>
                  <div>
                    <p className="text-[9px] text-muted-foreground/60">Vol Surge</p>
                    <p className="text-xs font-medium">{(regime.metrics.volumeSurge * 100).toFixed(0)}%</p>
                  </div>
                </div>

                {/* Override */}
                {data?.regimeSizeOverride !== 1.0 && (
                  <div className="flex items-center justify-between bg-yellow-500/10 px-3 py-2 rounded-lg">
                    <span className="text-[10px]">Size Override</span>
                    <span className="text-sm font-bold text-yellow-500">{(data!.regimeSizeOverride * 100).toFixed(0)}%</span>
                  </div>
                )}

                {/* Strategy guidance */}
                {(data?.preferredStrategies?.length || 0) > 0 && (
                  <div>
                    <p className="text-[9px] text-muted-foreground/60 uppercase tracking-wider">Preferred</p>
                    <div className="flex flex-wrap gap-1 mt-1">
                      {data!.preferredStrategies.map((s) => (
                        <span key={s} className="text-[10px] px-2 py-0.5 rounded-full bg-emerald-500/15 text-emerald-500">{s.replace(/_/g, " ")}</span>
                      ))}
                    </div>
                  </div>
                )}
                {(data?.avoidStrategies?.length || 0) > 0 && (
                  <div>
                    <p className="text-[9px] text-muted-foreground/60 uppercase tracking-wider">Avoid</p>
                    <div className="flex flex-wrap gap-1 mt-1">
                      {data!.avoidStrategies.map((s) => (
                        <span key={s} className="text-[10px] px-2 py-0.5 rounded-full bg-red-500/15 text-red-500">{s.replace(/_/g, " ")}</span>
                      ))}
                    </div>
                  </div>
                )}
              </>
            ) : (
              <p className="text-xs text-muted-foreground">No regime data — run check to populate</p>
            )}
          </CardContent>
        </Card>

        {/* Event Calendar */}
        <Card className={`border-zinc-800 ${events?.eventsToday?.length ? "border-orange-500/30" : ""}`}>
          <CardHeader className="pb-2">
            <div className="flex items-center justify-between">
              <CardTitle className="text-sm font-bold">Event Calendar</CardTitle>
              <Button
                size="sm"
                variant="ghost"
                className="text-[10px] h-6 px-2"
                disabled={runningAgent !== null}
                onClick={() => runAgent("/api/cron/events", "events")}
              >
                {runningAgent === "events" ? "..." : "Scan"}
              </Button>
            </div>
          </CardHeader>
          <CardContent className="space-y-3">
            {events ? (
              <>
                {/* Override status */}
                {data?.eventSizeOverride !== 1.0 && (
                  <div className="flex items-center justify-between bg-orange-500/10 px-3 py-2 rounded-lg border border-orange-500/20">
                    <span className="text-[10px]">Event Size Override</span>
                    <span className="text-sm font-bold text-orange-500">{(data!.eventSizeOverride * 100).toFixed(0)}%</span>
                  </div>
                )}

                {/* Today */}
                <div>
                  <p className="text-[9px] text-muted-foreground/60 uppercase tracking-wider mb-1">Today</p>
                  {events.eventsToday.length > 0 ? (
                    <div className="space-y-1">
                      {events.eventsToday.map((e, i) => (
                        <div key={i} className="flex items-center gap-2">
                          <span className="w-1.5 h-1.5 rounded-full bg-orange-500" />
                          <span className="text-[11px]">{e}</span>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <p className="text-[11px] text-muted-foreground">No events today</p>
                  )}
                </div>

                {/* Tomorrow */}
                <div>
                  <p className="text-[9px] text-muted-foreground/60 uppercase tracking-wider mb-1">Tomorrow</p>
                  {events.eventsTomorrow.length > 0 ? (
                    <div className="space-y-1">
                      {events.eventsTomorrow.map((e, i) => (
                        <div key={i} className="flex items-center gap-2">
                          <span className="w-1.5 h-1.5 rounded-full bg-yellow-500" />
                          <span className="text-[11px]">{e}</span>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <p className="text-[11px] text-muted-foreground">No events tomorrow</p>
                  )}
                </div>

                {/* Stats */}
                <div className="flex items-center gap-4 text-[10px] text-muted-foreground border-t border-zinc-800 pt-3">
                  <span>{events.upcoming} events this week</span>
                  {events.newsAlerts > 0 && (
                    <span className="text-orange-500">{events.newsAlerts} news alerts</span>
                  )}
                </div>
              </>
            ) : (
              <p className="text-xs text-muted-foreground">No event data — run scan to populate</p>
            )}
          </CardContent>
        </Card>

        {/* Execution Quality */}
        <Card className="border-zinc-800">
          <CardHeader className="pb-2">
            <div className="flex items-center justify-between">
              <CardTitle className="text-sm font-bold">Execution Quality</CardTitle>
              <Button
                size="sm"
                variant="ghost"
                className="text-[10px] h-6 px-2"
                disabled={runningAgent !== null}
                onClick={() => runAgent("/api/cron/execution-review", "exec")}
              >
                {runningAgent === "exec" ? "..." : "Review"}
              </Button>
            </div>
          </CardHeader>
          <CardContent className="space-y-3">
            {exec ? (
              <>
                {/* Key metrics */}
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <p className="text-[9px] text-muted-foreground/60 uppercase tracking-wider">Avg Slippage</p>
                    <p className={`text-lg font-bold ${parseFloat(exec.avgSlippageBps) > 15 ? "text-red-500" : parseFloat(exec.avgSlippageBps) > 5 ? "text-yellow-500" : "text-emerald-500"}`}>
                      {exec.avgSlippageBps}bps
                    </p>
                  </div>
                  <div>
                    <p className="text-[9px] text-muted-foreground/60 uppercase tracking-wider">Total Cost</p>
                    <p className={`text-lg font-bold ${parseFloat(exec.totalSlippageDollars) > 50 ? "text-red-500" : ""}`}>
                      ${exec.totalSlippageDollars}
                    </p>
                  </div>
                </div>

                {/* Grade distribution */}
                <div>
                  <p className="text-[9px] text-muted-foreground/60 uppercase tracking-wider mb-2">Grades ({exec.totalFills} fills)</p>
                  <div className="flex gap-2">
                    {Object.entries(exec.grades).map(([grade, count]) => (
                      <div key={grade} className="flex-1 text-center">
                        <p className={`text-lg font-bold ${gradeColor(grade)}`}>{count}</p>
                        <p className={`text-[10px] ${gradeColor(grade)}`}>{grade}</p>
                      </div>
                    ))}
                  </div>
                </div>

                {/* Worst fills */}
                {exec.worstSymbols && exec.worstSymbols.length > 0 && (
                  <div>
                    <p className="text-[9px] text-muted-foreground/60 uppercase tracking-wider mb-1">Worst Fills</p>
                    {exec.worstSymbols.slice(0, 3).map((w, i) => (
                      <p key={i} className="text-[10px] text-red-400">{w}</p>
                    ))}
                  </div>
                )}

                {/* Recommendations */}
                {exec.recommendations.length > 0 && (
                  <div className="border-t border-zinc-800 pt-3">
                    <p className="text-[9px] text-muted-foreground/60 uppercase tracking-wider mb-1">Recommendations</p>
                    {exec.recommendations.map((r, i) => (
                      <p key={i} className="text-[10px] text-blue-400 mt-1">{r}</p>
                    ))}
                  </div>
                )}
              </>
            ) : (
              <p className="text-xs text-muted-foreground">No execution data — run review to populate</p>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Row 3: Risk Alerts + Recent Agent Runs */}
      <div className="grid lg:grid-cols-2 gap-4">
        {/* Active Risk Alerts */}
        <Card className="border-zinc-800">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-bold">
              Risk Alerts ({(criticalAlerts.length + warningAlerts.length) || 0})
            </CardTitle>
          </CardHeader>
          <CardContent>
            {(criticalAlerts.length + warningAlerts.length) > 0 ? (
              <div className="space-y-2 max-h-64 overflow-y-auto">
                {criticalAlerts.map((a, i) => (
                  <div key={`c-${i}`} className="flex items-start gap-2 text-xs border-l-2 border-red-500 pl-3 py-1">
                    <span className="text-red-500 font-bold min-w-[70px]">{a.category}</span>
                    <span className="text-red-400">{a.message}</span>
                  </div>
                ))}
                {warningAlerts.map((a, i) => (
                  <div key={`w-${i}`} className="flex items-start gap-2 text-xs border-l-2 border-yellow-500 pl-3 py-1">
                    <span className="text-yellow-500 font-bold min-w-[70px]">{a.category}</span>
                    <span className="text-yellow-400">{a.message}</span>
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-xs text-emerald-500">All clear — no active risk alerts</p>
            )}
          </CardContent>
        </Card>

        {/* Recent Meta-Agent Runs */}
        <Card className="border-zinc-800">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-bold">Recent Agent Runs</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-2 max-h-64 overflow-y-auto">
              {(data?.recentRuns || []).length === 0 && (
                <p className="text-xs text-muted-foreground">No meta-agent runs in last 24h</p>
              )}
              {(data?.recentRuns || []).slice(0, 15).map((run, i) => {
                const typeColors: Record<string, string> = {
                  watchdog: "border-blue-500",
                  portfolio_risk: "border-purple-500",
                  regime_transition: "border-yellow-500",
                  event_catalyst: "border-orange-500",
                  execution_quality: "border-teal-500",
                };
                return (
                  <div key={i} className={`flex items-start gap-3 text-xs border-l-2 pl-3 py-1 ${typeColors[run.type] || "border-zinc-600"}`}>
                    <span className="text-muted-foreground/50 whitespace-nowrap min-w-[50px]">
                      {new Date(run.time).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                    </span>
                    <div className="flex-1 min-w-0">
                      <span className="font-medium text-muted-foreground/80">{run.type.replace(/_/g, " ")}</span>
                      <p className="text-muted-foreground truncate">{run.summary}</p>
                    </div>
                    {run.errors > 0 && (
                      <span className="text-red-500 text-[10px] font-medium">{run.errors} err</span>
                    )}
                  </div>
                );
              })}
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
