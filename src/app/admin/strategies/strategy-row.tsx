"use client";

import { useState } from "react";
import useSWR, { mutate as globalMutate } from "swr";
import type { Strategy } from "@/lib/strategies/types";

const ACCOUNTS = [
  { key: "demo-futures", label: "Demo Futures" },
  { key: "live-futures", label: "Live $1K Futures" },
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

const fetcher = (u: string) => fetch(u).then((r) => r.json());

function statusColor(s: string) {
  if (s === "active") return "bg-emerald-500/15 text-emerald-300 border-emerald-500/30";
  if (s === "observation") return "bg-amber-500/15 text-amber-300 border-amber-500/30";
  return "bg-red-500/15 text-red-300 border-red-500/30";
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
  const statusFor = (accountKey: string): "active" | "observation" | "disabled" => {
    const row = data?.assignments.find((a) => a.accountKey === accountKey && a.strategyId === strategy.id);
    return row?.status ?? "active";
  };

  const set = async (accountKey: string, status: "active" | "observation" | "disabled") => {
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
    <div className="mt-2 space-y-2">
      {isLoading && <div className="text-xs text-muted-foreground">Loading assignments…</div>}
      {error && <div className="text-xs text-red-400">Failed to load: {String(error)}</div>}
      {data?.warning && (
        <div className="text-[11px] text-amber-300/80 bg-amber-500/[0.06] border border-amber-500/20 px-2 py-1 rounded">
          DB table not migrated yet — toggles will save once you run <code className="font-mono">npx prisma db push</code>.
        </div>
      )}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
        {ACCOUNTS.map((acc) => {
          const current = statusFor(acc.key);
          const key = `${acc.key}:${strategy.id}`;
          const perf = perfFor(acc.key);
          return (
            <div key={acc.key} className="border border-border rounded-md p-2 bg-muted/20">
              <div className="flex items-center justify-between mb-1.5">
                <div className="text-[11px] text-muted-foreground">{acc.label}</div>
                {perf && perf.trades > 0 && (
                  <div className="text-[10px] text-muted-foreground/70 tabular-nums">
                    {perf.trades} {perf.trades === 1 ? "trade" : "trades"} forward
                    {perf.pf !== null && perf.closed > 0 && (
                      <span className={`ml-1.5 font-semibold ${perf.pf >= 1 ? "text-emerald-400" : "text-red-400"}`}>
                        PF {perf.pf.toFixed(2)}
                      </span>
                    )}
                  </div>
                )}
              </div>
              <div className="flex gap-1">
                {(["active", "observation", "disabled"] as const).map((s) => {
                  const active = current === s;
                  return (
                    <button
                      key={s}
                      disabled={busy === key}
                      onClick={() => set(acc.key, s)}
                      className={`flex-1 text-[10px] font-semibold uppercase tracking-wider px-2 py-1 rounded border transition-opacity ${
                        active ? statusColor(s) : "bg-transparent text-muted-foreground/50 border-border hover:border-foreground/30"
                      } ${busy === key ? "opacity-50" : ""}`}
                    >
                      {s}
                    </button>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
