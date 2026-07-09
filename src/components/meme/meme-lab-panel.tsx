"use client";

import useSWR from "swr";
import { useState } from "react";

interface Pos {
  pool: string; name: string; entryTs: string; entryPrice: number; sizeUsd: number;
  lastPnlPct: number; reason: string;
  conviction?: number; thesis?: string; lpLocked?: number; smartCount?: number;
  exitTs?: string; exitReason?: string; realizedPct?: number; realizedUsd?: number; holdMin?: number;
}
interface Stats {
  closedCount: number; wins: number; winRate: number; totalRealizedUsd: number; totalInvestedUsd: number;
  avgWinPct: number; avgLossPct: number; bestPct: number; worstPct: number; openUnrealizedUsd: number;
}
interface Live {
  enabled: boolean; validate: boolean; sizeUsd: number; maxOpen: number;
  walletConfigured: boolean; walletAddress: string | null; solBalance: number; capUsd: number;
}
interface Status {
  enabled: boolean; config: Record<string, string>; stats: Stats;
  open: Pos[]; closed: Pos[]; lastRun?: { ts: string; scanned: number; entered: number; exited: number; open: number } | null;
  live?: Live;
}

const fetcher = (u: string) => fetch(u).then((r) => r.json());
const usd = (n: number) => `${n < 0 ? "-" : ""}$${Math.abs(n).toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
const pct = (n: number) => `${n >= 0 ? "+" : ""}${(n * 100).toFixed(0)}%`;
const ago = (iso?: string) => { if (!iso) return ""; const m = Math.round((Date.now() - new Date(iso).getTime()) / 60000); return m < 60 ? `${m}m` : `${Math.round(m / 60)}h`; };

export function MemeLabPanel() {
  const { data, mutate } = useSWR<Status>("/api/meme-lab", fetcher, { refreshInterval: 60000 });
  const [pw, setPw] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  if (!data) return <div className="rounded-lg border border-border bg-card p-5 text-sm text-muted-foreground">Loading Meme Lab…</div>;
  const s = data.stats;
  const netColor = s.totalRealizedUsd >= 0 ? "text-emerald-400" : "text-red-400";
  const live = data.live;

  async function setLive(action: "arm" | "dryrun" | "off") {
    setBusy(true); setMsg(null);
    try {
      const r = await fetch("/api/meme-lab/live", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password: pw, action }) });
      const d = await r.json();
      if (!r.ok) setMsg(d.error || "Failed");
      else { setMsg(action === "arm" ? "🟢 ARMED — real money on the next scan" : action === "dryrun" ? "Dry-run on — builds trades but won't send" : "Off — paper only"); setPw(""); mutate(); }
    } catch (e) { setMsg(String(e)); }
    setBusy(false);
  }

  return (
    <div className="space-y-4">
      {/* Live control */}
      {live && (
        <div className={`rounded-lg border p-5 space-y-3 ${live.enabled && !live.validate ? "border-emerald-500/30 bg-emerald-500/[0.03]" : "border-border bg-card"}`}>
          <div className="flex items-center justify-between">
            <h2 className="font-semibold text-sm">Live Bot <span className="text-[10px] font-normal text-muted-foreground/60">— real money, ${live.capUsd} cap</span></h2>
            <span className={`text-[9px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded border ${live.enabled && !live.validate ? "bg-emerald-500/15 text-emerald-400 border-emerald-500/30" : live.enabled ? "bg-amber-500/15 text-amber-300 border-amber-500/30" : "bg-muted text-muted-foreground/60 border-border"}`}>
              {live.enabled && !live.validate ? "LIVE" : live.enabled ? "Dry-run" : "Paper only"}
            </span>
          </div>
          <div className="grid grid-cols-3 gap-3 text-center">
            <div><p className="text-[10px] text-muted-foreground/50">Wallet SOL</p><p className="text-sm font-bold tabular-nums">{live.walletConfigured ? live.solBalance.toFixed(3) : "—"}</p></div>
            <div><p className="text-[10px] text-muted-foreground/50">Per trade</p><p className="text-sm font-bold tabular-nums">${live.sizeUsd}</p></div>
            <div><p className="text-[10px] text-muted-foreground/50">Max open</p><p className="text-sm font-bold tabular-nums">{live.maxOpen}</p></div>
          </div>
          {live.walletAddress && (
            <div className="text-[10px] text-muted-foreground/60">
              Fund this wallet with SOL (send from Kraken/Coinbase):
              <code className="block mt-1 break-all bg-muted/50 px-2 py-1 rounded text-[10px] text-foreground/80">{live.walletAddress}</code>
            </div>
          )}
          <div className="border-t border-border/60 pt-3 flex gap-2 items-center flex-wrap">
            <input type="password" value={pw} onChange={(e) => setPw(e.target.value)} placeholder="Live-trading password" className="flex-1 min-w-[140px] rounded-md bg-background border border-border px-2.5 py-1.5 text-xs" />
            <button onClick={() => setLive("dryrun")} disabled={busy || !pw} className="rounded-md bg-amber-500/15 text-amber-300 border border-amber-500/30 px-2.5 py-1.5 text-xs font-semibold hover:bg-amber-500/25 disabled:opacity-40">Dry-run</button>
            <button onClick={() => setLive("arm")} disabled={busy || !pw} className="rounded-md bg-emerald-500/15 text-emerald-400 border border-emerald-500/30 px-2.5 py-1.5 text-xs font-semibold hover:bg-emerald-500/25 disabled:opacity-40">Arm live 🎰</button>
            <button onClick={() => setLive("off")} disabled={busy || !pw} className="rounded-md bg-white/[0.04] text-muted-foreground border border-border px-2.5 py-1.5 text-xs font-medium hover:bg-white/[0.08] disabled:opacity-40">Off</button>
          </div>
          {msg && <p className="text-[11px] text-muted-foreground">{msg}</p>}
        </div>
      )}
      {/* Scoreboard — real money */}
      <div className="rounded-lg border border-border bg-card p-5 space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="font-semibold text-sm">Live P&amp;L <span className="text-[10px] font-normal text-muted-foreground/60">— real money</span></h2>
          <span className={`text-[9px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded border ${data.enabled ? "bg-emerald-500/15 text-emerald-400 border-emerald-500/30" : "bg-muted text-muted-foreground/60 border-border"}`}>
            {data.enabled ? "Scanning" : "Off"}
          </span>
        </div>
        <div className="grid grid-cols-3 sm:grid-cols-6 gap-3 text-center">
          <div><p className="text-[10px] text-muted-foreground/50">Net P&amp;L</p><p className={`text-sm font-bold tabular-nums ${netColor}`}>{usd(s.totalRealizedUsd)}</p></div>
          <div><p className="text-[10px] text-muted-foreground/50">Trades closed</p><p className="text-sm font-bold tabular-nums">{s.closedCount}</p></div>
          <div><p className="text-[10px] text-muted-foreground/50">Win rate</p><p className="text-sm font-bold tabular-nums">{s.closedCount ? `${(s.winRate * 100).toFixed(0)}%` : "—"}</p></div>
          <div><p className="text-[10px] text-muted-foreground/50">Best / worst</p><p className="text-sm font-bold tabular-nums">{s.closedCount ? <><span className="text-emerald-400">{pct(s.bestPct)}</span> / <span className="text-red-400">{pct(s.worstPct)}</span></> : "—"}</p></div>
          <div><p className="text-[10px] text-muted-foreground/50">Deployed</p><p className="text-sm font-bold tabular-nums">{usd(s.totalInvestedUsd)}</p></div>
          <div><p className="text-[10px] text-muted-foreground/50">Open (unreal.)</p><p className={`text-sm font-bold tabular-nums ${s.openUnrealizedUsd >= 0 ? "text-emerald-400" : "text-red-400"}`}>{usd(s.openUnrealizedUsd)}</p></div>
        </div>
        {data.lastRun && (
          <p className="text-[10px] text-muted-foreground/45">
            Last scan {ago(data.lastRun.ts)} ago · {data.lastRun.scanned} pools looked at · {data.lastRun.entered} entered · {data.lastRun.exited} exited · {data.open.length} open
          </p>
        )}
      </div>

      {/* Open live positions */}
      <div className="rounded-lg border border-border bg-card p-5 space-y-2">
        <h3 className="font-semibold text-sm">Open positions ({data.open.length})</h3>
        {data.open.length === 0 ? (
          <p className="text-[11px] text-muted-foreground/55">Nothing open — {live?.enabled && !live?.validate ? "waiting for a coin that clears the rug + conviction gates." : "fund the wallet and arm the bot to start trading."}</p>
        ) : data.open.map((p) => (
          <div key={p.pool} className="px-2 py-1.5 rounded bg-white/[0.02] space-y-0.5">
            <div className="flex items-center justify-between text-[11px]">
              <span className="font-semibold truncate max-w-[40%]" title={p.name}>{p.name}</span>
              <span className="flex items-center gap-1.5">
                {p.conviction != null && <span className="text-[9px] font-bold px-1 py-0.5 rounded bg-fuchsia-500/15 text-fuchsia-300" title="AI conviction">conv {p.conviction}</span>}
                {!!p.smartCount && <span className="text-[9px] font-bold px-1 py-0.5 rounded bg-amber-500/15 text-amber-300" title="tracked winner wallets holding">{p.smartCount}🐋</span>}
              </span>
              <span className="text-muted-foreground/60">{ago(p.entryTs)}</span>
              <span className={`tabular-nums font-medium ${p.lastPnlPct >= 0 ? "text-emerald-400" : "text-red-400"}`}>{pct(p.lastPnlPct)}</span>
            </div>
            {p.thesis && <p className="text-[10px] text-muted-foreground/50 truncate" title={p.thesis}>{p.thesis}</p>}
          </div>
        ))}
      </div>

      {/* Recent closed */}
      <div className="rounded-lg border border-border bg-card p-5 space-y-2">
        <h3 className="font-semibold text-sm">Recent trades</h3>
        {data.closed.length === 0 ? (
          <p className="text-[11px] text-muted-foreground/55">No closed trades yet.</p>
        ) : data.closed.map((p, i) => (
          <div key={p.pool + i} className="flex items-center justify-between text-[11px] px-2 py-1.5 rounded bg-white/[0.02]">
            <span className="font-semibold truncate max-w-[32%]" title={p.name}>{p.name}</span>
            {p.conviction != null && <span className="text-[9px] text-fuchsia-300/70" title="AI conviction at entry">c{p.conviction}</span>}
            <span className="text-muted-foreground/50 text-[10px] uppercase tracking-wider">{p.exitReason}</span>
            <span className="text-muted-foreground/60">{p.holdMin != null ? (p.holdMin < 60 ? `${p.holdMin}m` : `${Math.round(p.holdMin / 60)}h`) : ""}</span>
            <span className={`tabular-nums font-bold ${(p.realizedPct ?? 0) >= 0 ? "text-emerald-400" : "text-red-400"}`}>{pct(p.realizedPct ?? 0)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
