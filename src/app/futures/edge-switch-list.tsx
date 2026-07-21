"use client";

import useSWR from "swr";
import { useState } from "react";
import type { EdgeSwitchVM, EdgePerfLite } from "@/lib/realtime-edges";

// Inline demo/live switch list for the Futures "Strategy" tab — the same edges + switches as the
// admin control board, right where you watch the market. State comes from /api/futures/edge-switches;
// flips POST to /api/admin/strategy-toggle (enabling on LIVE is password-gated server-side).

const fetcher = (u: string) => fetch(u).then((r) => r.json());
const money = (n: number) => `${n >= 0 ? "+" : "−"}$${Math.abs(n).toFixed(0)}`;
const col = (n: number) => (n > 0 ? "text-emerald-400" : n < 0 ? "text-red-400" : "text-muted-foreground/60");

function perf(p: EdgePerfLite | null) {
  if (!p || p.trades === 0) return <span className="text-muted-foreground/40">no trades</span>;
  return <span className={col(p.net)}>{money(p.net)} · {p.trades}t · {(p.winRate * 100).toFixed(0)}%</span>;
}

export function EdgeSwitchList() {
  const { data, mutate } = useSWR<{ edges: EdgeSwitchVM[] }>("/api/futures/edge-switches", fetcher, { refreshInterval: 30000 });
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const edges = data?.edges ?? [];

  async function toggle(e: EdgeSwitchVM, mode: "demo" | "live", next: boolean) {
    setErr(null);
    let password: string | undefined;
    if (mode === "live" && next) {
      password = window.prompt(`Turn "${e.name}" ON for LIVE (real money)?\n\nEnter the live password to confirm:`) || undefined;
      if (!password) return; // cancelled
    }
    setBusy(`${e.key}:${mode}`);
    // optimistic local update
    mutate(
      { edges: edges.map((x) => (x.key === e.key ? { ...x, [mode === "demo" ? "demoEnabled" : "liveEnabled"]: next } : x)) },
      { revalidate: false }
    );
    try {
      const res = await fetch("/api/admin/strategy-toggle", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key: e.key, mode, enabled: next, password }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.error || `HTTP ${res.status}`);
      }
      await mutate(); // pull authoritative state back
    } catch (ex) {
      setErr(ex instanceof Error ? ex.message : String(ex));
      await mutate(); // revert to server truth
    } finally {
      setBusy(null);
    }
  }

  if (!data) return <div className="text-[11px] text-muted-foreground/50 py-2">Loading edges…</div>;

  return (
    <div className="space-y-2">
      {err && <div className="text-[11px] text-red-400 border border-red-500/30 rounded px-2 py-1 bg-red-500/[0.06]">{err}</div>}
      {edges.map((e, i) => (
        <div key={e.key} className="flex items-start gap-3 bg-white/[0.02] border border-white/[0.04] rounded-lg p-3">
          <span className="text-[10px] bg-blue-500/15 text-blue-400 px-1.5 py-0.5 rounded font-bold shrink-0">#{i + 1}</span>
          <div className="flex-1 min-w-0">
            <div className="flex items-center justify-between gap-2">
              <span className="text-sm font-bold truncate">{e.name}</span>
              <div className="flex items-center gap-1.5 shrink-0">
                <Chip label="Demo" on={e.demoEnabled} busy={busy === `${e.key}:demo`} onClick={() => toggle(e, "demo", !e.demoEnabled)} tone="demo" />
                <Chip label="Live" on={e.liveEnabled} busy={busy === `${e.key}:live`} onClick={() => toggle(e, "live", !e.liveEnabled)} tone="live" />
              </div>
            </div>
            <p className="text-[11px] text-muted-foreground/60 mt-0.5">{e.blurb}</p>
            <div className="flex items-center gap-4 mt-1.5 text-[10px]">
              <span><span className="uppercase tracking-wider text-muted-foreground/40 mr-1">Demo</span>{perf(e.demoPerf)}</span>
              <span><span className="uppercase tracking-wider text-muted-foreground/40 mr-1">Live</span>{perf(e.livePerf)}</span>
            </div>
          </div>
        </div>
      ))}
      <p className="text-[9px] text-muted-foreground/40 leading-snug pt-1">
        <b>Demo</b> tests an edge in real-time on the demo engine; <b>Live</b> trades it with real money (password to enable). New edges
        stay Live-OFF until promoted. The top-bar Demo/Live toggle only changes what you <i>view</i> — these switches change what actually <i>trades</i>.
      </p>
    </div>
  );
}

function Chip({ label, on, busy, onClick, tone }: { label: string; on: boolean; busy: boolean; onClick: () => void; tone: "demo" | "live" }) {
  const onColor = tone === "live" ? "bg-emerald-500/20 text-emerald-300 border-emerald-500/40" : "bg-blue-500/20 text-blue-300 border-blue-500/40";
  const offColor = "bg-white/[0.03] text-muted-foreground/50 border-white/10";
  return (
    <button
      onClick={onClick}
      disabled={busy}
      title={`${label}: ${on ? "ON — trading" : "OFF"}${tone === "live" && !on ? " (password to enable)" : ""}`}
      className={`text-[10px] font-semibold px-2 py-0.5 rounded border transition-colors disabled:opacity-50 ${on ? onColor : offColor}`}
    >
      {label} {busy ? "…" : on ? "ON" : "OFF"}
    </button>
  );
}
