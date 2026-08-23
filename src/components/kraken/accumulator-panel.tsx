"use client";

import useSWR from "swr";
import { useState } from "react";

interface Holding { coin: string; amount: number; price: number; value: number; aboveTrend: boolean; }
interface Status {
  connected: boolean;
  enabled: boolean;
  validateOnly: boolean;
  usd: number;
  holdings: Holding[];
  totalValue: number;
  totalInvested: number;                       // deposited capital, read from Kraken's own ledger
  investedSource: "kraken-ledger" | "config";
  investedApproximate: boolean;
  allocPct: number;
  targetPerCoin: number;
  strategyValue: number;
  otherValue: number;
  otherAssets: { asset: string; value: number }[];
  mode: string;
  buyCount: number;
  config: Record<string, string>;
  error?: string;
}

const fetcher = (u: string) => fetch(u).then((r) => r.json());
const fmt = (n: number) => `$${n.toLocaleString(undefined, { maximumFractionDigits: 2 })}`;

export function AccumulatorPanel() {
  const { data, mutate } = useSWR<Status>("/api/kraken-agent", fetcher, { refreshInterval: 60000 });
  const [pw, setPw] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  if (!data) return null;

  const coins = data.config?.kraken_coins || "BTC/USD,ETH/USD";
  const pnl = data.totalValue - data.totalInvested;
  const pnlPct = data.totalInvested > 0 ? (pnl / data.totalInvested) * 100 : 0;
  const usingPct = data.allocPct > 0;
  // What the engine aims to hold in each coin while that coin is above its 50-day line.
  const sizing = usingPct
    ? `${(data.allocPct * 100).toFixed(0)}% of the account each (~${fmt(data.targetPerCoin)})`
    : `${fmt(Number(data.config?.kraken_per_coin_usd) || 0)} fixed per coin`;

  async function setLive(live: boolean) {
    setBusy(true); setMsg(null);
    try {
      const r = await fetch("/api/kraken-agent/live", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password: pw, live }),
      });
      const d = await r.json();
      if (!r.ok) { setMsg(d.error || "Failed"); }
      else { setMsg(live ? "✅ LIVE — it trades on the next check (~30 min)." : "Paused — back to safe validate mode."); setPw(""); mutate(); }
    } catch (e) { setMsg(String(e)); }
    setBusy(false);
  }

  return (
    <div className="rounded-lg border border-border bg-card p-5 space-y-3">
      <div className="flex items-center justify-between">
        <h2 className="font-semibold text-sm">BTC/ETH 50-Day Trend Follower</h2>
        <div className="flex items-center gap-1.5">
          {data.connected ? (
            data.enabled ? (
              data.validateOnly
                ? <span className="text-[9px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded bg-amber-500/15 text-amber-300 border border-amber-500/30">Validate mode</span>
                : <span className="text-[9px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded bg-emerald-500/15 text-emerald-400 border border-emerald-500/30">Live</span>
            ) : <span className="text-[9px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded bg-muted text-muted-foreground/60">Off</span>
          ) : (
            <span className="text-[9px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded bg-red-500/15 text-red-400 border border-red-500/30">Not connected</span>
          )}
        </div>
      </div>

      {!data.connected ? (
        <p className="text-[11px] text-muted-foreground/55 leading-relaxed">
          Built and ready. Activates once <code className="bg-muted px-1 rounded">KRAKEN_API_KEY</code> / <code className="bg-muted px-1 rounded">KRAKEN_API_SECRET</code> (a fresh trade-only key) are added in the Vercel environment. Holds {coins.replace(/\/USD/g, "")} while each is above its 50-day average and sells to cash when it drops below.
        </p>
      ) : (
        <>
          <div className="grid grid-cols-4 gap-3 text-center">
            <div><p className="text-[10px] text-muted-foreground/50">Cash</p><p className="text-sm font-bold tabular-nums">{fmt(data.usd)}</p></div>
            <div><p className="text-[10px] text-muted-foreground/50">Deposited</p><p className="text-sm font-bold tabular-nums">{fmt(data.totalInvested)}</p></div>
            <div><p className="text-[10px] text-muted-foreground/50">Value</p><p className="text-sm font-bold tabular-nums">{fmt(data.totalValue)}</p></div>
            <div><p className="text-[10px] text-muted-foreground/50">P&amp;L</p><p className={`text-sm font-bold tabular-nums ${pnl >= 0 ? "text-emerald-400" : "text-red-400"}`}>{fmt(pnl)}<span className="text-[10px] font-medium opacity-70"> {pnl >= 0 ? "+" : ""}{pnlPct.toFixed(1)}%</span></p></div>
          </div>
          {data.otherValue > 0 && (
            <p className="text-[10px] text-amber-400/60 -mt-1">
              Includes {fmt(data.otherValue)} in {data.otherAssets.map((a) => a.asset).join(", ")} that the strategy
              does not trade — bought manually, or left over. It counts toward value and P&amp;L because your deposits
              are counted account-wide, but the trend follower will never buy or sell it.
              Strategy side only: {fmt(data.strategyValue)}.
            </p>
          )}
          <p className="text-[10px] text-muted-foreground/40 -mt-1">
            {data.investedSource === "kraken-ledger"
              ? <>Deposited is read from Kraken&apos;s deposit/withdrawal ledger, so funding the account never shows up as profit.{data.investedApproximate ? " A non-USD transfer was valued at today's price — treat P&L as approximate." : ""}</>
              : <span className="text-amber-400/70">Deposited is a configured fallback — the Kraken ledger could not be read, so P&amp;L may count a deposit as profit.</span>}
          </p>
          {data.holdings.length > 0 ? (
            <div className="space-y-1">
              <p className="text-[10px] text-muted-foreground/50 uppercase tracking-wider">Positions</p>
              {data.holdings.map((h) => (
                <div key={h.coin} className="flex items-center justify-between text-[11px] px-2 py-1 rounded bg-white/[0.02]">
                  <span className="font-semibold">
                    {h.coin.replace("/USD", "")}{" "}
                    {h.aboveTrend
                      ? <span className="text-emerald-400/70">↑ above 50-day</span>
                      : <span className="text-amber-400/80">↓ below — exits next run</span>}
                  </span>
                  <span className="tabular-nums text-muted-foreground/70">{h.amount.toFixed(6)} @ {fmt(h.price)}</span>
                  <span className="tabular-nums font-medium">{fmt(h.value)}</span>
                </div>
              ))}
            </div>
          ) : (
            <div className="text-[11px] text-muted-foreground/55 px-2 py-1.5 rounded bg-white/[0.02]">
              <span className="font-semibold text-foreground/70">In cash — nothing held.</span> Both coins are below their 50-day average, so it is waiting. It buys back in when a coin reclaims the trend, which is the drawdown protection working, not a fault.
            </div>
          )}
          <p className="text-[10px] text-muted-foreground/45">
            {data.buyCount} trades · {coins.replace(/\/USD/g, "")} · target {sizing} · sells to cash below the 50-day
            {usingPct ? " · deposits deploy automatically" : ""}
            {data.validateOnly ? " · validate mode = no real orders yet" : ""}
          </p>

          {/* Password-gated real-money arm/disarm */}
          <div className="border-t border-border/60 pt-3 mt-1">
            {data.validateOnly ? (
              <div className="space-y-2">
                <p className="text-[11px] text-amber-300/90">Safe mode — <span className="font-semibold">not trading yet</span>. Enter your live-trading password to arm it.</p>
                <div className="flex gap-2">
                  <input
                    type="password"
                    value={pw}
                    onChange={(e) => setPw(e.target.value)}
                    placeholder="Live-trading password"
                    className="flex-1 rounded-md bg-background border border-border px-2.5 py-1.5 text-xs"
                  />
                  <button
                    onClick={() => setLive(true)}
                    disabled={busy || !pw}
                    className="rounded-md bg-emerald-500/15 text-emerald-400 border border-emerald-500/30 px-3 py-1.5 text-xs font-semibold hover:bg-emerald-500/25 disabled:opacity-40"
                  >
                    {busy ? "…" : "Go Live"}
                  </button>
                </div>
              </div>
            ) : (
              <div className="flex items-center justify-between gap-2">
                <span className="text-[11px] text-emerald-400 font-semibold">🟢 LIVE — 50-day trend follower</span>
                <div className="flex gap-2">
                  <input
                    type="password"
                    value={pw}
                    onChange={(e) => setPw(e.target.value)}
                    placeholder="password"
                    className="w-32 rounded-md bg-background border border-border px-2.5 py-1.5 text-xs"
                  />
                  <button
                    onClick={() => setLive(false)}
                    disabled={busy || !pw}
                    className="rounded-md bg-white/[0.04] text-muted-foreground border border-border px-3 py-1.5 text-xs font-medium hover:bg-white/[0.08] disabled:opacity-40"
                  >
                    Pause
                  </button>
                </div>
              </div>
            )}
            {msg && <p className="text-[11px] mt-2 text-muted-foreground">{msg}</p>}
          </div>
        </>
      )}
    </div>
  );
}
