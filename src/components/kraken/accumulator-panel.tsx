"use client";

import useSWR from "swr";
import { useState } from "react";

interface Holding {
  coin: string; amount: number; price: number; value: number; aboveTrend: boolean;
  sma50: number | null;
  exitPrice: number | null;   // the hysteresis-adjusted 50-day line the agent actually tests against
  pctToExit: number | null;   // how far price must fall from here to trigger the sell (negative)
}
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
  strategyCapital: number;
  strategyPnl: number;
  otherValue: number;
  otherCost: number;
  otherAssets: { asset: string; value: number }[];
  splitOk: boolean;
  mode: string;
  buyCount: number;
  config: Record<string, string>;
  lastRunTs?: string;
  cronLastRun?: string;
  flowsAsOf?: string;
  error?: string;
}

// Relative age, plus the staleness thresholds that decide whether to warn. These exist because a
// two-day-old deposited-capital figure once made the panel report ~$6,500 of profit that was
// actually Spencer's own deposit — with nothing on screen indicating the number was old.
const RUN_STALE_MS = 90 * 60 * 1000;    // cron is every 30 min, so 3 missed ticks
const FLOWS_STALE_MS = 3 * 60 * 60 * 1000; // ledger figure refreshes hourly on the cron
function ageMs(iso?: string): number | null {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  return Number.isFinite(t) ? Date.now() - t : null;
}
function ago(iso?: string): string {
  const ms = ageMs(iso);
  if (ms === null) return "never";
  const m = Math.floor(ms / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
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
  // Headline the STRATEGY's own P&L when the two books could be told apart. Blending a hand-picked
  // meme position into this number would make the track record measure something we did not do.
  const pnl = data.splitOk ? data.strategyPnl : data.totalValue - data.totalInvested;
  const pnlBase = data.splitOk ? data.strategyCapital : data.totalInvested;
  const pnlPct = pnlBase > 0 ? (pnl / pnlBase) * 100 : 0;
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
            <div><p className="text-[10px] text-muted-foreground/50">{data.splitOk ? "Strategy capital" : "Deposited"}</p><p className="text-sm font-bold tabular-nums">{fmt(pnlBase)}</p></div>
            <div><p className="text-[10px] text-muted-foreground/50">{data.splitOk ? "Strategy value" : "Value"}</p><p className="text-sm font-bold tabular-nums">{fmt(data.splitOk ? data.strategyValue : data.totalValue)}</p></div>
            <div><p className="text-[10px] text-muted-foreground/50">P&amp;L</p><p className={`text-sm font-bold tabular-nums ${pnl >= 0 ? "text-emerald-400" : "text-red-400"}`}>{fmt(pnl)}<span className="text-[10px] font-medium opacity-70"> {pnl >= 0 ? "+" : ""}{pnlPct.toFixed(1)}%</span></p></div>
          </div>
          {data.otherValue > 0 && (
            <div className="rounded-md border border-border/60 bg-white/[0.02] px-2.5 py-2 space-y-1">
              <p className="text-[10px] uppercase tracking-wider text-muted-foreground/50">Your own book — not managed here</p>
              <div className="flex items-center justify-between text-[11px]">
                <span className="text-muted-foreground/70">{data.otherAssets.map((a) => a.asset).join(", ")}</span>
                <span className="tabular-nums">
                  {fmt(data.otherValue)}
                  {data.splitOk && (
                    <span className={`ml-1.5 font-semibold ${data.otherValue - data.otherCost >= 0 ? "text-emerald-400" : "text-red-400"}`}>
                      {data.otherValue - data.otherCost >= 0 ? "+" : ""}{fmt(data.otherValue - data.otherCost)}
                    </span>
                  )}
                </span>
              </div>
              <p className="text-[10px] text-muted-foreground/45">
                {data.splitOk
                  ? <>Bought by hand. {fmt(data.otherCost)} of deposits went into these, so it is excluded from the strategy&apos;s cost basis above — the trend follower is judged only on its own money.</>
                  : <>Bought by hand. The trend follower never buys or sells these; the P&amp;L above is account-wide and includes them.</>}
              </p>
            </div>
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
                <div key={h.coin} className="rounded bg-white/[0.02]">
                <div className="flex items-center justify-between text-[11px] px-2 py-1">
                  <span className="font-semibold">
                    {h.coin.replace("/USD", "")}{" "}
                    {/* Judge by the SAME hysteresis-adjusted line the agent uses, not the raw 50-day
                        cross. Price can sit below the 50-day but inside the 1.5% band, where the
                        engine deliberately HOLDS — the old badge called that "exits next run". */}
                    {(h.pctToExit != null ? h.pctToExit < 0 : h.aboveTrend)
                      ? <span className="text-emerald-400/70">↑ holding</span>
                      : <span className="text-amber-400/80">↓ below exit — sells next check</span>}
                  </span>
                  <span className="tabular-nums text-muted-foreground/70">{h.amount.toFixed(6)} @ {fmt(h.price)}</span>
                  <span className="tabular-nums font-medium">{fmt(h.value)}</span>
                </div>
                {h.exitPrice != null && h.pctToExit != null && (
                  <p className="text-[10px] px-2 pb-0.5 text-muted-foreground/45">
                    {h.pctToExit < 0 ? (
                      <>
                        sells below <span className="tabular-nums font-medium text-foreground/60">{fmt(h.exitPrice)}</span>
                        {" — "}
                        <span className={h.pctToExit > -5 ? "text-amber-400/85 font-semibold" : ""}>
                          a {Math.abs(h.pctToExit).toFixed(1)}% drop from here
                        </span>
                        {h.pctToExit > -5 && " ⚠ close to the exit"}
                      </>
                    ) : (
                      <span className="text-amber-400/85 font-semibold">
                        already {h.pctToExit.toFixed(1)}% past its exit line ({fmt(h.exitPrice)}) — sells on the next check
                      </span>
                    )}
                  </p>
                )}
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

          {/* Health strip — is the thing actually running, and is what it shows current?
              Without this a stale figure looks identical to a fresh one. */}
          {(() => {
            const runAge = ageMs(data.lastRunTs);
            const flowsAge = ageMs(data.flowsAsOf);
            const runStale = runAge === null || runAge > RUN_STALE_MS;
            const flowsStale = data.investedSource !== "kraken-ledger" || flowsAge === null || flowsAge > FLOWS_STALE_MS;
            return (
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-border/60 pt-2 text-[10px]">
                <span className="uppercase tracking-wider text-muted-foreground/40">Health</span>
                <span className={runStale ? "text-amber-400/85 font-semibold" : "text-muted-foreground/50"}>
                  last check {ago(data.lastRunTs)}{runStale ? " ⚠ overdue" : ""}
                </span>
                <span className="text-muted-foreground/25">·</span>
                <span className={flowsStale ? "text-amber-400/85 font-semibold" : "text-muted-foreground/50"}>
                  deposits figure {ago(data.flowsAsOf)}{flowsStale ? " ⚠ stale" : ""}
                </span>
                <span className="text-muted-foreground/25">·</span>
                <span className="text-muted-foreground/50">checks every 30 min</span>
              </div>
            );
          })()}

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
