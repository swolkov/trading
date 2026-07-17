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

// Two-edge live scoreboard — watch the $5k test prove or disprove itself, per edge, on REAL P&L.
export function EdgeScoreboard() {
  const { data } = useSWR<Board>("/api/futures/edge-scoreboard", fetcher, { refreshInterval: 30000 });
  if (!data?.edges) return null;

  return (
    <div className="rounded-xl border border-border bg-card p-4 space-y-3">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="text-sm font-bold">Edge Test Scoreboard <span className="text-[10px] font-normal text-muted-foreground/50">· real money, per edge</span></h3>
          <p className="text-[10px] text-muted-foreground/50">
            Live P&amp;L per edge (split by direction) since the test began. This is the truth — is each edge actually working?
          </p>
        </div>
        <div className="text-right shrink-0">
          <p className={`text-lg font-black tabular-nums ${col(data.totalNet)}`}>{money(data.totalNet)}</p>
          <p className="text-[8px] uppercase tracking-wider text-muted-foreground/45">{data.totalTrades} trades total</p>
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
  );
}
