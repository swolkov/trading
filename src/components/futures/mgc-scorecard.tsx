"use client";

import useSWR from "swr";

interface SetupRow {
  setupType: string;
  n: number;
  wins: number;
  winRate: number;
  netR: number;
  avgR: number;
  validated: boolean;
}
interface Data {
  since: string;
  realDollars: number;
  trades: number;
  wins: number;
  losses: number;
  recent: { ts: string; exit: string; pnl: number | null }[];
  bySetup: SetupRow[];
  validatedEdge: string;
}

const fetcher = (u: string) => fetch(u).then((r) => r.json()).catch(() => null);
const money = (n: number) => `${n >= 0 ? "+" : "−"}$${Math.round(Math.abs(n))}`;
const nice = (s: string) => s.replace(/_/g, " ");

// The honest "regrade MGC from scratch" view — real $ of every live gold trade since the AI
// veto was turned off, by setup type, with the one validated edge (RSI-bounce) flagged.
export function MgcScorecard() {
  const { data } = useSWR<Data>("/api/futures/mgc-scorecard", fetcher, { refreshInterval: 60000 });
  if (!data || data.since == null) return null;
  const since = new Date(data.since).toLocaleDateString(undefined, { month: "short", day: "numeric" });

  return (
    <div className="rounded-xl border border-border bg-card p-4 space-y-3">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="text-sm font-bold">MGC Grader-Off Scorecard</h3>
          <p className="text-[10px] text-muted-foreground/50">
            Real P&amp;L of every live gold trade since the AI veto came off ({since}). This is the honest
            regrade — which setups actually make money.
          </p>
        </div>
        <span className="shrink-0 text-[9px] font-bold uppercase tracking-wider text-amber-300">VETO OFF</span>
      </div>

      <div className="grid grid-cols-3 gap-2 text-center">
        <div className="rounded-lg bg-white/[0.02] py-2">
          <p className={`text-lg font-black tabular-nums ${data.realDollars > 0 ? "text-emerald-400" : data.realDollars < 0 ? "text-red-400" : ""}`}>
            {money(data.realDollars)}
          </p>
          <p className="text-[8px] uppercase tracking-wider text-muted-foreground/45 mt-0.5">Real $ (live gold)</p>
        </div>
        <div className="rounded-lg bg-white/[0.02] py-2">
          <p className="text-lg font-black tabular-nums">{data.wins}W / {data.losses}L</p>
          <p className="text-[8px] uppercase tracking-wider text-muted-foreground/45 mt-0.5">Closed trades</p>
        </div>
        <div className="rounded-lg bg-white/[0.02] py-2">
          <p className="text-lg font-black tabular-nums">{data.trades}</p>
          <p className="text-[8px] uppercase tracking-wider text-muted-foreground/45 mt-0.5">Total taken</p>
        </div>
      </div>

      {data.trades === 0 && (
        <p className="text-[11px] text-muted-foreground/55 py-1">
          No live gold trades closed yet since the veto came off. Setups will fill in here as they trigger and close.
        </p>
      )}

      {data.bySetup.length > 0 && (
        <div className="space-y-1 pt-1 border-t border-border/50">
          <p className="text-[9px] uppercase tracking-wider text-muted-foreground/45">By setup type (live gold history)</p>
          {data.bySetup.map((s) => (
            <div key={s.setupType} className="flex items-center gap-2 text-[10px]">
              <span className={`shrink-0 w-14 font-bold tabular-nums ${s.netR > 0 ? "text-emerald-400" : s.netR < 0 ? "text-red-400" : "text-muted-foreground/60"}`}>
                {s.netR >= 0 ? "+" : ""}{s.netR.toFixed(1)}R
              </span>
              <span className="font-semibold">{nice(s.setupType)}</span>
              {s.validated && (
                <span className="text-[8px] font-bold uppercase text-emerald-400 border border-emerald-500/30 rounded px-1" title="OOS-validated edge — backtest PF ~1.24">
                  validated edge
                </span>
              )}
              <span className="text-muted-foreground/50">· {s.n} trades · {Math.round(s.winRate * 100)}% WR</span>
            </div>
          ))}
        </div>
      )}

      <p className="text-[9px] text-muted-foreground/45 pt-1 border-t border-border/40 leading-snug">
        The only OOS-validated gold edge is <span className="text-emerald-400/80 font-semibold">{nice(data.validatedEdge)}</span> (backtest
        PF ~1.24). Everything else is being proven or disproven live, from scratch. In ~2 weeks the winners get kept,
        the losers dropped.
      </p>
    </div>
  );
}
