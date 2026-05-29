"use client";

import { useState } from "react";
import useSWR, { mutate as globalMutate } from "swr";
import type { Strategy } from "@/lib/strategies/types";
import { Activity, Eye, PowerOff } from "lucide-react";

const ACCOUNTS = [
  { key: "demo-futures", label: "Demo Futures", capital: "$50K" },
  { key: "live-futures", label: "Live Futures", capital: "$1K" },
] as const;

interface Assignment {
  accountKey: string;
  strategyId: string;
  status: "active" | "observation" | "disabled";
  maxContractsOverride: number | null;
  forwardPf30d?: number | null;
  forwardTrades30d?: number | null;
}

interface PerfRow {
  strategyId: string;
  accountKey: string;
  trades: number;
  open: number;
  closed: number;
  pf: number | null;
  rTotal: number;
  lastTradeAt: string | null;
}

type Status = "active" | "observation" | "disabled";

const STATUS_META: Record<Status, { icon: typeof Activity; tooltip: string; color: string }> = {
  active: {
    icon: Activity,
    tooltip: "Strategy fires real signals → trades placed (paper or live per account).",
    color: "bg-emerald-500/15 text-emerald-300 border-emerald-500/30",
  },
  observation: {
    icon: Eye,
    tooltip: "Strategy detects signals and logs them, but no orders are placed.",
    color: "bg-amber-500/15 text-amber-300 border-amber-500/30",
  },
  disabled: {
    icon: PowerOff,
    tooltip: "Strategy is not evaluated. Skip entirely.",
    color: "bg-red-500/15 text-red-300 border-red-500/30",
  },
};

const fetcher = (u: string) => fetch(u).then((r) => r.json());

function formatTimeAgo(iso: string | null): string {
  if (!iso) return "no trades yet";
  const ms = Date.now() - new Date(iso).getTime();
  const m = Math.floor(ms / 60_000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

export function StrategyAssignmentControls({ strategy }: { strategy: Pick<Strategy, "id" | "name"> }) {
  const { data, error, isLoading } = useSWR<{ assignments: Assignment[]; warning?: string }>(
    "/api/admin/assignments",
    fetcher,
    { refreshInterval: 60_000 },
  );
  const { data: perfData } = useSWR<{ summary: PerfRow[] }>(
    "/api/admin/strategy-performance",
    fetcher,
    { refreshInterval: 60_000 },
  );
  const [busy, setBusy] = useState<string | null>(null);

  const perfFor = (accountKey: string): PerfRow | undefined =>
    perfData?.summary.find((p) => p.accountKey === accountKey && p.strategyId === strategy.id);

  // Resolve current status per account (DB row or "active" default)
  const statusFor = (accountKey: string): Status => {
    const row = data?.assignments.find((a) => a.accountKey === accountKey && a.strategyId === strategy.id);
    return row?.status ?? "active";
  };

  const set = async (accountKey: string, status: Status) => {
    const key = `${accountKey}:${strategy.id}`;
    setBusy(key);
    try {
      const res = await fetch("/api/admin/assignments", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ accountKey, strategyId: strategy.id, status }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        alert(`Failed to update: ${body.error || res.statusText}`);
      } else {
        await globalMutate("/api/admin/assignments");
      }
    } catch (e) {
      alert(`Network error: ${e instanceof Error ? e.message : e}`);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="space-y-2">
      <div className="text-[10px] uppercase tracking-wider text-muted-foreground">Per-account status</div>

      {isLoading && <div className="text-xs text-muted-foreground">Loading assignments…</div>}
      {error && <div className="text-xs text-red-400">Failed to load: {String(error)}</div>}
      {data?.warning && (
        <div className="text-[11px] text-amber-300/80 bg-amber-500/[0.06] border border-amber-500/20 px-2 py-1.5 rounded">
          DB table not migrated yet — toggles will save once you run{" "}
          <code className="font-mono">npx prisma db push</code>.
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
        {ACCOUNTS.map((acc) => {
          const current = statusFor(acc.key);
          const key = `${acc.key}:${strategy.id}`;
          const perf = perfFor(acc.key);
          return (
            <div key={acc.key} className="border border-border rounded-md p-2.5 bg-muted/20 space-y-2">
              {/* Account header */}
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-baseline gap-1.5">
                  <span className="text-xs font-medium">{acc.label}</span>
                  <span className="text-[10px] text-muted-foreground/60 tabular-nums">{acc.capital}</span>
                </div>
                <div className="text-[10px] text-muted-foreground/70 tabular-nums">
                  {perf && perf.trades > 0 ? (
                    <>
                      {perf.trades} {perf.trades === 1 ? "trade" : "trades"}
                      {perf.pf !== null && perf.closed > 0 && (
                        <span className={`ml-1 font-semibold ${perf.pf >= 1 ? "text-emerald-400" : "text-red-400"}`}>
                          PF {perf.pf.toFixed(2)}
                        </span>
                      )}
                    </>
                  ) : (
                    <span className="text-muted-foreground/40">no trades yet</span>
                  )}
                </div>
              </div>

              {/* Status toggle buttons */}
              <div className="flex gap-1">
                {(["active", "observation", "disabled"] as const).map((s) => {
                  const isCurrent = current === s;
                  const meta = STATUS_META[s];
                  const Icon = meta.icon;
                  return (
                    <button
                      key={s}
                      disabled={busy === key}
                      onClick={() => set(acc.key, s)}
                      title={meta.tooltip}
                      className={`flex-1 inline-flex items-center justify-center gap-1 text-[10px] font-semibold uppercase tracking-wider px-1.5 py-1.5 rounded border transition-all ${
                        isCurrent ? meta.color : "bg-transparent text-muted-foreground/40 border-border hover:text-foreground hover:border-foreground/30"
                      } ${busy === key ? "opacity-50" : ""}`}
                    >
                      <Icon className="w-3 h-3" />
                      {s}
                    </button>
                  );
                })}
              </div>

              {/* Last trade footer */}
              {perf && perf.lastTradeAt && (
                <div className="text-[10px] text-muted-foreground/50 pt-1 border-t border-border/40">
                  Last fired: {formatTimeAgo(perf.lastTradeAt)}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
