import { Card, CardContent } from "@/components/ui/card";

export const dynamic = "force-dynamic";
export const revalidate = 60;

export const metadata = {
  title: "Proof — Live engine performance",
  description: "Real-time, verifiable performance of the $1K live futures engine, measured by actual broker account balance.",
};

interface Stats {
  account?: string;
  startCapital?: number;
  pnlSource?: string;
  netPnl?: number;
  returnPct?: number;
  latestBalance?: number;
  firstBalance?: number;
  maxDrawdown?: number;
  totalTrades?: number;
  winCount?: number;
  lossCount?: number;
  winRate?: number | null;
  activeDays?: number;
  daysUp?: number;
  daysDown?: number;
  bySymbol?: Record<string, { trades: number; wins: number }>;
  equityCurve?: { date: string; equity: number }[];
  windowStart?: string;
  windowEnd?: string;
  sampleNote?: string;
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

function fmtMoney(n: number | undefined): string {
  if (n === undefined || n === null || !isFinite(n)) return "—";
  const s = Math.abs(Math.round(n)).toLocaleString();
  return (n < 0 ? "−$" : "$") + s;
}
function pct(n: number | undefined | null): string {
  if (n === undefined || n === null || !isFinite(n)) return "—";
  return (n * 100).toFixed(1) + "%";
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

  const pnlColor = (stats.netPnl ?? 0) >= 0 ? "text-emerald-400" : "text-rose-400";
  const curve = stats.equityCurve ?? [];
  const minEq = curve.length ? Math.min(...curve.map((p) => p.equity)) : 0;
  const maxEq = curve.length ? Math.max(...curve.map((p) => p.equity)) : 0;
  const sparkW = 800;
  const sparkH = 160;

  return (
    <div className="min-h-screen bg-slate-950 text-white">
      <div className="max-w-5xl mx-auto px-6 py-12">
        {/* Hero */}
        <div className="mb-10">
          <div className="text-xs uppercase tracking-widest text-emerald-400 font-mono mb-2">Live proof · $1K real money</div>
          <h1 className="text-4xl font-light leading-tight mb-3">
            Live futures engine — <span className="text-emerald-400">$1,000 real account</span>
          </h1>
          <p className="text-slate-400 max-w-3xl">
            Net P&amp;L on this page is measured the only honest way: the change in the engine&apos;s actual
            broker account balance (end-of-day equity straight from Tradovate). No trade-log sums, no
            backtest, no demo account mixed in — this is the live $1K account only. Reproducible from
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
            {/* Honesty banner */}
            {stats.sampleNote && (
              <Card className="bg-amber-950/20 border-amber-900/40 mb-8">
                <CardContent className="p-4">
                  <div className="text-xs uppercase text-amber-400 mb-1 font-mono">Read this first · sample size</div>
                  <div className="text-sm text-amber-100/90 leading-relaxed">{stats.sampleNote}</div>
                </CardContent>
              </Card>
            )}

            {/* Headline metrics */}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-10">
              <Card className="bg-slate-900/60 border-slate-800">
                <CardContent className="p-5">
                  <div className="text-xs uppercase text-slate-500 mb-2 font-mono">Net P&L (balance Δ)</div>
                  <div className={`text-3xl font-mono ${pnlColor}`}>{fmtMoney(stats.netPnl)}</div>
                  <div className="text-xs text-slate-500 mt-1">{pct(stats.returnPct)} on ${stats.startCapital?.toLocaleString()}</div>
                </CardContent>
              </Card>
              <Card className="bg-slate-900/60 border-slate-800">
                <CardContent className="p-5">
                  <div className="text-xs uppercase text-slate-500 mb-2 font-mono">Account balance</div>
                  <div className="text-3xl font-mono">{fmtMoney(stats.latestBalance)}</div>
                  <div className="text-xs text-slate-500 mt-1">started {fmtMoney(stats.startCapital)}</div>
                </CardContent>
              </Card>
              <Card className="bg-slate-900/60 border-slate-800">
                <CardContent className="p-5">
                  <div className="text-xs uppercase text-slate-500 mb-2 font-mono">Win rate (count)</div>
                  <div className="text-3xl font-mono">{pct(stats.winRate)}</div>
                  <div className="text-xs text-slate-500 mt-1">{stats.winCount}W / {stats.lossCount}L · {stats.totalTrades} trades</div>
                </CardContent>
              </Card>
              <Card className="bg-slate-900/60 border-slate-800">
                <CardContent className="p-5">
                  <div className="text-xs uppercase text-slate-500 mb-2 font-mono">Max drawdown</div>
                  <div className="text-3xl font-mono text-amber-400">{fmtMoney(stats.maxDrawdown)}</div>
                  <div className="text-xs text-slate-500 mt-1">{stats.activeDays} active days</div>
                </CardContent>
              </Card>
            </div>

            {/* Equity curve (clean, balance-based) */}
            {curve.length > 1 && maxEq > minEq && (
              <Card className="bg-slate-900/60 border-slate-800 mb-10">
                <CardContent className="p-6">
                  <div className="text-xs uppercase text-slate-500 mb-3 font-mono">Account equity · broker end-of-day balance</div>
                  <svg viewBox={`0 0 ${sparkW} ${sparkH}`} className="w-full h-40">
                    {(() => {
                      const points = curve.map((p, i) => {
                        const x = (i / (curve.length - 1)) * sparkW;
                        const y = sparkH - ((p.equity - minEq) / (maxEq - minEq)) * (sparkH - 20) - 10;
                        return { x, y };
                      });
                      const pathD = points.map((p, i) => (i === 0 ? `M ${p.x} ${p.y}` : `L ${p.x} ${p.y}`)).join(" ");
                      const startY = sparkH - (((stats.startCapital ?? minEq) - minEq) / (maxEq - minEq)) * (sparkH - 20) - 10;
                      return (
                        <>
                          <line x1="0" y1={startY} x2={sparkW} y2={startY} stroke="rgb(71,85,105)" strokeDasharray="3 4" />
                          <path d={pathD} fill="none" stroke="rgb(52,211,153)" strokeWidth="2" />
                        </>
                      );
                    })()}
                  </svg>
                  <div className="flex justify-between text-xs text-slate-500 font-mono mt-2">
                    <span>{stats.windowStart}</span>
                    <span>{stats.windowEnd}</span>
                  </div>
                </CardContent>
              </Card>
            )}

            {/* Per-symbol counts */}
            {stats.bySymbol && Object.keys(stats.bySymbol).length > 0 && (
              <Card className="bg-slate-900/60 border-slate-800 mb-6">
                <CardContent className="p-5">
                  <div className="text-xs uppercase text-slate-500 mb-3 font-mono">By instrument · trade counts</div>
                  <div className="text-xs text-slate-600 mb-3">
                    Counts and win rate only. Per-instrument dollar P&amp;L is intentionally not shown here —
                    the trade log double-counts fills, so only the account-balance total above is trustworthy.
                  </div>
                  <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
                    {Object.entries(stats.bySymbol)
                      .sort((a, b) => b[1].trades - a[1].trades)
                      .map(([sym, m]) => (
                        <div key={sym} className="bg-slate-950/50 rounded p-3 border border-slate-800">
                          <div className="font-mono text-lg">{sym}</div>
                          <div className="text-xs text-slate-500 font-mono mt-1">
                            {m.trades} trades · {pct(m.trades ? m.wins / m.trades : 0)} WR
                          </div>
                        </div>
                      ))}
                  </div>
                </CardContent>
              </Card>
            )}

            {/* How to interpret */}
            <Card className="bg-slate-900/40 border-slate-800 mb-10">
              <CardContent className="p-5">
                <div className="text-xs uppercase text-slate-500 mb-3 font-mono">Honest reading guide</div>
                <ul className="text-sm text-slate-300 space-y-2 leading-relaxed">
                  <li>
                    <span className="text-emerald-400 font-mono">Net P&amp;L</span> is the change in the real
                    broker balance — money actually in or out of the account. It is not derived from the
                    trade log, which over-counts.
                  </li>
                  <li>
                    <span className="text-emerald-400 font-mono">Win rate</span> is a simple count of winning
                    vs losing closes on the live engine (MGC gold). It says nothing about edge on its own.
                  </li>
                  <li>
                    <span className="text-amber-400 font-mono">Sample size</span> is tiny (~1 month). A handful
                    of trades cannot distinguish skill from luck. Do not read this as a validated edge.
                  </li>
                  <li>
                    The demo / $50K paper account is deliberately excluded. This page is the $1K live account
                    and nothing else.
                  </li>
                </ul>
              </CardContent>
            </Card>

            <div className="text-xs text-slate-600 font-mono text-center">
              Live $1K account · {stats.windowStart} → {stats.windowEnd} · P&amp;L = broker balance delta ·
              Generated {stats.generatedAt.slice(0, 19).replace("T", " ")} UTC
            </div>
          </>
        )}
      </div>
    </div>
  );
}
