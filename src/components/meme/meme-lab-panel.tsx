"use client";

import useSWR from "swr";

interface Pos {
  pool: string; name: string; entryTs: string; entryPrice: number; sizeUsd: number;
  lastPnlPct: number; reason: string;
  exitTs?: string; exitReason?: string; realizedPct?: number; realizedUsd?: number; holdMin?: number;
}
interface Stats {
  closedCount: number; wins: number; winRate: number; totalRealizedUsd: number; totalInvestedUsd: number;
  avgWinPct: number; avgLossPct: number; bestPct: number; worstPct: number; openUnrealizedUsd: number;
}
interface Status {
  enabled: boolean; config: Record<string, string>; stats: Stats;
  open: Pos[]; closed: Pos[]; lastRun?: { ts: string; scanned: number; entered: number; exited: number; open: number } | null;
}

const fetcher = (u: string) => fetch(u).then((r) => r.json());
const usd = (n: number) => `${n < 0 ? "-" : ""}$${Math.abs(n).toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
const pct = (n: number) => `${n >= 0 ? "+" : ""}${(n * 100).toFixed(0)}%`;
const ago = (iso?: string) => { if (!iso) return ""; const m = Math.round((Date.now() - new Date(iso).getTime()) / 60000); return m < 60 ? `${m}m` : `${Math.round(m / 60)}h`; };

export function MemeLabPanel() {
  const { data } = useSWR<Status>("/api/meme-lab", fetcher, { refreshInterval: 60000 });
  if (!data) return <div className="rounded-lg border border-border bg-card p-5 text-sm text-muted-foreground">Loading Meme Lab…</div>;
  const s = data.stats;
  const netColor = s.totalRealizedUsd >= 0 ? "text-emerald-400" : "text-red-400";

  return (
    <div className="space-y-4">
      {/* Scoreboard */}
      <div className="rounded-lg border border-border bg-card p-5 space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="font-semibold text-sm">Paper Scoreboard <span className="text-[10px] font-normal text-muted-foreground/60">— hypothetical, zero real money</span></h2>
          <span className={`text-[9px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded border ${data.enabled ? "bg-emerald-500/15 text-emerald-400 border-emerald-500/30" : "bg-muted text-muted-foreground/60 border-border"}`}>
            {data.enabled ? "Observing" : "Off"}
          </span>
        </div>
        <div className="grid grid-cols-3 sm:grid-cols-6 gap-3 text-center">
          <div><p className="text-[10px] text-muted-foreground/50">Net (paper)</p><p className={`text-sm font-bold tabular-nums ${netColor}`}>{usd(s.totalRealizedUsd)}</p></div>
          <div><p className="text-[10px] text-muted-foreground/50">Bets closed</p><p className="text-sm font-bold tabular-nums">{s.closedCount}</p></div>
          <div><p className="text-[10px] text-muted-foreground/50">Win rate</p><p className="text-sm font-bold tabular-nums">{(s.winRate * 100).toFixed(0)}%</p></div>
          <div><p className="text-[10px] text-muted-foreground/50">Best / worst</p><p className="text-sm font-bold tabular-nums"><span className="text-emerald-400">{pct(s.bestPct)}</span> / <span className="text-red-400">{pct(s.worstPct)}</span></p></div>
          <div><p className="text-[10px] text-muted-foreground/50">Deployed</p><p className="text-sm font-bold tabular-nums">{usd(s.totalInvestedUsd)}</p></div>
          <div><p className="text-[10px] text-muted-foreground/50">Open (unreal.)</p><p className={`text-sm font-bold tabular-nums ${s.openUnrealizedUsd >= 0 ? "text-emerald-400" : "text-red-400"}`}>{usd(s.openUnrealizedUsd)}</p></div>
        </div>
        {data.lastRun && (
          <p className="text-[10px] text-muted-foreground/45">
            Last scan {ago(data.lastRun.ts)} ago · {data.lastRun.scanned} pools looked at · {data.lastRun.entered} entered · {data.lastRun.exited} exited · {data.open.length} open
          </p>
        )}
      </div>

      {/* Open paper positions */}
      <div className="rounded-lg border border-border bg-card p-5 space-y-2">
        <h3 className="font-semibold text-sm">Open paper bets ({data.open.length})</h3>
        {data.open.length === 0 ? (
          <p className="text-[11px] text-muted-foreground/55">Nothing open — waiting for a candidate that clears the rug/momentum filters.</p>
        ) : data.open.map((p) => (
          <div key={p.pool} className="flex items-center justify-between text-[11px] px-2 py-1.5 rounded bg-white/[0.02]">
            <span className="font-semibold truncate max-w-[45%]" title={p.name}>{p.name}</span>
            <span className="text-muted-foreground/60">{ago(p.entryTs)} held</span>
            <span className={`tabular-nums font-medium ${p.lastPnlPct >= 0 ? "text-emerald-400" : "text-red-400"}`}>{pct(p.lastPnlPct)}</span>
          </div>
        ))}
      </div>

      {/* Recent closed */}
      <div className="rounded-lg border border-border bg-card p-5 space-y-2">
        <h3 className="font-semibold text-sm">Recent closed bets</h3>
        {data.closed.length === 0 ? (
          <p className="text-[11px] text-muted-foreground/55">No closed bets yet.</p>
        ) : data.closed.map((p, i) => (
          <div key={p.pool + i} className="flex items-center justify-between text-[11px] px-2 py-1.5 rounded bg-white/[0.02]">
            <span className="font-semibold truncate max-w-[38%]" title={p.name}>{p.name}</span>
            <span className="text-muted-foreground/50 text-[10px] uppercase tracking-wider">{p.exitReason}</span>
            <span className="text-muted-foreground/60">{p.holdMin != null ? (p.holdMin < 60 ? `${p.holdMin}m` : `${Math.round(p.holdMin / 60)}h`) : ""}</span>
            <span className={`tabular-nums font-bold ${(p.realizedPct ?? 0) >= 0 ? "text-emerald-400" : "text-red-400"}`}>{pct(p.realizedPct ?? 0)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
