import { Card, CardContent } from "@/components/ui/card";

export const dynamic = "force-dynamic";
export const revalidate = 60;

export const metadata = {
  title: "Proof — Live engine performance",
  description: "Real-time, verifiable performance of the live futures trading engine. Every number from the actual trade ledger.",
};

interface Stats {
  windowDays: number;
  totalTrades: number;
  totalPnl?: number;
  winRate?: number;
  profitFactor?: number | null;
  avgWin?: number;
  avgLoss?: number;
  expectancy?: number;
  sharpe?: number;
  maxDrawdown?: number;
  tradesPerDay?: number;
  bySetup?: Record<string, { n: number; wins: number; pnl: number }>;
  bySymbol?: Record<string, { n: number; wins: number; pnl: number }>;
  equityCurve?: { t: string; equity: number }[];
  windowStart?: string;
  windowEnd?: string;
  empty?: boolean;
  message?: string;
  generatedAt: string;
}

async function getStats(): Promise<Stats | null> {
  // Same-origin fetch on the deployed app — relative URL works in both dev and prod.
  const baseUrl = process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : "http://localhost:3000";
  try {
    const res = await fetch(`${baseUrl}/api/fund/stats`, { cache: "no-store" });
    if (!res.ok) return null;
    return await res.json();
  } catch { return null; }
}

function fmt(n: number | undefined, d = 2): string {
  if (n === undefined || n === null || !isFinite(n)) return "—";
  return n.toFixed(d);
}
function fmtMoney(n: number | undefined): string {
  if (n === undefined || n === null || !isFinite(n)) return "—";
  const s = Math.abs(Math.round(n)).toLocaleString();
  return (n < 0 ? "−$" : "$") + s;
}
function pct(n: number | undefined): string {
  if (n === undefined || n === null || !isFinite(n)) return "—";
  return (n * 100).toFixed(0) + "%";
}

export default async function ProofPage() {
  const stats = await getStats();

  if (!stats) {
    return (
      <div className="min-h-screen bg-slate-950 text-white p-8">
        <div className="max-w-4xl mx-auto">
          <h1 className="text-3xl font-light">Proof</h1>
          <p className="text-slate-400 mt-2">Stats endpoint unreachable.</p>
        </div>
      </div>
    );
  }

  const pnlColor = (stats.totalPnl ?? 0) >= 0 ? "text-emerald-400" : "text-rose-400";
  const sharpeColor = (stats.sharpe ?? 0) >= 1 ? "text-emerald-400" : (stats.sharpe ?? 0) >= 0 ? "text-amber-400" : "text-rose-400";

  return (
    <div className="min-h-screen bg-slate-950 text-white">
      <div className="max-w-5xl mx-auto px-6 py-12">
        {/* Hero */}
        <div className="mb-10">
          <div className="text-xs uppercase tracking-widest text-emerald-400 font-mono mb-2">Live proof · verifiable</div>
          <h1 className="text-4xl font-light leading-tight mb-3">
            Engine performance — <span className="text-emerald-400">{stats.windowDays}-day rolling window</span>
          </h1>
          <p className="text-slate-400 max-w-3xl">
            Every number on this page is read live from the production trade ledger. No backtest, no
            counterfactual, no smoothing. Updated whenever this page loads. Reproducible from
            <code className="text-emerald-400 mx-1">/api/fund/stats</code>.
          </p>
        </div>

        {stats.empty ? (
          <Card className="bg-slate-900/60 border-slate-800">
            <CardContent className="p-6">
              <div className="text-slate-300">{stats.message}</div>
              <div className="text-xs text-slate-500 mt-2">Generated {stats.generatedAt}</div>
            </CardContent>
          </Card>
        ) : (
          <>
            {/* Headline metrics */}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-10">
              <Card className="bg-slate-900/60 border-slate-800">
                <CardContent className="p-5">
                  <div className="text-xs uppercase text-slate-500 mb-2 font-mono">Net P&L</div>
                  <div className={`text-3xl font-mono ${pnlColor}`}>{fmtMoney(stats.totalPnl)}</div>
                  <div className="text-xs text-slate-500 mt-1">{stats.totalTrades} trades</div>
                </CardContent>
              </Card>
              <Card className="bg-slate-900/60 border-slate-800">
                <CardContent className="p-5">
                  <div className="text-xs uppercase text-slate-500 mb-2 font-mono">Win rate</div>
                  <div className="text-3xl font-mono">{pct(stats.winRate)}</div>
                  <div className="text-xs text-slate-500 mt-1">PF {fmt(stats.profitFactor ?? undefined)}</div>
                </CardContent>
              </Card>
              <Card className="bg-slate-900/60 border-slate-800">
                <CardContent className="p-5">
                  <div className="text-xs uppercase text-slate-500 mb-2 font-mono">Sharpe (annualized)</div>
                  <div className={`text-3xl font-mono ${sharpeColor}`}>{fmt(stats.sharpe)}</div>
                  <div className="text-xs text-slate-500 mt-1">{fmt(stats.tradesPerDay)} trades/day</div>
                </CardContent>
              </Card>
              <Card className="bg-slate-900/60 border-slate-800">
                <CardContent className="p-5">
                  <div className="text-xs uppercase text-slate-500 mb-2 font-mono">Max drawdown</div>
                  <div className="text-3xl font-mono text-amber-400">{fmtMoney(stats.maxDrawdown)}</div>
                  <div className="text-xs text-slate-500 mt-1">avg W {fmtMoney(stats.avgWin)} · L {fmtMoney(stats.avgLoss)}</div>
                </CardContent>
              </Card>
            </div>

            {/* Per-symbol */}
            <Card className="bg-slate-900/60 border-slate-800 mb-6">
              <CardContent className="p-5">
                <div className="text-xs uppercase text-slate-500 mb-3 font-mono">By instrument</div>
                <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
                  {Object.entries(stats.bySymbol ?? {})
                    .sort((a, b) => b[1].pnl - a[1].pnl)
                    .map(([sym, m]) => (
                      <div key={sym} className="bg-slate-950/50 rounded p-3 border border-slate-800">
                        <div className="font-mono text-lg">{sym}</div>
                        <div className={`text-sm font-mono ${m.pnl >= 0 ? "text-emerald-400" : "text-rose-400"}`}>
                          {fmtMoney(m.pnl)}
                        </div>
                        <div className="text-xs text-slate-500 font-mono mt-1">
                          {m.n} trades · {pct(m.wins / m.n)} WR
                        </div>
                      </div>
                    ))}
                </div>
              </CardContent>
            </Card>

            {/* Per-setup-type (exit reason proxy) */}
            <Card className="bg-slate-900/60 border-slate-800 mb-10">
              <CardContent className="p-5">
                <div className="text-xs uppercase text-slate-500 mb-3 font-mono">By exit type</div>
                <div className="text-xs text-slate-600 mb-3">
                  How each trade ended. <code className="text-emerald-400">target</code> &amp;{" "}
                  <code className="text-emerald-400">trail_stop</code> are wins; the rest are managed exits or stops.
                </div>
                <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
                  {Object.entries(stats.bySetup ?? {})
                    .sort((a, b) => b[1].pnl - a[1].pnl)
                    .map(([exit, m]) => (
                      <div key={exit} className="bg-slate-950/50 rounded p-3 border border-slate-800">
                        <div className="font-mono text-sm">{exit}</div>
                        <div className={`text-sm font-mono ${m.pnl >= 0 ? "text-emerald-400" : "text-rose-400"}`}>
                          {fmtMoney(m.pnl)}
                        </div>
                        <div className="text-xs text-slate-500 font-mono mt-1">
                          {m.n} trades · {pct(m.wins / m.n)} WR
                        </div>
                      </div>
                    ))}
                </div>
              </CardContent>
            </Card>

            {/* How to interpret */}
            <Card className="bg-slate-900/40 border-slate-800 mb-10">
              <CardContent className="p-5">
                <div className="text-xs uppercase text-slate-500 mb-3 font-mono">Honest reading guide</div>
                <ul className="text-sm text-slate-300 space-y-2 leading-relaxed">
                  <li>
                    <span className="text-emerald-400 font-mono">Sharpe ≥ 1.0</span> means risk-adjusted returns
                    that beat passive equity exposure. <span className="text-amber-400">0 – 1</span> is positive
                    but not yet professional-grade. <span className="text-rose-400">&lt; 0</span> means losing money.
                  </li>
                  <li>
                    <span className="text-emerald-400 font-mono">PF ≥ 1.3</span> across 100+ trades is the threshold
                    for a tradeable edge. <span className="text-amber-400">1.0 – 1.3</span> is variance, not yet
                    statistically confirmed.
                  </li>
                  <li>
                    <span className="text-emerald-400 font-mono">Max DD relative to net P&amp;L</span> tells you risk
                    discipline. A drawdown larger than total profit means the system isn&apos;t protecting capital.
                  </li>
                  <li>
                    These numbers will <em className="text-emerald-400">improve</em> as pattern memory accumulates
                    and the auto-prune mechanism retires underperforming setupTypes. The system gets measurably
                    smarter without intervention.
                  </li>
                </ul>
              </CardContent>
            </Card>

            <div className="text-xs text-slate-600 font-mono text-center">
              Window: {stats.windowStart?.slice(0, 10)} → {stats.windowEnd?.slice(0, 10)} · Generated{" "}
              {stats.generatedAt.slice(0, 19).replace("T", " ")} UTC
            </div>
          </>
        )}
      </div>
    </div>
  );
}
