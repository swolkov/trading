"use client";

import { useState } from "react";
import { Activity, ShieldCheck, FlaskConical } from "lucide-react";

export interface EdgePerfVM {
  net: number;
  trades: number;
  wins: number;
  losses: number;
  winRate: number;
}
export interface EdgeVM {
  key: string;
  name: string;
  blurb: string;
  evidence: string;
  symbolClass: "metals" | "index";
  demoEnabled: boolean;
  liveEnabled: boolean;
  demoPerf: EdgePerfVM | null;
  livePerf: EdgePerfVM | null;
}

const money = (n: number) => `${n >= 0 ? "+" : "−"}$${Math.abs(n).toFixed(0)}`;
const col = (n: number) => (n > 0 ? "text-emerald-400" : n < 0 ? "text-red-400" : "text-muted-foreground");

function perfLine(p: EdgePerfVM | null) {
  if (!p || p.trades === 0) return <span className="text-muted-foreground/50">no trades yet</span>;
  return (
    <>
      <span className={col(p.net)}>{money(p.net)}</span>
      <span className="text-muted-foreground/60"> · {p.trades} trade{p.trades === 1 ? "" : "s"} · {(p.winRate * 100).toFixed(0)}% win</span>
    </>
  );
}

export function EdgeControlBoard({ edges: initial }: { edges: EdgeVM[] }) {
  const [edges, setEdges] = useState(initial);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  async function toggle(key: string, mode: "demo" | "live", next: boolean) {
    setErr(null);
    // Promoting to LIVE requires the password.
    let password: string | undefined;
    if (mode === "live" && next) {
      const edge = edges.find((e) => e.key === key);
      password = window.prompt(`Enable "${edge?.name}" on LIVE (real money)?\n\nEnter the live password to confirm:`) || undefined;
      if (!password) return; // cancelled
    }
    const flag = `${key}:${mode}`;
    setBusy(flag);
    // optimistic
    setEdges((prev) => prev.map((e) => (e.key === key ? { ...e, [mode === "demo" ? "demoEnabled" : "liveEnabled"]: next } : e)));
    try {
      const res = await fetch("/api/admin/strategy-toggle", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key, mode, enabled: next, password }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.error || `HTTP ${res.status}`);
      }
    } catch (e) {
      // revert on failure
      setEdges((prev) => prev.map((el) => (el.key === key ? { ...el, [mode === "demo" ? "demoEnabled" : "liveEnabled"]: !next } : el)));
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="border border-border rounded-lg bg-muted/10 p-3">
      <div className="flex items-center justify-between mb-1">
        <div className="text-xs font-bold tracking-tight flex items-center gap-1.5">
          <ShieldCheck className="w-3.5 h-3.5 text-emerald-400" /> Edge control — demo vs live switches
        </div>
        <div className="text-[10px] text-muted-foreground/60">the realtime engine trades only edges switched ON for that engine</div>
      </div>
      <p className="text-[10px] text-muted-foreground/50 mb-3 leading-snug">
        Pipeline: backtest an edge → turn <strong>Demo</strong> ON to validate it runs live-in-real-time → <strong>Promote</strong> (Live ON,
        password-gated) once it holds up. New edges default to Demo-ON / Live-OFF, so nothing reaches real money until you flip it.
        Demo P&amp;L is execution validation, not proof — real proof is the backtest plus a live sample.
      </p>

      {err && <div className="mb-2 text-[11px] text-red-400 border border-red-500/30 rounded px-2 py-1 bg-red-500/[0.06]">{err}</div>}

      <div className="space-y-2">
        {edges.map((e) => (
          <div key={e.key} className="border border-border/60 rounded-md bg-background/40 p-3">
            <div className="flex items-start justify-between gap-3 flex-wrap">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="text-[13px] font-semibold">{e.name}</span>
                  <span className="text-[9px] uppercase tracking-wider px-1.5 py-0.5 rounded border border-border bg-muted/40 text-muted-foreground/70">{e.symbolClass}</span>
                </div>
                <div className="text-[11px] text-muted-foreground/70 mt-0.5">{e.blurb}</div>
                <div className="text-[10px] text-muted-foreground/50 mt-1 leading-snug flex gap-1">
                  <FlaskConical className="w-3 h-3 shrink-0 mt-0.5" /> <span>{e.evidence}</span>
                </div>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <ToggleChip label="Demo" on={e.demoEnabled} busy={busy === `${e.key}:demo`} onClick={() => toggle(e.key, "demo", !e.demoEnabled)} tone="demo" />
                <ToggleChip label="Live" on={e.liveEnabled} busy={busy === `${e.key}:live`} onClick={() => toggle(e.key, "live", !e.liveEnabled)} tone="live" />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-2 mt-2 pt-2 border-t border-border/40">
              <div className="text-[10px]"><span className="uppercase tracking-wider text-muted-foreground/45 mr-1">Demo</span>{perfLine(e.demoPerf)}</div>
              <div className="text-[10px] flex items-center gap-1"><Activity className="w-3 h-3 text-emerald-400/70" /><span className="uppercase tracking-wider text-muted-foreground/45 mr-1">Live</span>{perfLine(e.livePerf)}</div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function ToggleChip({ label, on, busy, onClick, tone }: { label: string; on: boolean; busy: boolean; onClick: () => void; tone: "demo" | "live" }) {
  const onColor = tone === "live" ? "bg-emerald-500/20 text-emerald-300 border-emerald-500/40" : "bg-blue-500/20 text-blue-300 border-blue-500/40";
  const offColor = "bg-muted/30 text-muted-foreground/60 border-border";
  return (
    <button
      onClick={onClick}
      disabled={busy}
      className={`text-[11px] font-semibold px-2.5 py-1 rounded-md border transition-colors disabled:opacity-50 ${on ? onColor : offColor}`}
      title={`${label}: ${on ? "ON — trading" : "OFF"}${tone === "live" && !on ? " (password to enable)" : ""}`}
    >
      {label} · {busy ? "…" : on ? "ON" : "OFF"}
    </button>
  );
}
