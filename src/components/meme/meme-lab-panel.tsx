"use client";

import useSWR from "swr";
import { useState } from "react";

interface Pos {
  pool: string; mint?: string; name: string; entryTs: string; entryPrice: number; sizeUsd: number;
  lastPnlPct: number; reason: string;
  conviction?: number; thesis?: string; lpLocked?: number; smartCount?: number;
  dex?: string; isPumpGraduate?: boolean; buyTx?: string; sellTx?: string;
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
interface Account {
  fundedUsd: number; valueNowUsd: number; totalPnlUsd: number; openMarketValueUsd: number; valued: boolean;
}
interface Status {
  enabled: boolean; config: Record<string, string>; stats: Stats;
  open: Pos[]; closed: Pos[]; lastRun?: { ts: string; scanned: number; entered: number; exited: number; open: number; details?: string[] } | null;
  live?: Live; account?: Account;
}

const fetcher = (u: string) => fetch(u).then((r) => r.json());
const usd = (n: number) => `${n < 0 ? "-" : ""}$${Math.abs(n).toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
const pct = (n: number) => `${n >= 0 ? "+" : ""}${(n * 100).toFixed(0)}%`;
const ago = (iso?: string) => { if (!iso) return ""; const m = Math.round((Date.now() - new Date(iso).getTime()) / 60000); return m < 60 ? `${m}m` : `${Math.round(m / 60)}h`; };
const solscanTok = (mint?: string) => mint ? `https://solscan.io/token/${mint}` : undefined;
const solscanTx = (sig?: string) => sig ? `https://solscan.io/tx/${sig}` : undefined;
// color a raw activity line by its verdict
const lineClass = (d: string) => /BOUGHT|VALIDATED BUY|WOULD BUY/.test(d) ? "text-emerald-400/90" : /SOLD|EXIT/.test(d) ? "text-blue-300/80" : /FAILED|HALTED/.test(d) ? "text-red-400/80" : "text-muted-foreground/60";

export function MemeLabPanel() {
  const { data, mutate } = useSWR<Status>("/api/meme-lab", fetcher, { refreshInterval: 60000 });
  const [pw, setPw] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [dest, setDest] = useState("");
  const [showCashout, setShowCashout] = useState(false);
  if (!data) return <div className="rounded-lg border border-border bg-card p-5 text-sm text-muted-foreground">Loading Meme Lab…</div>;
  const s = data.stats;
  const netColor = s.totalRealizedUsd >= 0 ? "text-emerald-400" : "text-red-400";
  const live = data.live;
  const acct = data.account;

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

  async function cashOut() {
    if (!confirm("Cash out: sell ALL positions to SOL and send everything to the destination address. Continue?")) return;
    setBusy(true); setMsg(null);
    try {
      const r = await fetch("/api/meme-lab/cashout", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password: pw, destination: dest }) });
      const d = await r.json();
      if (!r.ok) setMsg(d.error || "Failed");
      else { setMsg(`💸 Cashed out — sold ${d.sold}, SOL sent back. Bot turned off.`); setPw(""); setDest(""); mutate(); }
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

          {/* Cash out */}
          <div className="border-t border-border/60 pt-2">
            <button onClick={() => setShowCashout((v) => !v)} className="text-[11px] text-muted-foreground/70 hover:text-foreground underline underline-offset-2">
              {showCashout ? "Hide cash-out" : "Cash out → send money back to Kraken"}
            </button>
            {showCashout && (
              <div className="mt-2 space-y-2">
                <p className="text-[10px] text-muted-foreground/60">Sells everything to SOL and sends it to your Kraken SOL <span className="text-foreground/70">deposit</span> address (Kraken → Deposit → SOL). Also turns the bot off.</p>
                <input value={dest} onChange={(e) => setDest(e.target.value)} placeholder="Kraken SOL deposit address" className="w-full rounded-md bg-background border border-border px-2.5 py-1.5 text-xs" />
                <button onClick={cashOut} disabled={busy || !pw || !dest} className="w-full rounded-md bg-red-500/15 text-red-300 border border-red-500/30 px-3 py-1.5 text-xs font-semibold hover:bg-red-500/25 disabled:opacity-40">
                  💸 Cash out everything (needs password above)
                </button>
              </div>
            )}
          </div>
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
        {/* Headline: what the wallet is worth right now, and total change vs what was funded */}
        {acct && (
          <div className="grid grid-cols-2 gap-3">
            <div className="rounded-md bg-white/[0.02] px-3 py-2.5">
              <p className="text-[10px] text-muted-foreground/50">Value now</p>
              <p className="text-xl font-bold tabular-nums">{acct.valued ? usd(acct.valueNowUsd) : "—"}</p>
              <p className="text-[9px] text-muted-foreground/45">idle SOL + open positions, marked to market</p>
            </div>
            <div className="rounded-md bg-white/[0.02] px-3 py-2.5">
              <p className="text-[10px] text-muted-foreground/50">Total P&amp;L <span className="text-muted-foreground/40">vs {usd(acct.fundedUsd)} funded</span></p>
              <p className={`text-xl font-bold tabular-nums ${acct.totalPnlUsd >= 0 ? "text-emerald-400" : "text-red-400"}`}>
                {acct.valued ? <>{usd(acct.totalPnlUsd)} <span className="text-sm">({pct(acct.fundedUsd ? acct.totalPnlUsd / acct.fundedUsd : 0)})</span></> : "—"}
              </p>
              <p className="text-[9px] text-muted-foreground/45">realized + unrealized + SOL price drift</p>
            </div>
          </div>
        )}
        <div className="grid grid-cols-3 sm:grid-cols-5 gap-3 text-center">
          <div><p className="text-[10px] text-muted-foreground/50">Realized <span className="text-muted-foreground/40">(closed)</span></p><p className={`text-sm font-bold tabular-nums ${netColor}`}>{usd(s.totalRealizedUsd)}</p></div>
          <div><p className="text-[10px] text-muted-foreground/50">Unrealized <span className="text-muted-foreground/40">(open)</span></p><p className={`text-sm font-bold tabular-nums ${s.openUnrealizedUsd >= 0 ? "text-emerald-400" : "text-red-400"}`}>{usd(s.openUnrealizedUsd)}</p></div>
          <div><p className="text-[10px] text-muted-foreground/50">Trades closed</p><p className="text-sm font-bold tabular-nums">{s.closedCount}</p></div>
          <div><p className="text-[10px] text-muted-foreground/50">Win rate</p><p className="text-sm font-bold tabular-nums">{s.closedCount ? `${(s.winRate * 100).toFixed(0)}%` : "—"}</p></div>
          <div><p className="text-[10px] text-muted-foreground/50">Best / worst</p><p className="text-sm font-bold tabular-nums">{s.closedCount ? <><span className="text-emerald-400">{pct(s.bestPct)}</span> / <span className="text-red-400">{pct(s.worstPct)}</span></> : "—"}</p></div>
        </div>
        {data.lastRun && (
          <p className="text-[10px] text-muted-foreground/45">
            Last scan {ago(data.lastRun.ts)} ago · {data.lastRun.scanned} pools looked at · {data.lastRun.entered} entered · {data.lastRun.exited} exited · {data.open.length} open · {usd(s.totalInvestedUsd)} cycled across {s.closedCount} trades
          </p>
        )}
      </div>

      {/* Live activity feed — what the bot just decided and why */}
      <div className="rounded-lg border border-border bg-card p-5 space-y-2">
        <h3 className="font-semibold text-sm">Live activity <span className="text-[10px] font-normal text-muted-foreground/50">— what it&apos;s doing right now</span></h3>
        {data.lastRun?.details && data.lastRun.details.length > 0 ? (
          <div className="space-y-0.5 font-mono">
            {data.lastRun.details.map((d, i) => (
              <p key={i} className={`text-[10.5px] leading-snug ${lineClass(d)}`}>{d}</p>
            ))}
          </div>
        ) : (
          <p className="text-[11px] text-muted-foreground/55">Scanning — no decisions logged in the last run. Skips (rugs / low conviction) and buys will show here.</p>
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
              <span className="font-semibold truncate max-w-[38%] flex items-center gap-1">
                {p.isPumpGraduate && <span title="pump.fun graduate">🎓</span>}
                {solscanTok(p.mint) ? <a href={solscanTok(p.mint)} target="_blank" rel="noreferrer" className="hover:underline" title={p.name}>{p.name}</a> : <span title={p.name}>{p.name}</span>}
              </span>
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
            <span className="font-semibold truncate max-w-[30%] flex items-center gap-1" title={p.name}>
              {p.isPumpGraduate && <span title="pump.fun graduate">🎓</span>}
              {solscanTok(p.mint) ? <a href={solscanTok(p.mint)} target="_blank" rel="noreferrer" className="hover:underline">{p.name}</a> : p.name}
            </span>
            {p.conviction != null && <span className="text-[9px] text-fuchsia-300/70" title="AI conviction at entry">c{p.conviction}</span>}
            <span className="text-muted-foreground/50 text-[10px] uppercase tracking-wider">{p.exitReason}</span>
            {solscanTx(p.sellTx) ? <a href={solscanTx(p.sellTx)} target="_blank" rel="noreferrer" className="text-[9px] text-blue-300/60 hover:underline">tx↗</a> : <span className="text-muted-foreground/60">{p.holdMin != null ? (p.holdMin < 60 ? `${p.holdMin}m` : `${Math.round(p.holdMin / 60)}h`) : ""}</span>}
            <span className={`tabular-nums font-bold ${(p.realizedPct ?? 0) >= 0 ? "text-emerald-400" : "text-red-400"}`}>{pct(p.realizedPct ?? 0)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
