"use client";

import useSWR from "swr";

interface Board {
  mode: string;
  resolved: number;
  rawSignals: number;
  open: number;
  wins: number;
  losses: number;
  winRate: number;
  netR: number;
  netDollars: number;
  avgR: number;
  verdict: "veto_helping" | "veto_costing" | "inconclusive";
}
interface Recent {
  ts: string | null;
  blockedAt: string | null;
  mode: string;
  symbol: string;
  direction: string;
  setupType: string;
  status: string;
  rMultiple: number | null;
  dollarPnl: number | null;
  exitReason: string | null;
}

const fetcher = (u: string) => fetch(u).then((r) => r.json()).catch(() => null);

const VERDICT: Record<Board["verdict"], { label: string; cls: string; blurb: string }> = {
  veto_helping: {
    label: "VETO IS SAVING MONEY",
    cls: "text-emerald-400",
    blurb: "The setups the AI blocked would have lost, on net. The veto is earning its keep.",
  },
  veto_costing: {
    label: "VETO IS COSTING MONEY",
    cls: "text-red-400",
    blurb: "The blocked setups would have been profitable, on net. The veto is too aggressive.",
  },
  inconclusive: {
    label: "GATHERING EVIDENCE",
    cls: "text-muted-foreground/70",
    blurb: "Not enough resolved counterfactuals yet to call it. Need ~15+ and a clear net-R.",
  },
};

function fmtR(r: number): string {
  return `${r >= 0 ? "+" : ""}${r.toFixed(1)}R`;
}

function fmtMoney(n: number): string {
  return `${n >= 0 ? "+" : "−"}$${Math.round(Math.abs(n))}`;
}

// AI-Veto Shadow Scoreboard: marks every BLOCKED setup to real price and asks whether
// the veto helped or hurt. Counterfactual — these trades never actually filled.
export function VetoScoreboard({ mode }: { mode: "live" | "demo" }) {
  const { data } = useSWR<{ live: Board; demo: Board; recent: Recent[] }>(
    "/api/futures/shadow-scoreboard",
    fetcher,
    { refreshInterval: 60000 },
  );
  const board = data?.[mode];
  const recent = (data?.recent || []).filter((r) => r.mode === mode); // full resolved history for this mode

  if (!board) return null;
  const v = VERDICT[board.verdict];
  // The veto only logs BLOCKED setups. With the grader off, nothing gets blocked → this panel is a
  // frozen historical record. HIDE it entirely when stale (newest entry >18h old) so it doesn't clutter
  // or confuse next to the live feed. It reappears automatically if the veto is turned back on and starts
  // blocking again. (The live truth while the veto is off is the MGC Scorecard.)
  const newestMs = recent[0]?.blockedAt ? new Date(recent[0].blockedAt).getTime() : 0;
  const frozen = newestMs === 0 || Date.now() - newestMs > 18 * 3600 * 1000;
  if (frozen) return null;

  return (
    <div className="rounded-xl border border-border bg-card p-4 space-y-3">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="text-sm font-bold">AI-Veto Shadow Scoreboard</h3>
          <p className="text-[10px] text-muted-foreground/50">
            Setups the AI blocked, marked to real price — <span className="text-amber-400/70">hypothetical, never filled</span>. De-clustered to real moves (the engine re-signals every 5 min; you&apos;d take one position per move).
          </p>
        </div>
        <span className={`shrink-0 text-[10px] font-bold uppercase tracking-wider ${v.cls}`}>{v.label}</span>
      </div>


      {/* Numbers show what the VETO did for you (= −trade P&L). + / green = it saved you money by
          blocking a loser; − / red = it cost you money by blocking a winner. Sign matches color. */}
      <div className="grid grid-cols-4 gap-2 text-center">
        <Stat label="Veto saved (+) / cost (−)" value={fmtMoney(-board.netDollars)} cls={-board.netDollars > 0 ? "text-emerald-400" : -board.netDollars < 0 ? "text-red-400" : ""} />
        <Stat label="In R" value={fmtR(-board.netR)} cls={-board.netR > 0 ? "text-emerald-400" : -board.netR < 0 ? "text-red-400" : ""} />
        <Stat label="Would-be WR" value={board.wins + board.losses > 0 ? `${Math.round(board.winRate * 100)}%` : "—"} />
        <Stat label="Moves / raw signals" value={`${board.resolved} / ${board.rawSignals}`} />
      </div>

      <p className="text-[10px] text-muted-foreground/55 leading-snug">{v.blurb}</p>

      {recent.length > 0 && (
        <div className="pt-1 border-t border-border/50">
          <p className="text-[9px] uppercase tracking-wider text-muted-foreground/45 pb-1">
            All raw 5-min signals ({recent.length}) — the headline above counts each move once, not every repeat
          </p>
          <div className="space-y-1 max-h-64 overflow-y-auto pr-1">
            {recent.map((r, i) => {
              const vetoVal = -(r.dollarPnl ?? 0); // what blocking this did for you
              const good = vetoVal >= 0;            // + = dodged a loser, − = missed a winner
              const when = r.blockedAt ? new Date(r.blockedAt) : null;
              const dateStr = when
                ? `${when.toLocaleDateString(undefined, { month: "short", day: "numeric" })} ${when.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}`
                : "—";
              return (
                <div key={i} className="flex items-center gap-2 text-[10px]">
                  <span className="shrink-0 w-[68px] text-muted-foreground/45 tabular-nums">{dateStr}</span>
                  <span
                    className={`shrink-0 w-12 font-bold tabular-nums ${good ? "text-emerald-400" : "text-red-400"}`}
                    title={good ? `Good block — the veto saved you ${fmtMoney(vetoVal)}` : `Missed winner — the veto cost you ${fmtMoney(vetoVal)}`}
                  >
                    {r.dollarPnl != null ? fmtMoney(vetoVal) : ""}
                  </span>
                  <span className="font-semibold">{r.symbol} {r.direction?.toUpperCase()}</span>
                  <span className="text-muted-foreground/50 truncate">· {r.setupType?.replace(/_/g, " ")} · {good ? "dodged a loser" : "missed a winner"}</span>
                </div>
              );
            })}
          </div>
          <p className="text-[9px] text-muted-foreground/40 pt-1">
            Green = the veto <b>saved</b> you money (blocked a loser). Red = it <b>cost</b> you money (missed a winner). The number is what the veto saved/cost — not the trade&apos;s own P&amp;L.
          </p>
        </div>
      )}
    </div>
  );
}

function Stat({ label, value, cls = "" }: { label: string; value: string; cls?: string }) {
  return (
    <div className="rounded-lg bg-white/[0.02] py-2">
      <p className={`text-base font-black tabular-nums ${cls}`}>{value}</p>
      <p className="text-[8px] uppercase tracking-wider text-muted-foreground/45 mt-0.5">{label}</p>
    </div>
  );
}
