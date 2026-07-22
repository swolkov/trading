"use client";

import useSWR from "swr";

const fetcher = (u: string) => fetch(u).then((r) => r.json()).catch(() => null);
const money = (n: number) => `${n >= 0 ? "+" : "−"}$${Math.abs(n).toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
const money2 = (n: number) => `${n >= 0 ? "+" : "−"}$${Math.abs(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const col = (n: number) => (n > 0 ? "text-emerald-400" : n < 0 ? "text-red-400" : "text-muted-foreground");

// Authoritative futures stats shape returned by GET /api/futures/live-pnl(?mode=demo) — the SAME
// balance-based, incident-excluded round-trip set that drives the Track Record header and the
// Futures Performance panel. Both columns on this page read this one source so they are directly
// comparable — demo = 1 mini on ~$75k paper, live = 1 micro on ~$5k real, comparable risk.
interface Stats {
  ok: boolean;
  netPnl: number;
  currentBalance: number;
  startingCapital: number;
  netDeposits: number;
  roundTrips: number;
  wins: number;
  losses: number;
  winRate: number;
  avgWin: number;
  avgLoss: number;
  best: { pnl: number; sym: string } | null;
  worst: { pnl: number; sym: string } | null;
  last24h: number;
  last7d: number;
  last30d: number;
}

function Metric({ label, children, sub }: { label: string; children: React.ReactNode; sub?: string }) {
  return (
    <div>
      <p className="text-[10px] text-muted-foreground/40 uppercase tracking-wider">{label}</p>
      <p className="text-sm font-bold tabular-nums">{children}</p>
      {sub && <p className="text-[9px] text-muted-foreground/30">{sub}</p>}
    </div>
  );
}

function StatColumn({
  stats,
  title,
  tag,
  tagClass,
  accountLine,
}: {
  stats: Stats | null | undefined;
  title: string;
  tag: string;
  tagClass: string;
  accountLine: string;
}) {
  const ok = !!stats?.ok;
  return (
    <div className="rounded-xl border border-border bg-card p-4 space-y-3">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-sm font-bold">{title}</h2>
        <span className={`text-[9px] font-bold px-1.5 py-0.5 rounded border ${tagClass}`}>{tag}</span>
      </div>

      {/* Total P&L — broker balance delta */}
      <div>
        <p className="text-[10px] text-muted-foreground/40 uppercase tracking-wider">Total P&L</p>
        {ok ? (
          <p className={`text-2xl font-black tabular-nums ${col(stats!.netPnl)}`}>{money2(stats!.netPnl)}</p>
        ) : (
          <p className="text-2xl font-black tabular-nums text-muted-foreground/40">—</p>
        )}
        <p className="text-[9px] text-muted-foreground/30">{stats?.roundTrips ?? 0} trades · broker balance · {accountLine}</p>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <Metric label="Win Rate" sub={`${stats?.wins ?? 0}W / ${stats?.losses ?? 0}L`}>
          {(stats?.roundTrips ?? 0) > 0 ? `${((stats!.winRate) * 100).toFixed(0)}%` : "—"}
        </Metric>
        <Metric label="Round Trips" sub="paired closes">
          {stats?.roundTrips ?? 0}
        </Metric>
        <Metric label="Avg Win">
          <span className="text-emerald-400">{(stats?.wins ?? 0) > 0 ? `+$${stats!.avgWin.toFixed(0)}` : "—"}</span>
        </Metric>
        <Metric label="Avg Loss">
          <span className="text-red-400">{(stats?.losses ?? 0) > 0 ? `-$${Math.abs(stats!.avgLoss).toFixed(0)}` : "—"}</span>
        </Metric>
        <Metric label="Best Trade" sub={stats?.best?.sym}>
          {stats?.best ? <span className={col(stats.best.pnl)}>{money(stats.best.pnl)}</span> : "—"}
        </Metric>
        <Metric label="Worst Trade" sub={stats?.worst?.sym}>
          {stats?.worst ? <span className={col(stats.worst.pnl)}>{money(stats.worst.pnl)}</span> : "—"}
        </Metric>
      </div>

      <div className="pt-2 border-t border-white/[0.06] space-y-1.5">
        {([["24h", stats?.last24h ?? 0], ["7d", stats?.last7d ?? 0], ["30d", stats?.last30d ?? 0]] as const).map(([label, val]) => (
          <div key={label} className="flex justify-between items-center">
            <span className="text-[10px] text-muted-foreground/40">{label}</span>
            <span className={`text-xs font-bold tabular-nums ${col(val)}`}>{money2(val)}</span>
          </div>
        ))}
        <p className="text-[8px] text-muted-foreground/25 pt-0.5">realized round-trip P&L per window</p>
      </div>
    </div>
  );
}

export default function DemoVsLivePage() {
  const { data: live } = useSWR<Stats>("/api/futures/live-pnl", fetcher, { refreshInterval: 60000 });
  const { data: demo } = useSWR<Stats>("/api/futures/live-pnl?mode=demo", fetcher, { refreshInterval: 60000 });

  return (
    <div className="max-w-5xl mx-auto p-4 md:p-6 space-y-5">
      <div>
        <h1 className="text-xl font-bold">Demo vs Live — same strategy, two accounts</h1>
        <p className="text-xs text-muted-foreground/70 mt-1 max-w-2xl">
          Both sides now run the <span className="font-semibold">same disciplined 1-contract strategy</span> — only the
          size and stakes differ. Demo trades <span className="font-semibold">1 mini on ~$75k of paper money</span> (research,
          reset today for a fresh forward-test); live trades <span className="font-semibold">1 micro on ~$5k of real money</span>.
          Both numbers below come from the <span className="font-semibold">same authoritative source</span> — broker balance
          delta and a clean, incident-excluded round-trip set — so they are directly comparable.
        </p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <StatColumn
          stats={demo}
          title="Demo"
          tag="PAPER · RESEARCH"
          tagClass="bg-amber-500/15 text-amber-400 border-amber-500/30"
          accountLine="1 mini · ~$75k paper · reset today"
        />
        <StatColumn
          stats={live}
          title="Live"
          tag="REAL MONEY"
          tagClass="bg-red-500/15 text-red-400 border-red-500/30"
          accountLine="1 micro · ~$5k real"
        />
      </div>

      <div className="rounded-xl border border-border bg-white/[0.02] p-4 text-[12px] leading-relaxed text-muted-foreground/80 space-y-2">
        <p className="font-semibold text-foreground">How to read this</p>
        <p>
          Demo is the research sandbox — the same edge gate and 1-contract discipline as live, but on paper money, so a
          bad stretch costs nothing real. Live is the same strategy sized down to 1 micro on the real ~$5k account with a
          hard 25% kill switch. Because demo is a mini (10× the dollars-per-point of a micro) on a larger paper balance,
          its per-trade dollar swings are bigger — the <span className="font-semibold">shape</span> (win rate, best/worst,
          direction) is what&apos;s comparable, not the absolute dollars.
        </p>
        <p>
          Demo P&L is <span className="font-semibold text-foreground">research, not proof</span>. If demo stays positive
          across more months — especially through a losing stretch — that&apos;s the evidence to widen live&apos;s gate.
          Until then, live stays disciplined, and the real lever for bigger numbers is{" "}
          <span className="font-semibold text-foreground">more capital</span>.
        </p>
      </div>
    </div>
  );
}
