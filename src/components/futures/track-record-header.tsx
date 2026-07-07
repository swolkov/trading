"use client";

import useSWR from "swr";

interface Edge { name: string; net: number; trades: number; wins: number; losses: number; winRate: number }
interface Board { since: string; totalNet: number; totalTrades: number; edges: Edge[] }
interface Acct { account?: { netLiq?: number } }

const fetcher = (u: string) => fetch(u).then((r) => r.json()).catch(() => null);
const money = (n: number) => `${n >= 0 ? "+" : "−"}$${Math.abs(n).toFixed(0)}`;

// Investor-grade track-record header for the futures edge. Shows the REAL live results since strategy
// inception, the (clearly-labeled) backtest durability evidence, and the disclaimers required when talking
// to investors. Honest by construction — the live numbers are whatever they actually are.
export function TrackRecordHeader() {
  const { data: board } = useSWR<Board>("/api/futures/edge-scoreboard", fetcher, { refreshInterval: 30000 });
  const { data: pos } = useSWR<Acct>("/api/futures/positions?mode=live", fetcher, { refreshInterval: 30000 });

  const inception = board?.since ? new Date(board.since) : null;
  const capital = pos?.account?.netLiq ?? null;
  const net = board?.totalNet ?? 0;
  const resolved = (board?.edges || []).reduce((s, e) => s + e.wins + e.losses, 0);
  const wins = (board?.edges || []).reduce((s, e) => s + e.wins, 0);
  const winRate = resolved > 0 ? Math.round((wins / resolved) * 100) : null;

  return (
    <div className="rounded-xl border border-border bg-gradient-to-b from-white/[0.03] to-transparent p-5 space-y-4">
      <div>
        <h2 className="text-lg font-black tracking-tight">Systematic Gold Mean-Reversion — Futures</h2>
        <p className="text-[11px] text-muted-foreground/60">
          Rules-based intraday mean-reversion on micro futures (MGC / MNQ / MES), fixed-fractional risk, hard kill switch.
        </p>
      </div>

      {/* LIVE track record — the only numbers that matter to an allocator */}
      <div>
        <p className="text-[9px] uppercase tracking-widest text-emerald-400/70 font-bold mb-1.5">Live track record</p>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <Stat label="Inception" value={inception ? inception.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" }) : "—"} />
          <Stat label="Live capital" value={capital != null ? `$${Math.round(capital).toLocaleString()}` : "—"} />
          <Stat label="Net P&L (live)" value={board ? money(net) : "—"} cls={net > 0 ? "text-emerald-400" : net < 0 ? "text-red-400" : ""} />
          <Stat label="Trades · win rate" value={board ? `${board.totalTrades} · ${winRate != null ? winRate + "%" : "—"}` : "—"} />
        </div>
      </div>

      {/* BACKTEST durability — clearly labeled as hypothetical/supporting, never mixed with live */}
      <div className="rounded-lg bg-white/[0.02] border border-border/50 p-3">
        <p className="text-[9px] uppercase tracking-widest text-muted-foreground/45 font-bold mb-1">Backtest durability (hypothetical — supporting evidence only)</p>
        <p className="text-[11px] text-muted-foreground/70 leading-snug">
          Core edge (gold oversold-bounce) tested on <b>26 years</b> of daily data (2000–2026):
          profit factor <b>~1.58</b>, <b>positive in every 5-year block</b> across the 2008 crisis, the 2011–2015 gold bear,
          COVID, and 2020–2026. The 3-year intraday version (the live strategy) runs thinner (PF ~1.1–1.2).
        </p>
      </div>

      <p className="text-[9px] text-muted-foreground/40 leading-snug border-t border-border/40 pt-2">
        Disclaimer: Live track record began {inception ? inception.toLocaleDateString(undefined, { month: "long", year: "numeric" }) : "recently"} and is short.
        Backtested/hypothetical results are not indicative of future performance and have inherent limitations.
        This is not an offer to sell or a solicitation to invest, not investment advice, and does not guarantee any return.
        Futures trading involves substantial risk of loss.
      </p>
    </div>
  );
}

function Stat({ label, value, cls = "" }: { label: string; value: string; cls?: string }) {
  return (
    <div className="rounded-lg bg-white/[0.02] py-2 px-3">
      <p className={`text-base font-black tabular-nums ${cls}`}>{value}</p>
      <p className="text-[8px] uppercase tracking-wider text-muted-foreground/45 mt-0.5">{label}</p>
    </div>
  );
}
