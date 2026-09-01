"use client";

import useSWR from "swr";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

// ============ SYSTEM HEALTH ============
// Kraken MARGIN era (spot trend bot retired Aug 2026). One job: prove the LIVE machinery is
// alive — the margin scanner + guardian crons, trade sync, the webhook — and go amber/red the
// moment any piece stops writing its heartbeat. Plus the executor's real-money arm-state.

interface CommandData {
  heartbeats: {
    marginScan: string | null;
    marginWatch: string | null;
    tradeSync: string | null;
    tradingViewAlert: string | null;
  };
  config: { marginAuto: boolean; marginValidateOnly: boolean; shadowAutotrack: boolean; drawdownDisarmed: boolean };
  execLock: { held: boolean; since: string | null };
  error?: string;
}

const fetcher = (u: string) => fetch(u).then((r) => r.json());

function ageInfo(isoDate: string | null, warnMin: number, critMin: number): { text: string; status: "ok" | "warning" | "critical" | "unknown" } {
  if (!isoDate) return { text: "never", status: "unknown" };
  const t = new Date(isoDate).getTime();
  if (!Number.isFinite(t)) return { text: "—", status: "unknown" };
  const age = (Date.now() - t) / 60000;
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

  if (data.error) {
    return (
      <div className="space-y-6 animate-fade-up">
        <div>
          <h1 className="text-xl font-bold">System Health</h1>
          <p className="text-sm text-muted-foreground">Kraken machinery heartbeats — auto-refreshes every 30s</p>
        </div>
        <div className="bg-red-500/10 border border-red-500/30 rounded-lg p-4">
          <p className="text-sm font-bold text-red-500">Health check failed to read state</p>
          <p className="text-xs text-red-400 mt-1 break-words">{data.error}</p>
        </div>
      </div>
    );
  }

  const hb = data.heartbeats;
  // Thresholds follow each job's real cadence: scan/watch */5 → amber 20m/red 60m.
  const rows: { label: string; sub: string; age: ReturnType<typeof ageInfo> }[] = [
    { label: "Margin scanner", sub: "runs every 5 min", age: ageInfo(hb.marginScan, 20, 60) },
    { label: "Margin guardian", sub: "runs every 5 min", age: ageInfo(hb.marginWatch, 20, 60) },
    { label: "Trade sync", sub: "fills from Kraken ledger", age: ageInfo(hb.tradeSync, 90, 360) },
  ];

  // The margin exec lock is only held while placing a real order; alarming if it outlives 120s TTL.
  const lockAgeMin = data.execLock.since ? (Date.now() - new Date(data.execLock.since).getTime()) / 60000 : 0;
  const lockStuck = data.execLock.held && lockAgeMin > 3;

  const switches = [
    { label: "Margin auto-trade", on: data.config.marginAuto, onText: "ARMED", offText: "tracked only" },
    { label: "Real orders", on: !data.config.marginValidateOnly, onText: "LIVE", offText: "validate-only" },
    { label: "Shadow auto-track", on: data.config.shadowAutotrack, onText: "on", offText: "off", neutral: true },
    { label: "Drawdown breaker", on: data.config.drawdownDisarmed, onText: "TRIPPED", offText: "clear" },
  ];

  return (
    <div className="space-y-6 animate-fade-up">
      <div>
        <h1 className="text-xl font-bold">System Health</h1>
        <p className="text-sm text-muted-foreground">Kraken margin machinery heartbeats — auto-refreshes every 30s</p>
      </div>

      {lockStuck && (
        <div className="bg-red-500/10 border border-red-500/30 rounded-lg p-4">
          <p className="text-sm font-bold text-red-500">EXEC LOCK STUCK</p>
          <p className="text-xs text-red-400 mt-1">
            Held since {data.execLock.since} ({lockAgeMin.toFixed(0)}m — TTL is 2m). A real-order run likely died mid-flight; the next call recovers it, but check Vercel logs if this persists.
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

        {/* Switches */}
        <Card className="border-zinc-800">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-bold">Switches</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2.5">
            {switches.map((s) => (
              <div key={s.label} className="flex items-center justify-between">
                <span className="text-[12px]">{s.label}</span>
                <span className={`text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded ${
                  s.on
                    ? (s.neutral ? "bg-emerald-500/15 text-emerald-400" : "bg-red-500/15 text-red-400")
                    : (s.neutral ? "bg-zinc-500/15 text-zinc-400" : "bg-emerald-500/15 text-emerald-400")
                }`}>
                  {s.on ? s.onText : s.offText}
                </span>
              </div>
            ))}
            <div className="flex items-center justify-between border-t border-zinc-800 pt-2.5">
              <span className="text-[12px]">Margin exec lock</span>
              <span className={`text-[11px] tabular-nums ${lockStuck ? "text-red-400" : "text-muted-foreground"}`}>
                {data.execLock.held ? `held ${lockAgeMin.toFixed(0)}m` : "released"}
              </span>
            </div>
          </CardContent>
        </Card>
      </div>

      <p className="text-[11px] text-muted-foreground/40">
        The margin executor is <span className="text-foreground/60">{data.config.marginAuto && !data.config.marginValidateOnly ? "ARMED — placing real orders" : "in paper/tracked mode — no real money"}</span>.
        The spot trend bot was retired; its machinery is no longer monitored here.
      </p>
    </div>
  );
}
