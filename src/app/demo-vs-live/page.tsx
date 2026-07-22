"use client";

import useSWR from "swr";

const fetcher = (u: string) => fetch(u).then((r) => r.json()).catch(() => null);
const money = (n: number) => `${n >= 0 ? "+" : "−"}$${Math.abs(n).toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
const col = (n: number) => (n > 0 ? "text-emerald-400" : n < 0 ? "text-red-400" : "text-muted-foreground");

interface Sim {
  finalEquity: number; netPnl: number; killed: boolean; killDate: string | null;
  killTradeNum: number | null; maxDrawdownPct: number; tradesTaken: number;
  curve: { i: number; date: string; equity: number }[];
}
interface Data {
  startCapital: number;
  demo: {
    total: number; trades: number; wins: number; losses: number; winRate: number; profitFactor: number | null;
    biggestWin: { pnl: number; sym: string; qty: number; date: string } | null;
    biggestWinShare: number | null; totalWithoutTop1: number; totalWithoutTop3: number;
  };
  copyMicro: Sim;
  copyMatched: Sim;
  liveActual: { netPnl: number | null; trades: number; sinceDate: string };
  generatedAt: string;
}

// Minimal inline equity sparkline. Red once the curve breaches the kill line.
function Spark({ curve, start, killAt }: { curve: { equity: number }[]; start: number; killAt: number | null }) {
  if (curve.length < 2) return null;
  const w = 260, h = 56;
  const eqs = curve.map((c) => c.equity);
  const min = Math.min(...eqs, start * 0.7), max = Math.max(...eqs, start);
  const x = (i: number) => (i / (curve.length - 1)) * w;
  const y = (e: number) => h - ((e - min) / (max - min || 1)) * h;
  const path = curve.map((c, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(c.equity).toFixed(1)}`).join(" ");
  const killY = y(start * 0.75);
  const dead = killAt != null;
  return (
    <svg width={w} height={h} className="w-full" viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none">
      {/* start baseline */}
      <line x1={0} x2={w} y1={y(start)} y2={y(start)} stroke="currentColor" className="text-muted-foreground/20" strokeWidth={1} strokeDasharray="3 3" />
      {/* kill line */}
      <line x1={0} x2={w} y1={killY} y2={killY} stroke="currentColor" className="text-red-500/30" strokeWidth={1} strokeDasharray="2 2" />
      <path d={path} fill="none" stroke="currentColor" className={dead ? "text-red-400" : "text-emerald-400"} strokeWidth={1.5} />
      {dead && killAt != null && (
        <circle cx={x(killAt)} cy={y(curve[killAt]?.equity ?? start)} r={3} className="fill-red-500" />
      )}
    </svg>
  );
}

export default function DemoVsLivePage() {
  const { data } = useSWR<Data>("/api/futures/demo-copy-sim", fetcher, { refreshInterval: 60000 });

  if (!data?.demo) {
    return <div className="p-6 text-sm text-muted-foreground">Loading simulation…</div>;
  }
  const { demo, copyMicro, copyMatched, liveActual, startCapital } = data;

  return (
    <div className="max-w-5xl mx-auto p-4 md:p-6 space-y-5">
      <div>
        <h1 className="text-xl font-bold">Demo vs Live — can we be up like demo?</h1>
        <p className="text-xs text-muted-foreground/70 mt-1 max-w-2xl">
          This replays demo&apos;s <span className="font-semibold">actual trades</span> against your real live account
          (${startCapital.toLocaleString()}) under live&apos;s rules — micro contracts and the 25% kill switch — to show what
          copying demo would really have done. Updates as demo keeps trading.
        </p>
      </div>

      {/* 1. What demo shows */}
      <div className="rounded-xl border border-border bg-card p-4">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="text-sm font-bold">1 · What demo shows <span className="text-[10px] font-normal text-muted-foreground/50">· full-size, fake $60k</span></h2>
            <p className="text-[11px] text-muted-foreground/60 mt-0.5">The big number you watch — {demo.trades} trades, {demo.winRate}% win rate, profit factor {demo.profitFactor ?? "—"}.</p>
          </div>
          <p className={`text-2xl font-black tabular-nums ${col(demo.total)}`}>{money(demo.total)}</p>
        </div>
        {demo.biggestWin && (
          <div className="mt-3 rounded-lg border border-amber-500/20 bg-amber-500/[0.04] p-3 text-[12px] space-y-1">
            <p className="font-semibold text-amber-300/90">⚠ It&apos;s one lucky trade, not a strategy</p>
            <p className="text-muted-foreground/80">
              A single <span className="font-semibold">{demo.biggestWin.qty}-contract {demo.biggestWin.sym}</span> trade on {demo.biggestWin.date} made{" "}
              <span className="font-semibold text-emerald-400">{money(demo.biggestWin.pnl)}</span> = <span className="font-semibold">{demo.biggestWinShare}%</span> of ALL demo profit.
            </p>
            <div className="flex flex-wrap gap-x-6 gap-y-1 pt-1">
              <span className="text-muted-foreground/70">Demo without that one trade: <span className={`font-semibold ${col(demo.totalWithoutTop1)}`}>{money(demo.totalWithoutTop1)}</span></span>
              <span className="text-muted-foreground/70">Without its top 3: <span className={`font-semibold ${col(demo.totalWithoutTop3)}`}>{money(demo.totalWithoutTop3)}</span></span>
            </div>
            <p className="text-[10px] text-muted-foreground/50 pt-0.5">
              That {demo.biggestWin.qty}-contract position is ~${(demo.biggestWin.qty * 20000).toLocaleString()}+ of notional — impossible on a ${startCapital.toLocaleString()} account.
            </p>
          </div>
        )}
      </div>

      {/* 2. If live copied demo */}
      <div>
        <h2 className="text-sm font-bold mb-2">2 · If live had copied demo — on your real ${startCapital.toLocaleString()}</h2>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {/* Matched size */}
          <div className={`rounded-xl border p-4 space-y-2 ${copyMatched.killed ? "border-red-500/40 bg-red-500/[0.05]" : "border-border bg-card"}`}>
            <div className="flex items-center justify-between">
              <span className="text-xs font-bold">Copy demo&apos;s size</span>
              <span className="text-[9px] uppercase tracking-wider text-muted-foreground/50">same contracts, micros</span>
            </div>
            {copyMatched.killed ? (
              <div className="py-1">
                <p className="text-lg font-black text-red-400">💀 ACCOUNT KILLED</p>
                <p className="text-[11px] text-red-300/80 mt-0.5">
                  25% kill switch tripped on <span className="font-semibold">{copyMatched.killDate}</span> — trade #{copyMatched.killTradeNum} of {demo.trades}.
                  Every demo winner after that date <span className="font-semibold">never happens for you</span>.
                </p>
              </div>
            ) : (
              <p className={`text-xl font-black tabular-nums ${col(copyMatched.netPnl)}`}>{money(copyMatched.netPnl)}</p>
            )}
            <Spark curve={copyMatched.curve} start={startCapital} killAt={copyMatched.killed ? copyMatched.killTradeNum : null} />
            <p className="text-[10px] text-muted-foreground/50">Max drawdown {copyMatched.maxDrawdownPct}%. Even this is generous — {demo.biggestWin?.qty ?? 8} micro contracts often exceed margin on ${startCapital.toLocaleString()}.</p>
          </div>

          {/* 1 micro */}
          <div className="rounded-xl border border-border bg-card p-4 space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-xs font-bold">Copy demo at 1 micro</span>
              <span className="text-[9px] uppercase tracking-wider text-muted-foreground/50">survivable sizing</span>
            </div>
            <p className={`text-xl font-black tabular-nums ${col(copyMicro.netPnl)}`}>{money(copyMicro.netPnl)}</p>
            <Spark curve={copyMicro.curve} start={startCapital} killAt={copyMicro.killed ? copyMicro.killTradeNum : null} />
            <p className="text-[10px] text-muted-foreground/50">
              {copyMicro.killed
                ? `Killed ${copyMicro.killDate}.`
                : `Survives (max drawdown ${copyMicro.maxDrawdownPct}%). The ${money(demo.biggestWin?.pnl ?? 0)} winner shrinks to ~${money(Math.round((demo.biggestWin?.pnl ?? 0) / (demo.biggestWin?.qty ?? 1) / 10))} at 1 micro — but taken this way, demo's unfiltered signals netted ${copyMicro.netPnl >= 0 ? "positive" : "negative"} over this window. Whether that holds is the open question ↓`}
            </p>
          </div>
        </div>
      </div>

      {/* 3. Live actual */}
      <div className="rounded-xl border border-emerald-500/20 bg-emerald-500/[0.03] p-4">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="text-sm font-bold">3 · Live actual <span className="text-[10px] font-normal text-muted-foreground/50">· edge-gated, real money</span></h2>
            <p className="text-[11px] text-muted-foreground/60 mt-0.5">
              {liveActual.trades} trade{liveActual.trades === 1 ? "" : "s"} since {liveActual.sinceDate} — only the setups with a proven or forward-testing edge. Small, but real and alive.
              <span className="text-muted-foreground/40"> · broker balance delta</span>
            </p>
          </div>
          {liveActual.netPnl != null ? (
            <p className={`text-2xl font-black tabular-nums ${col(liveActual.netPnl)}`}>{money(liveActual.netPnl)}</p>
          ) : (
            <p className="text-2xl font-black tabular-nums text-muted-foreground/40">—</p>
          )}
        </div>
      </div>

      {/* Verdict */}
      <div className="rounded-xl border border-border bg-white/[0.02] p-4 text-[12px] leading-relaxed text-muted-foreground/80 space-y-2">
        <p className="font-semibold text-foreground">The verdict — the honest version</p>
        <p>
          <span className="font-semibold text-foreground">Certain:</span> copying demo&apos;s <span className="font-semibold">size</span> kills the account
          {copyMatched.killed ? ` (dead ${copyMatched.killDate})` : ""} — one 8-contract position risks more than the whole account, and the kill switch ends you before demo&apos;s big winners ever land.
        </p>
        <p>
          <span className="font-semibold text-foreground">The open question:</span> at survivable 1-micro size, copying demo&apos;s unfiltered signals came out
          <span className={`font-semibold ${col(copyMicro.netPnl)}`}> {money(copyMicro.netPnl)}</span> here. That&apos;s real — and it&apos;s the strongest case yet for loosening the gate.
          But it&apos;s <span className="font-semibold">{demo.trades} trades over ~2 months</span>, a favorable window, and it leans on a handful of big per-contract wins. The longer 2018–2026 backtests
          say these unfiltered setups don&apos;t hold up out-of-sample. So it&apos;s a <span className="font-semibold text-foreground">lead to forward-test, not a proven edge</span>.
        </p>
        <p>
          This page updates as demo keeps trading. If 1-micro-copy stays positive over more months — especially through a losing stretch — that&apos;s the evidence to widen live&apos;s gate.
          Until then, live stays disciplined, and the real lever for bigger numbers is <span className="font-semibold text-foreground">more capital</span>.
        </p>
      </div>

      <p className="text-[9px] text-muted-foreground/30">Kill switch modeled as 25% trailing drawdown from peak. Demo full-size symbols mapped to micros (ES→MES, NQ→MNQ, GC→MGC, 10× smaller). &quot;1 micro&quot; normalizes each demo trade to its per-contract move. Read-only simulation over the real trade log; a 2-month sample is not proof of a durable edge.</p>
    </div>
  );
}
