"use client";

import useSWR from "swr";

interface Recent { ts: string; sym: string; exit: string; pnl: number | null }
interface Edge {
  name: string;
  blurb: string;
  net: number;
  trades: number;
  wins: number;
  losses: number;
  winRate: number;
  recent: Recent[];
}
interface Board { since: string; totalNet: number; totalTrades: number; edges: Edge[] }

const fetcher = (u: string) => fetch(u).then((r) => r.json()).catch(() => null);
const money = (n: number) => `${n >= 0 ? "+" : "−"}$${Math.abs(n).toFixed(0)}`;
const col = (n: number) => (n > 0 ? "text-emerald-400" : n < 0 ? "text-red-400" : "text-muted-foreground");

// Per-edge scoreboard — watch each edge prove or disprove itself on REAL P&L. Works for BOTH the live
// account and the demo shadow-test (mode prop); demo reads its own reset-today window.
export function EdgeScoreboard({ mode = "live" }: { mode?: "live" | "demo" }) {
  const { data } = useSWR<Board>(`/api/futures/edge-scoreboard${mode === "demo" ? "?mode=demo" : ""}`, fetcher, { refreshInterval: 30000 });
  if (!data?.edges) return (
    <div className="space-y-3">
      <SwingSection />
    </div>
  );
  const isDemo = mode === "demo";

  return (
    <div className="space-y-3">
    <div className={`rounded-xl border p-4 space-y-3 ${isDemo ? "border-amber-500/25 bg-amber-500/[0.02]" : "border-border bg-card"}`}>
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="text-sm font-bold">Edge Test Scoreboard <span className="text-[10px] font-normal text-muted-foreground/50">· {isDemo ? "DEMO shadow — paper" : "which edge works · live"}</span></h3>
          <p className="text-[10px] text-muted-foreground/50">
            {isDemo
              ? <>Per-edge P&amp;L on the <strong>demo shadow-test</strong> (1-contract, reset today) — same edges as live, on paper. Research, not proof.</>
              : <>Per-edge P&amp;L (split by direction) on clean trades — is each edge actually working? Excludes the Jul 16–17 tracking incident; your <strong>account balance</strong> is the authoritative total P&amp;L.</>}
          </p>
        </div>
        <div className="text-right shrink-0">
          <p className={`text-lg font-black tabular-nums ${col(data.totalNet)}`}>{money(data.totalNet)}</p>
          <p className="text-[8px] uppercase tracking-wider text-muted-foreground/45">per-edge sum · {data.totalTrades} trades</p>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        {data.edges.map((e) => {
          const resolved = e.wins + e.losses;
          return (
            <div key={e.name} className="rounded-lg border border-border/50 bg-white/[0.02] p-3 space-y-2">
              <div className="flex items-center justify-between gap-2">
                <span className="text-xs font-bold">{e.name}</span>
                <span className={`text-base font-black tabular-nums ${col(e.net)}`}>{money(e.net)}</span>
              </div>
              <div className="flex items-center gap-3 text-[10px] text-muted-foreground/60">
                <span>{e.trades} trades</span>
                <span>{resolved > 0 ? `${Math.round(e.winRate * 100)}% win` : "—"}</span>
                <span>{e.wins}W · {e.losses}L</span>
              </div>
              {e.recent.length > 0 ? (
                <div className="space-y-0.5 pt-1 border-t border-border/40">
                  {e.recent.slice(0, 5).map((r, i) => (
                    <div key={i} className="flex items-center justify-between text-[10px]">
                      <span className="text-muted-foreground/50 tabular-nums">
                        {new Date(r.ts).toLocaleDateString(undefined, { month: "short", day: "numeric" })} · {r.sym} · {r.exit}
                      </span>
                      <span className={`font-semibold tabular-nums ${col(r.pnl ?? 0)}`}>{r.pnl != null ? money(r.pnl) : ""}</span>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="text-[10px] text-muted-foreground/40 pt-1 border-t border-border/40">No trades yet — waiting for a setup.</p>
              )}
              <p className="text-[9px] text-muted-foreground/40 leading-snug">{e.blurb}</p>
            </div>
          );
        })}
      </div>
    </div>

      <SwingSection />
    </div>
  );
}

// ── Daily Index Mean-Reversion — NEW experimental paper forward-test ──

interface SwingClosed { symbol: string; entryPrice: number; exitPrice: number; entryDate: string; exitDate: string; pnl: number; reason: string }
interface SwingOpen { symbol: string; entryPrice: number; entryDate: string; stop: number; riskUsd?: number }
interface SwingWatch { symbol: string; micro?: string; rsi: number | null; entryTrigger: number; inPosition: boolean; riskUsd?: number | null; dataOk?: boolean }
interface SwingPerf {
  net: number; trades: number; wins: number; losses: number; winRate: number;
  recent: SwingClosed[]; open: SwingOpen[]; watching: SwingWatch[];
}

const reasonLabel = (r: string) =>
  r === "rsi_exit" ? "RSI≥50" : r === "stop" ? "stop" : r === "stop_gap" ? "stop (gap)" : r === "time_stop" ? "30d time" : r;

function SwingSection() {
  const { data } = useSWR<SwingPerf>("/api/futures/swing-scoreboard", fetcher, { refreshInterval: 60000 });
  if (!data || typeof data.net !== "number") return null;
  const resolved = data.wins + data.losses;

  return (
    <div className="rounded-xl border border-indigo-500/30 bg-indigo-500/[0.03] p-4 space-y-3">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="text-sm font-bold text-indigo-300">
            Daily Index Mean-Reversion — swing <span className="text-[9px] font-bold uppercase tracking-wider text-indigo-400/80 align-middle">NEW</span>
          </h3>
          <p className="text-[10px] text-muted-foreground/50">
            Daily RSI&lt;30 dip-buy on ES/NQ/YM (1-micro paper, 200-SMA trend filter). Fires ~6–10×/yr on oversold dips; paper forward-test.
          </p>
          <p className="text-[9px] text-muted-foreground/40">
            Validated on two data vendors: ES PF 3.14/2.47 · NQ 2.22 · YM 1.79 — positive in every 5-yr block, 2000–2026.
            Russell and gold failed the same test and are excluded.
          </p>
        </div>
        <div className="text-right shrink-0">
          <p className={`text-lg font-black tabular-nums ${col(data.net)}`}>{money(data.net)}</p>
          <p className="text-[8px] uppercase tracking-wider text-muted-foreground/45">
            {data.trades} trades · {resolved > 0 ? `${Math.round(data.winRate * 100)}% win` : "—"}
          </p>
        </div>
      </div>

      {/* Watching line per symbol */}
      <div className="grid grid-cols-3 gap-2">
        {data.watching.map((w) => (
          <div key={w.symbol} className="rounded-lg border border-indigo-500/20 bg-white/[0.02] p-2">
            <div className="flex items-center justify-between gap-1">
              <span className="text-xs font-bold">
                {w.symbol}
                {w.micro && <span className="text-[8px] font-medium text-muted-foreground/40 ml-1">{w.micro}</span>}
              </span>
              {w.inPosition ? (
                <span className="text-[9px] font-semibold uppercase tracking-wider text-emerald-400">in position</span>
              ) : (
                <span className={`text-[10px] tabular-nums ${w.rsi != null && w.rsi < w.entryTrigger ? "text-emerald-400" : "text-muted-foreground/60"}`}>
                  {w.rsi != null ? `RSI ${w.rsi.toFixed(0)}` : "—"} <span className="text-muted-foreground/40">/ &lt;{w.entryTrigger}</span>
                </span>
              )}
            </div>
            {w.dataOk === false ? (
              // A short data feed silently disables a symbol — say so instead of showing "watching".
              <p className="text-[9px] text-amber-400/80 mt-0.5">data feed short — not evaluated</p>
            ) : !w.inPosition ? (
              <p className="text-[9px] text-muted-foreground/40 mt-0.5">
                {w.rsi != null && w.rsi < w.entryTrigger ? "oversold — trigger armed" : "watching for dip"}
                {w.riskUsd ? <span className="text-muted-foreground/30"> · ~${w.riskUsd} risk</span> : null}
              </p>
            ) : null}
          </div>
        ))}
      </div>

      {/* Open positions */}
      {data.open.length > 0 && (
        <div className="space-y-1 pt-1 border-t border-indigo-500/20">
          <p className="text-[9px] uppercase tracking-wider text-indigo-400/70">Open paper positions</p>
          {data.open.map((o, i) => (
            <div key={i} className="flex items-center justify-between text-[10px]">
              <span className="text-muted-foreground/60 tabular-nums">
                {o.symbol} · entry {o.entryPrice.toFixed(2)} · {new Date(o.entryDate).toLocaleDateString(undefined, { month: "short", day: "numeric" })}
              </span>
              <span className="text-muted-foreground/45 tabular-nums">
                stop {o.stop.toFixed(2)}
                {o.riskUsd ? <span className="text-muted-foreground/30"> · ${o.riskUsd} risk</span> : null}
              </span>
            </div>
          ))}
        </div>
      )}

      {/* Recent closed */}
      {data.recent.length > 0 ? (
        <div className="space-y-0.5 pt-1 border-t border-indigo-500/20">
          {data.recent.slice(0, 8).map((r, i) => (
            <div key={i} className="flex items-center justify-between text-[10px]">
              <span className="text-muted-foreground/50 tabular-nums">
                {new Date(r.exitDate).toLocaleDateString(undefined, { month: "short", day: "numeric" })} · {r.symbol} · {reasonLabel(r.reason)}
              </span>
              <span className={`font-semibold tabular-nums ${col(r.pnl)}`}>{money(r.pnl)}</span>
            </div>
          ))}
        </div>
      ) : data.open.length === 0 ? (
        <p className="text-[10px] text-muted-foreground/40 pt-1 border-t border-indigo-500/20">No trades yet — waiting for a daily RSI&lt;30 dip.</p>
      ) : null}
    </div>
  );
}
