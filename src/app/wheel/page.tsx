"use client";

import useSWR from "swr";

const fetcher = (url: string) => fetch(url).then((r) => r.json());

interface ShortLeg { optSymbol: string; underlying: string; strike: number; expiry: string; contracts: number; credit: number; opened: string; }
interface ShareLot { qty: number; costBasis: number; }
interface WheelState {
  startCapital: number; cash: number; premiumCollected: number; realizedPnl: number;
  assignments: number; calledAway: number;
  shortPuts: ShortLeg[]; shortCalls: ShortLeg[]; shares: Record<string, ShareLot>;
  started: string; lastRun: string | null;
}
type LedgerRow = Record<string, number | string>;

function money(v: number) { return (v < 0 ? "-$" : "$") + Math.abs(v).toLocaleString(undefined, { maximumFractionDigits: 0 }); }
function pnlColor(v: number) { return v > 0 ? "text-emerald-400" : v < 0 ? "text-red-400" : "text-muted-foreground"; }
const dte = (exp: string) => Math.max(0, Math.round((new Date(exp + "T00:00:00Z").getTime() - Date.now()) / 86400000));

function Stat({ label, value, sub, color }: { label: string; value: string; sub?: string; color?: string }) {
  return (
    <div className="rounded-xl border border-white/[0.06] bg-white/[0.02] p-4">
      <div className="text-[10px] font-semibold tracking-[0.12em] text-muted-foreground/50 uppercase">{label}</div>
      <div className={`mt-1.5 text-xl font-bold tabular-nums ${color || "text-foreground"}`}>{value}</div>
      {sub && <div className="mt-0.5 text-[11px] text-muted-foreground/60">{sub}</div>}
    </div>
  );
}

function EquityCurve({ ledger, start }: { ledger: LedgerRow[]; start: number }) {
  if (ledger.length < 2) {
    return <div className="text-xs text-muted-foreground/60 py-8 text-center">Equity curve builds as the daily track record grows — {ledger.length} day{ledger.length === 1 ? "" : "s"} so far.</div>;
  }
  const W = 800, H = 140, pad = 6;
  const eq = ledger.map((r) => Number(r.equity));
  const min = Math.min(...eq, start), max = Math.max(...eq, start);
  const span = (max - min) || 1;
  const x = (i: number) => pad + (i / (eq.length - 1)) * (W - 2 * pad);
  const y = (v: number) => H - pad - ((v - min) / span) * (H - 2 * pad);
  const pts = eq.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ");
  const last = eq[eq.length - 1];
  const color = last >= start ? "#34d399" : "#f87171";
  const baseY = y(start).toFixed(1);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="w-full h-32">
      <line x1="0" y1={baseY} x2={W} y2={baseY} stroke="currentColor" strokeWidth="1" strokeDasharray="3 3" className="text-muted-foreground/20" />
      <polyline points={pts} fill="none" stroke={color} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}

export default function WheelPage() {
  const { data, isLoading } = useSWR<{ state: WheelState | null; ledger: LedgerRow[]; lastRun: string | null }>("/api/wheel", fetcher, { refreshInterval: 60000 });

  if (isLoading) return (
    <div className="space-y-5 animate-fade-up">
      <div><div className="skeleton h-6 w-40 rounded mb-2" /><div className="skeleton h-3 w-72 rounded" /></div>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">{Array.from({ length: 4 }).map((_, i) => <div key={i} className="rounded-xl border border-white/[0.06] bg-white/[0.02] p-4"><div className="skeleton h-3 w-14 rounded mb-2" /><div className="skeleton h-6 w-20 rounded" /></div>)}</div>
    </div>
  );

  const s = data?.state;
  const ledger = data?.ledger || [];
  const latest = ledger[ledger.length - 1];
  const start = s?.startCapital ?? 30000;
  const equity = latest ? Number(latest.equity) : start;
  const retPct = latest ? Number(latest.return_pct) : 0;

  return (
    <div className="space-y-5 animate-fade-up">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-xl font-bold tracking-tight flex items-center gap-2">
            Wheel
            <span className="text-[8px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded text-blue-400/60 bg-blue-500/[0.08]">Paper · Simulated</span>
          </h1>
          <p className="text-xs text-muted-foreground/60 mt-0.5">
            Cash-secured puts → covered calls on a simulated ~${start.toLocaleString()} book. Live option data, <span className="text-foreground/70">no live orders</span> — proving the volatility-premium edge forward at $0.
          </p>
        </div>
        <div className="text-right text-[11px] text-muted-foreground/50">
          <div>{ledger.length} day{ledger.length === 1 ? "" : "s"} tracked</div>
          {data?.lastRun && <div>last run {new Date(data.lastRun).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}</div>}
        </div>
      </div>

      {!s ? (
        <div className="rounded-xl border border-white/[0.06] bg-white/[0.02] p-8 text-center text-sm text-muted-foreground/60">
          No wheel data yet. The first run is scheduled weekdays at 3:30pm ET.
        </div>
      ) : (
        <>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <Stat label="Equity" value={money(equity)} sub={`from ${money(start)}`} />
            <Stat label="Return" value={`${retPct >= 0 ? "+" : ""}${retPct.toFixed(2)}%`} color={pnlColor(retPct)} />
            <Stat label="Premium collected" value={money(s.premiumCollected)} color="text-emerald-400" sub="cumulative" />
            <Stat label="Realized P&L" value={money(s.realizedPnl)} color={pnlColor(s.realizedPnl)} />
          </div>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <Stat label="Cash" value={money(s.cash)} />
            <Stat label="Open positions" value={`${s.shortPuts.length}p · ${s.shortCalls.length}c`} sub={`${Object.keys(s.shares).length} stock lots`} />
            <Stat label="Assigned" value={String(s.assignments)} sub="puts → shares" />
            <Stat label="Called away" value={String(s.calledAway)} sub="shares → exit" />
          </div>

          <div className="rounded-xl border border-white/[0.06] bg-white/[0.02] p-4">
            <div className="text-[10px] font-semibold tracking-[0.12em] text-muted-foreground/50 uppercase mb-2">Equity Curve</div>
            <EquityCurve ledger={ledger} start={start} />
          </div>

          <div className="grid md:grid-cols-2 gap-4">
            <LegTable title="Cash-Secured Puts" legs={s.shortPuts} kind="put" />
            <LegTable title="Covered Calls" legs={s.shortCalls} kind="call" />
          </div>

          {Object.keys(s.shares).length > 0 && (
            <div className="rounded-xl border border-white/[0.06] bg-white/[0.02] p-4">
              <div className="text-[10px] font-semibold tracking-[0.12em] text-muted-foreground/50 uppercase mb-3">Assigned Shares</div>
              <table className="w-full text-[12.5px]">
                <thead><tr className="text-[10px] uppercase tracking-wider text-muted-foreground/40 text-left"><th className="pb-1.5">Symbol</th><th className="pb-1.5 text-right">Qty</th><th className="pb-1.5 text-right">Cost basis</th></tr></thead>
                <tbody>{Object.entries(s.shares).map(([u, lot]) => (
                  <tr key={u} className="border-t border-white/[0.04]"><td className="py-1.5 font-medium">{u}</td><td className="py-1.5 text-right tabular-nums">{lot.qty}</td><td className="py-1.5 text-right tabular-nums">${lot.costBasis.toFixed(2)}</td></tr>
                ))}</tbody>
              </table>
            </div>
          )}
        </>
      )}

      <p className="text-[11px] text-muted-foreground/40 leading-relaxed">
        This is a forward measurement at a realistic size where the edge can express itself — it is <span className="text-foreground/60">not</span> a path to trading options live at $1K. Runs alongside the spread book and the live $1K stocks/crypto test.
      </p>
    </div>
  );
}

function LegTable({ title, legs, kind }: { title: string; legs: ShortLeg[]; kind: "put" | "call" }) {
  return (
    <div className="rounded-xl border border-white/[0.06] bg-white/[0.02] p-4">
      <div className="text-[10px] font-semibold tracking-[0.12em] text-muted-foreground/50 uppercase mb-3">{title} <span className="text-muted-foreground/30">({legs.length})</span></div>
      {legs.length === 0 ? (
        <div className="text-xs text-muted-foreground/40 py-3">None open.</div>
      ) : (
        <table className="w-full text-[12.5px]">
          <thead><tr className="text-[10px] uppercase tracking-wider text-muted-foreground/40 text-left"><th className="pb-1.5">Symbol</th><th className="pb-1.5 text-right">Strike</th><th className="pb-1.5 text-right">DTE</th><th className="pb-1.5 text-right">Credit</th></tr></thead>
          <tbody>{legs.map((l) => (
            <tr key={l.optSymbol} className="border-t border-white/[0.04]">
              <td className="py-1.5 font-medium">{l.underlying}</td>
              <td className="py-1.5 text-right tabular-nums">${l.strike}{kind === "put" ? "P" : "C"}</td>
              <td className="py-1.5 text-right tabular-nums text-muted-foreground/70">{dte(l.expiry)}d</td>
              <td className="py-1.5 text-right tabular-nums text-emerald-400">+${(l.credit * 100 * l.contracts).toFixed(0)}</td>
            </tr>
          ))}</tbody>
        </table>
      )}
    </div>
  );
}
