"use client";

import useSWR from "swr";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

// ============ SYSTEM HEALTH ============
// Kraken-only since the Aug 2026 futures retirement. One job: prove the machinery
// is alive, and go amber/red the moment any piece stops writing its heartbeat.

interface CommandData {
  heartbeats: {
    krakenCron: string | null;
    krakenAgent: string | null;
    marginWatch: string | null;
    tradeSync: string | null;
    tradingViewAlert: string | null;
  };
  flowsAsOf: string | null;
  runLock: { held: boolean; since: string | null };
  makerMisses: Record<string, number>;
  config: { enabled: boolean; validateOnly: boolean; makerOrders: boolean; marginAuto: boolean };
  recentOrders: { symbol: string; action: string; usd: number | null; reason: string | null; time: string }[];
  error?: string;
}

const fetcher = (u: string) => fetch(u).then((r) => r.json());

function ageInfo(isoDate: string | null, warnMin: number, critMin: number): { text: string; status: "ok" | "warning" | "critical" | "unknown" } {
  if (!isoDate) return { text: "never", status: "unknown" };
  const age = (Date.now() - new Date(isoDate).getTime()) / 60000;
  const text = age < 1 ? "just now" : age < 60 ? `${age.toFixed(0)}m ago` : age < 1440 ? `${(age / 60).toFixed(1)}h ago` : `${(age / 1440).toFixed(0)}d ago`;
  const status = age < warnMin ? "ok" : age < critMin ? "warning" : "critical";
  return { text, status };
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

export default function SystemHealthPage() {
  const { data, isLoading } = useSWR<CommandData>("/api/command", fetcher, { refreshInterval: 30000 });

  if (isLoading || !data) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="animate-spin w-8 h-8 border-2 border-emerald-500 border-t-transparent rounded-full" />
      </div>
    );
  }

  const hb = data.heartbeats;
  // Thresholds follow each job's real cadence: cron */30 → amber at 90m; watch */5 → amber at 20m.
  const rows: { label: string; sub: string; age: ReturnType<typeof ageInfo> }[] = [
    { label: "Kraken cron", sub: "runs every 30 min", age: ageInfo(hb.krakenCron, 90, 180) },
    { label: "Trend agent", sub: "last full run", age: ageInfo(hb.krakenAgent, 90, 180) },
    { label: "Margin watch", sub: "runs every 5 min", age: ageInfo(hb.marginWatch, 20, 60) },
    { label: "Trade sync", sub: "margin trade history from ledger", age: ageInfo(hb.tradeSync, 90, 360) },
    { label: "Deposits read", sub: "capital flows from Kraken ledger", age: ageInfo(data.flowsAsOf, 180, 720) },
  ];

  // A held lock is only alarming when it outlives its 5-minute TTL.
  const lockAgeMin = data.runLock.since ? (Date.now() - new Date(data.runLock.since).getTime()) / 60000 : 0;
  const lockStuck = data.runLock.held && lockAgeMin > 6;

  const missEntries = Object.entries(data.makerMisses || {}).filter(([, n]) => n > 0);

  return (
    <div className="space-y-6 animate-fade-up">
      <div>
        <h1 className="text-xl font-bold">System Health</h1>
        <p className="text-sm text-muted-foreground">Kraken machinery heartbeats — auto-refreshes every 30s</p>
      </div>

      {lockStuck && (
        <div className="bg-red-500/10 border border-red-500/30 rounded-lg p-4">
          <p className="text-sm font-bold text-red-500">RUN LOCK STUCK</p>
          <p className="text-xs text-red-400 mt-1">
            Held since {data.runLock.since} ({lockAgeMin.toFixed(0)}m — TTL is 5m). A run likely died mid-flight; the next cron should recover it, but check Vercel logs if this persists.
          </p>
        </div>
      )}

      <div className="grid lg:grid-cols-2 gap-4">
        {/* Heartbeats */}
        <Card className="border-zinc-800">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-bold">Heartbeats</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2.5">
            {rows.map((r) => (
              <div key={r.label} className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <StatusDot status={r.age.status} />
                  <span className="text-[12px]">{r.label}</span>
                  <span className="text-[10px] text-muted-foreground/40">{r.sub}</span>
                </div>
                <span className="text-[11px] text-muted-foreground tabular-nums">{r.age.text}</span>
              </div>
            ))}
            <div className="flex items-center justify-between border-t border-zinc-800 pt-2.5">
              <div className="flex items-center gap-2">
                <StatusDot status={hb.tradingViewAlert ? "ok" : "unknown"} />
                <span className="text-[12px]">TradingView alert</span>
                <span className="text-[10px] text-muted-foreground/40">last webhook received</span>
              </div>
              <span className="text-[11px] text-muted-foreground tabular-nums">
                {hb.tradingViewAlert ? ageInfo(hb.tradingViewAlert, 1e9, 1e9).text : "none yet"}
              </span>
            </div>
          </CardContent>
        </Card>

        {/* Config state */}
        <Card className="border-zinc-800">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-bold">Switches</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2.5">
            {[
              { label: "Trend bot enabled", on: data.config.enabled, onText: "on", offText: "off" },
              { label: "Real orders", on: !data.config.validateOnly, onText: "LIVE", offText: "validate-only" },
              { label: "Maker-first buying", on: data.config.makerOrders, onText: "on", offText: "off (taker)" },
              { label: "Margin auto-trade", on: data.config.marginAuto, onText: "ARMED", offText: "tracked only" },
            ].map((s) => (
              <div key={s.label} className="flex items-center justify-between">
                <span className="text-[12px]">{s.label}</span>
                <span className={`text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded ${
                  s.on ? "bg-red-500/15 text-red-400" : "bg-emerald-500/15 text-emerald-400"
                }`}>
                  {s.on ? s.onText : s.offText}
                </span>
              </div>
            ))}
            {missEntries.length > 0 && (
              <div className="border-t border-zinc-800 pt-2.5">
                <p className="text-[10px] text-muted-foreground/50 uppercase tracking-wider mb-1">Maker misses (falls back to market at 4)</p>
                {missEntries.map(([coin, n]) => (
                  <p key={coin} className="text-[11px] text-amber-400">{coin}: {n} consecutive unfilled</p>
                ))}
              </div>
            )}
            <div className="flex items-center justify-between border-t border-zinc-800 pt-2.5">
              <span className="text-[12px]">Run lock</span>
              <span className={`text-[11px] tabular-nums ${lockStuck ? "text-red-400" : "text-muted-foreground"}`}>
                {data.runLock.held ? `held ${lockAgeMin.toFixed(0)}m` : "released"}
              </span>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Recent orders */}
      <Card className="border-zinc-800">
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-bold">Recent Bot Orders</CardTitle>
        </CardHeader>
        <CardContent>
          {data.recentOrders.length === 0 ? (
            <p className="text-xs text-muted-foreground">No bot orders yet.</p>
          ) : (
            <div className="space-y-1.5">
              {data.recentOrders.map((o, i) => (
                <div key={i} className="flex items-center gap-3 text-[11px]">
                  <span className="text-muted-foreground/50 tabular-nums whitespace-nowrap min-w-[110px]">
                    {new Date(o.time).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}
                  </span>
                  <span className="font-semibold min-w-[60px]">{o.symbol}</span>
                  <span className={o.action === "kraken_buy" ? "text-emerald-400" : "text-red-400"}>
                    {o.action === "kraken_buy" ? "buy" : "sell"}
                  </span>
                  <span className="tabular-nums text-muted-foreground">{o.usd != null ? `$${o.usd}` : "—"}</span>
                  <span className="text-muted-foreground/50 truncate">{o.reason}</span>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
