"use client";

import { useState } from "react";
import useSWR, { mutate as globalMutate } from "swr";
import type { Strategy } from "@/lib/strategies/types";
import { Activity, Eye, PowerOff, ChevronDown, ChevronUp, FileText, Code2, ExternalLink } from "lucide-react";

const ACCOUNTS = [
  { key: "demo-futures", label: "Demo", capital: "$50K" },
  { key: "live-futures", label: "Live", capital: "$1K" },
] as const;

interface Assignment {
  accountKey: string;
  strategyId: string;
  status: "active" | "observation" | "disabled";
  maxContractsOverride: number | null;
}
interface PerfRow {
  strategyId: string;
  accountKey: string;
  trades: number;
  closed: number;
  pf: number | null;
  lastTradeAt: string | null;
}
type Status = "active" | "observation" | "disabled";

const fetcher = (u: string) => fetch(u).then((r) => r.json());

const STATUS_COLOR: Record<Status, string> = {
  active: "bg-emerald-500/15 text-emerald-300 border-emerald-500/30",
  observation: "bg-amber-500/15 text-amber-300 border-amber-500/30",
  disabled: "bg-red-500/15 text-red-300 border-red-500/30",
};
const STATUS_DOT: Record<Status, string> = {
  active: "bg-emerald-400",
  observation: "bg-amber-400",
  disabled: "bg-red-400",
};
const STATUS_ICON = { active: Activity, observation: Eye, disabled: PowerOff };

const money = (n: number) => `${n < 0 ? "−" : "+"}$${Math.abs(n).toLocaleString()}`;

function timeAgo(iso: string | null): string {
  if (!iso) return "—";
  const ms = Date.now() - new Date(iso).getTime();
  const m = Math.floor(ms / 60_000);
  if (m < 1) return "now";
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

function tierLabel(tier: 1 | 2 | 3 | "rejected") {
  if (tier === 1) return { label: "T1", color: "bg-emerald-500/15 text-emerald-300 border-emerald-500/30", title: "Tier 1 — Validated" };
  if (tier === 2) return { label: "T2", color: "bg-amber-500/15 text-amber-300 border-amber-500/30", title: "Tier 2 — Plausible" };
  if (tier === 3) return { label: "T3", color: "bg-blue-500/15 text-blue-300 border-blue-500/30", title: "Tier 3 — Speculative" };
  return { label: "REJ", color: "bg-red-500/15 text-red-300 border-red-500/30", title: "Rejected" };
}

interface CompactRowProps {
  strategy: Pick<Strategy, "id" | "name" | "timeframe" | "tier" | "description" | "applicableSymbols" | "backtest" | "vaultDoc" | "codePath">;
  defaultOpen?: boolean;
}

export function StrategyRowCompact({ strategy, defaultOpen = false }: CompactRowProps) {
  const [open, setOpen] = useState(defaultOpen);
  const [busy, setBusy] = useState<string | null>(null);
  const { data } = useSWR<{ assignments: Assignment[]; warning?: string }>("/api/admin/assignments", fetcher, { refreshInterval: 60_000 });
  const { data: perfData } = useSWR<{ summary: PerfRow[] }>("/api/admin/strategy-performance", fetcher, { refreshInterval: 60_000 });

  const statusFor = (acc: string): Status => {
    const row = data?.assignments.find((a) => a.accountKey === acc && a.strategyId === strategy.id);
    return row?.status ?? "active";
  };
  const perfFor = (acc: string): PerfRow | undefined =>
    perfData?.summary.find((p) => p.accountKey === acc && p.strategyId === strategy.id);

  const set = async (acc: string, status: Status) => {
    const k = `${acc}:${strategy.id}`;
    setBusy(k);
    try {
      const res = await fetch("/api/admin/assignments", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ accountKey: acc, strategyId: strategy.id, status }),
      });
      if (res.ok) await globalMutate("/api/admin/assignments");
      else alert(`Failed: ${(await res.json().catch(() => ({}))).error || res.statusText}`);
    } finally {
      setBusy(null);
    }
  };

  const tier = tierLabel(strategy.tier);
  const demoStatus = statusFor("demo-futures");
  const liveStatus = statusFor("live-futures");
  const demoPerf = perfFor("demo-futures");
  const livePerf = perfFor("live-futures");

  return (
    <div className="border border-border rounded-md bg-card overflow-hidden">
      {/* Compact summary row — clickable to expand */}
      <button
        onClick={() => setOpen((v) => !v)}
        className="w-full px-3 py-2.5 flex items-center gap-3 hover:bg-muted/30 transition-colors text-left"
      >
        <div className="flex items-center gap-2 min-w-0 flex-1">
          <span className={`shrink-0 text-[10px] font-bold px-1.5 py-0.5 rounded border ${tier.color}`} title={tier.title}>{tier.label}</span>
          <span className="text-[10px] uppercase tracking-wider text-muted-foreground/60 shrink-0 font-mono">{strategy.timeframe}</span>
          <div className="min-w-0 flex-1">
            <div className="font-medium text-[13px] truncate">{strategy.name}</div>
            <div className="flex items-center gap-1 mt-0.5 flex-wrap">
              {strategy.applicableSymbols.slice(0, 5).map((s) => (
                <span key={s} className="text-[10px] font-mono px-1 py-0 rounded bg-muted/30 text-foreground/60">{s}</span>
              ))}
            </div>
          </div>
        </div>

        {/* Backtest PF (if available) */}
        {strategy.backtest && (
          <div className="hidden sm:block text-right shrink-0">
            <div className={`text-sm font-semibold tabular-nums ${strategy.backtest.pf >= 1.3 ? "text-emerald-400" : strategy.backtest.pf >= 1.0 ? "text-amber-400" : "text-red-400"}`}>
              {strategy.backtest.pf.toFixed(2)}
            </div>
            <div className="text-[9px] text-muted-foreground/60 uppercase tracking-wider">PF backtest</div>
          </div>
        )}

        {/* Per-account compact pills */}
        <div className="hidden md:flex items-center gap-2 shrink-0">
          {ACCOUNTS.map((acc) => {
            const st = acc.key === "demo-futures" ? demoStatus : liveStatus;
            const perf = acc.key === "demo-futures" ? demoPerf : livePerf;
            return (
              <div key={acc.key} className="text-right min-w-[80px]">
                <div className="flex items-center justify-end gap-1.5">
                  <span className={`w-1.5 h-1.5 rounded-full ${STATUS_DOT[st]}`} />
                  <span className="text-[10px] uppercase tracking-wider text-muted-foreground/60">{acc.label}</span>
                </div>
                <div className="text-[10px] text-muted-foreground/70 tabular-nums">
                  {perf && perf.trades > 0 ? (
                    perf.pf !== null && perf.closed > 0
                      ? <>PF <span className={perf.pf >= 1 ? "text-emerald-400" : "text-red-400"}>{perf.pf.toFixed(2)}</span></>
                      : `${perf.trades} trade${perf.trades === 1 ? "" : "s"}`
                  ) : "no trades"}
                </div>
              </div>
            );
          })}
        </div>

        <div className="shrink-0 text-muted-foreground/50">
          {open ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
        </div>
      </button>

      {/* Expanded detail */}
      {open && (
        <div className="border-t border-border bg-muted/10 px-3 py-3 space-y-3">
          <p className="text-xs text-muted-foreground">{strategy.description}</p>

          {/* Backtest evidence (full) */}
          {strategy.backtest && (
            <div className="border border-border rounded-md bg-background p-2.5">
              <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1.5">Backtest evidence</div>
              <div className="grid grid-cols-2 sm:grid-cols-5 gap-2 text-[11px]">
                <div>
                  <div className="text-muted-foreground/60 text-[10px]">PF</div>
                  <div className={`font-semibold tabular-nums ${strategy.backtest.pf >= 1.3 ? "text-emerald-400" : strategy.backtest.pf >= 1.0 ? "text-amber-400" : "text-red-400"}`}>{strategy.backtest.pf.toFixed(2)}</div>
                </div>
                <div><div className="text-muted-foreground/60 text-[10px]">Trades</div><div className="font-semibold tabular-nums">{strategy.backtest.trades}</div></div>
                <div><div className="text-muted-foreground/60 text-[10px]">Net/contract</div><div className={`font-semibold tabular-nums ${strategy.backtest.netPerContract >= 0 ? "text-emerald-400" : "text-red-400"}`}>{money(strategy.backtest.netPerContract)}</div></div>
                <div><div className="text-muted-foreground/60 text-[10px]">Win rate</div><div className="font-semibold tabular-nums">{(strategy.backtest.winRate * 100).toFixed(0)}%</div></div>
                <div><div className="text-muted-foreground/60 text-[10px]">Years +</div><div className="font-semibold tabular-nums">{strategy.backtest.yearsPositive}</div></div>
              </div>
              <div className="text-[9px] text-muted-foreground/50 mt-1">{strategy.backtest.period}</div>
            </div>
          )}

          {/* Per-account status controls */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
            {ACCOUNTS.map((acc) => {
              const st = acc.key === "demo-futures" ? demoStatus : liveStatus;
              const perf = acc.key === "demo-futures" ? demoPerf : livePerf;
              return (
                <div key={acc.key} className="border border-border rounded-md bg-background p-2.5">
                  <div className="flex items-center justify-between mb-1.5">
                    <div className="flex items-baseline gap-1.5">
                      <span className="text-xs font-semibold">{acc.label} Futures</span>
                      <span className="text-[10px] text-muted-foreground/60">{acc.capital}</span>
                    </div>
                    <div className="text-[10px] text-muted-foreground/70 tabular-nums">
                      {perf && perf.trades > 0 ? `${perf.trades} forward · last ${timeAgo(perf.lastTradeAt)}` : "no fires yet"}
                    </div>
                  </div>
                  <div className="flex gap-1">
                    {(["active", "observation", "disabled"] as const).map((s) => {
                      const Icon = STATUS_ICON[s];
                      const isCurrent = st === s;
                      const k = `${acc.key}:${strategy.id}`;
                      return (
                        <button
                          key={s}
                          disabled={busy === k}
                          onClick={(e) => { e.stopPropagation(); set(acc.key, s); }}
                          className={`flex-1 inline-flex items-center justify-center gap-1 text-[10px] font-semibold uppercase tracking-wider px-1.5 py-1.5 rounded border transition-all ${
                            isCurrent ? STATUS_COLOR[s] : "bg-transparent text-muted-foreground/40 border-border hover:text-foreground hover:border-foreground/30"
                          } ${busy === k ? "opacity-50" : ""}`}
                        >
                          <Icon className="w-3 h-3" />
                          {s}
                        </button>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </div>

          {/* Code + vault refs */}
          <div className="flex flex-wrap items-center gap-1.5 text-[10px] text-muted-foreground/60">
            {strategy.vaultDoc && (
              <a href="/edges" className="inline-flex items-center gap-1 border border-border rounded px-1.5 py-1 hover:bg-muted/30">
                <FileText className="w-3 h-3" />
                Vault doc
                <ExternalLink className="w-2.5 h-2.5" />
              </a>
            )}
            <span className="inline-flex items-center gap-1 border border-border rounded px-1.5 py-1 font-mono">
              <Code2 className="w-3 h-3" />
              {strategy.codePath.split("/").pop()}
            </span>
          </div>
        </div>
      )}
    </div>
  );
}
