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
  totalInvested: number; // deposited capital
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

  const perCoin = data.config?.kraken_per_coin_usd || "250";
  const coins = data.config?.kraken_coins || "BTC/USD,ETH/USD";
  const pnl = data.totalValue - data.totalInvested;

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
        <h2 className="font-semibold text-sm">BTC/ETH Trend-Follower</h2>
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
          Funded, built, and ready. Activates once <code className="bg-muted px-1 rounded">KRAKEN_API_KEY</code> / <code className="bg-muted px-1 rounded">KRAKEN_API_SECRET</code> (a fresh trade-only key) are added in the Vercel environment. Holds {coins.replace(/\/USD/g, "")} while above the 50-day trend, sells to cash below it.
        </p>
      ) : (
        <>
          <div className="grid grid-cols-4 gap-3 text-center">
            <div><p className="text-[10px] text-muted-foreground/50">Cash</p><p className="text-sm font-bold tabular-nums">{fmt(data.usd)}</p></div>
            <div><p className="text-[10px] text-muted-foreground/50">Deposited</p><p className="text-sm font-bold tabular-nums">{fmt(data.totalInvested)}</p></div>
            <div><p className="text-[10px] text-muted-foreground/50">Value</p><p className="text-sm font-bold tabular-nums">{fmt(data.totalValue)}</p></div>
            <div><p className="text-[10px] text-muted-foreground/50">P&amp;L</p><p className={`text-sm font-bold tabular-nums ${pnl >= 0 ? "text-emerald-400" : "text-red-400"}`}>{fmt(pnl)}</p></div>
          </div>
          {data.holdings.length > 0 ? (
            <div className="space-y-1">
              <p className="text-[10px] text-muted-foreground/50 uppercase tracking-wider">Positions</p>
              {data.holdings.map((h) => (
                <div key={h.coin} className="flex items-center justify-between text-[11px] px-2 py-1 rounded bg-white/[0.02]">
                  <span className="font-semibold">{h.coin.replace("/USD", "")} <span className={h.aboveTrend ? "text-emerald-400/70" : "text-red-400/70"}>{h.aboveTrend ? "↑ trend" : "↓ trend"}</span></span>
                  <span className="tabular-nums text-muted-foreground/70">{h.amount.toFixed(6)} @ {fmt(h.price)}</span>
                  <span className="tabular-nums font-medium">{fmt(h.value)}</span>
                </div>
              ))}
            </div>
          ) : (
            <div className="text-[11px] text-muted-foreground/55 px-2 py-1.5 rounded bg-white/[0.02]">
              <span className="font-semibold text-foreground/70">Positions: none — 100% cash.</span> Waiting for a dip in an uptrend; when it buys, BTC/ETH holdings appear right here.
            </div>
          )}
          <p className="text-[10px] text-muted-foreground/45">Trades: {data.buyCount} · ${perCoin}/coin · {coins.replace(/\/USD/g, "")} · hold above 50-day, sell below{data.validateOnly ? " · validate mode = no real orders yet" : ""}</p>

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
                <span className="text-[11px] text-emerald-400 font-semibold">🟢 LIVE — trend-following</span>
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
