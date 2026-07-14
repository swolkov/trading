"use client";

import useSWR from "swr";

interface Decision {
  ts: string;
  sym: string;
  direction: string;
  setupType: string;
  confidence: number;
  verdict: "confirmed" | "rejected" | "pattern_blocked" | "no_verdict";
  aiConfidence?: number;
  reason: string;
  // Counterfactual outcome of a BLOCKED setup (attached server-side from the shadow tracker).
  shadow?: {
    status: "open" | "win" | "loss" | "expired";
    rMultiple: number | null;
    dollarPnl: number | null;
    contracts: number | null;
    exitReason: string | null;
  };
}

function fmtMoney(n: number): string {
  const s = Math.abs(n) >= 100 ? Math.round(Math.abs(n)).toString() : Math.abs(n).toFixed(0);
  return `${n >= 0 ? "+" : "−"}$${s}`;
}

// Tag next to a killed setup: what BLOCKING it did for you (= −trade P&L).
// + / green = the veto saved you money (dodged a loser); − / red = it cost you a winner.
function ShadowTag({ shadow }: { shadow: NonNullable<Decision["shadow"]> }) {
  if (shadow.status === "open" || shadow.dollarPnl == null) {
    return <span className="shrink-0 text-[9px] font-semibold text-muted-foreground/40 tabular-nums" title="Marking to market — resolves within a few bars">tracking…</span>;
  }
  const vetoVal = -shadow.dollarPnl; // what the veto saved (+) or cost (−) you
  const good = vetoVal >= 0;
  return (
    <span
      className={`shrink-0 text-[10px] font-bold tabular-nums ${good ? "text-emerald-400" : "text-red-400"}`}
      title={good ? `Good block — the veto saved you ${fmtMoney(vetoVal)}` : `Missed winner — the veto cost you ${fmtMoney(vetoVal)}`}
    >
      {fmtMoney(vetoVal)}
    </span>
  );
}

const fetcher = (u: string) => fetch(u).then((r) => r.json()).catch(() => null);

const VERDICT_STYLE: Record<Decision["verdict"], { label: string; cls: string }> = {
  confirmed: { label: "AI CONFIRMED", cls: "bg-emerald-500/15 text-emerald-400 border-emerald-500/30" },
  rejected: { label: "AI KILLED", cls: "bg-red-500/15 text-red-400 border-red-500/30" },
  pattern_blocked: { label: "PATTERN BLOCK", cls: "bg-amber-500/15 text-amber-300 border-amber-500/30" },
  no_verdict: { label: "AI DOWN", cls: "bg-muted text-muted-foreground/60 border-transparent" },
};

function timeAgo(ts: string): string {
  const min = Math.round((Date.now() - new Date(ts).getTime()) / 60_000);
  if (min < 1) return "now";
  if (min < 60) return `${min}m ago`;
  const h = Math.floor(min / 60);
  return h < 24 ? `${h}h ${min % 60}m ago` : new Date(ts).toLocaleDateString();
}

// What the engine is FINDING, not just what it trades: every graded setup with the AI's verdict.
// Mode is driven by the account you're viewing (live view → live engine, demo view → demo engine),
// NOT an independent toggle — so the live account never shows demo activity or vice-versa.
export function EngineActivity({ mode }: { mode: "live" | "demo" }) {
  const { data } = useSWR<{ demo: Decision[]; live: Decision[] }>("/api/futures/decisions", fetcher, { refreshInterval: 30000 });
  const rows = (data?.[mode] || []).slice(0, 12);

  return (
    <div className="rounded-xl border border-border bg-card p-4 space-y-3">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-sm font-bold">Engine Activity — setups found &amp; AI verdicts</h3>
          <p className="text-[10px] text-muted-foreground/50">Every setup the {mode} engine graded, including the ones it killed. Updates ~30s.</p>
        </div>
        <span className={`shrink-0 text-[9px] font-bold uppercase tracking-wider px-2 py-1 rounded ${mode === "live" ? "text-red-400/80 bg-red-500/[0.08]" : "text-emerald-400/80 bg-emerald-500/[0.08]"}`}>
          {mode === "live" ? "🔴 Live account" : "🟢 Demo account"}
        </span>
      </div>

      {rows.length === 0 ? (
        <p className="text-[11px] text-muted-foreground/55 py-2">
          No graded setups yet{mode === "live" ? " — the live engine only grades when a raw signal fires, so quiet stretches are normal" : ""}.
          Scanning continues every 5-minute bar.
        </p>
      ) : (
        <div className="space-y-1.5">
          {rows.map((d, i) => {
            const v = VERDICT_STYLE[d.verdict] || VERDICT_STYLE.no_verdict;
            return (
              <div key={`${d.ts}-${i}`} className="flex items-start gap-2 text-[11px] px-2 py-1.5 rounded bg-white/[0.02]">
                <span className={`shrink-0 text-[8px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded border ${v.cls}`}>{v.label}</span>
                <div className="min-w-0 flex-1">
                  <span className="font-semibold">{d.sym} {d.direction?.toUpperCase()}</span>
                  <span className="text-muted-foreground/60"> · {d.setupType?.replace(/_/g, " ")} · {d.confidence}%{d.aiConfidence ? ` (AI ${d.aiConfidence}%)` : ""}</span>
                  <p className="text-muted-foreground/55 truncate" title={d.reason}>{d.reason}</p>
                </div>
                {d.shadow && <ShadowTag shadow={d.shadow} />}
                <span className="shrink-0 text-muted-foreground/40 tabular-nums">{timeAgo(d.ts)}</span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
