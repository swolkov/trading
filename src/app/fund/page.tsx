import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import snapshot from "@/data/fund-snapshot.json";

export const dynamic = "force-static";
export const metadata = {
  title: "Esbueno Capital — Quant Fund",
  description: "Market-neutral relative-value spread strategy on CME futures. Validated edge with forward-track verification.",
};

interface PairMetrics {
  baseline: { n: number; exp: number; sharpe: number; maxDD: number; win: number; avgWin: number; avgLoss: number; avgHold: number };
  forward: { n: number; exp: number; sharpe: number; maxDD: number; win: number; avgWin: number; avgLoss: number; avgHold: number };
  verdict: string;
  action: string;
}

interface PaperForwardReport {
  generated: string;
  lastData: string;
  forwardStart: string;
  costBps: Record<string, number>;
  overall: string;
  portfolio: { baseline: PairMetrics["baseline"]; forward: PairMetrics["baseline"] };
  pairs: Record<string, PairMetrics>;
  maxCorr: number;
  maxPair: string;
}

interface PaperAccount {
  equity: number;
  peak: number;
  positions: Record<string, { dir: number; entryRatio: number; entryDate: string; barsHeld: number }>;
}

function fmt(n: number, d = 2): string {
  return n.toFixed(d);
}
function fmtMoney(n: number): string {
  return "$" + Math.round(n).toLocaleString();
}

export default function FundPage() {
  const report = snapshot.report as PaperForwardReport;
  const account = snapshot.account as PaperAccount | null;
  const equityCurve = snapshot.equityCurve as { month: string; equity: number }[];

  if (!report) {
    return <div className="p-8 text-white">Track record not loaded.</div>;
  }

  const startCapital = 50_000;
  const currentEquity = account?.equity ?? startCapital;
  const totalReturn = (currentEquity - startCapital) / startCapital;
  const peakDD = account ? (currentEquity - account.peak) / account.peak : 0;

  const minEq = Math.min(...equityCurve.map((p) => p.equity), startCapital);
  const maxEq = Math.max(...equityCurve.map((p) => p.equity), currentEquity);
  const sparkW = 800;
  const sparkH = 180;

  const passingPairs = Object.entries(report.pairs).filter(([, m]) => m.verdict === "PASS");

  // Prominent staleness signal: this page renders a frozen JSON snapshot. Show how old the
  // underlying data is so investors are never shown stale numbers without knowing it.
  const lastDataDate = report.lastData ? new Date(report.lastData + "T00:00:00Z") : null;
  const daysStale = lastDataDate ? Math.floor((Date.now() - lastDataDate.getTime()) / 86_400_000) : null;
  const isStale = daysStale !== null && daysStale > 10;

  return (
    <div className="min-h-screen bg-slate-950 text-white">
      <div className="max-w-6xl mx-auto px-6 py-12">
        {/* Data freshness banner */}
        <div
          className={`mb-8 rounded border px-4 py-3 text-sm font-mono ${
            isStale
              ? "border-amber-900/50 bg-amber-950/20 text-amber-200"
              : "border-slate-800 bg-slate-900/40 text-slate-400"
          }`}
        >
          Forward-track data through <span className="font-semibold">{report.lastData}</span>
          {daysStale !== null && (
            <span> · {daysStale === 0 ? "today" : `${daysStale} day${daysStale === 1 ? "" : "s"} ago`}</span>
          )}
          {isStale && <span className="ml-1">— snapshot is stale; figures below may not reflect the latest sessions.</span>}
        </div>

        {/* Hero */}
        <div className="mb-12">
          <div className="text-sm uppercase tracking-widest text-emerald-400 font-mono mb-3">
            Esbueno Capital · Quant Strategy
          </div>
          <h1 className="text-5xl font-light leading-tight mb-4">
            Market-neutral relative value on{" "}
            <span className="font-semibold text-emerald-400">CME futures</span>
          </h1>
          <p className="text-lg text-slate-400 max-w-3xl">
            One validated edge: pairs of economically-linked futures revert to their statistical mean.
            We trade them dollar-neutral, sized by realized volatility, on the validated basket below.
            Same code, same parameters, runs in backtest and forward — no curve fit, no overlay.
          </p>
        </div>

        {/* Headline metrics */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-12">
          <Card className="bg-slate-900/60 border-slate-800">
            <CardContent className="p-5">
              <div className="text-xs uppercase text-slate-500 mb-2 font-mono">Forward return</div>
              <div className="text-3xl font-mono text-emerald-400">+{fmt(totalReturn * 100, 1)}%</div>
              <div className="text-xs text-slate-500 mt-1">since {report.forwardStart}</div>
            </CardContent>
          </Card>
          <Card className="bg-slate-900/60 border-slate-800">
            <CardContent className="p-5">
              <div className="text-xs uppercase text-slate-500 mb-2 font-mono">Forward Sharpe</div>
              <div className="text-3xl font-mono text-white">{fmt(report.portfolio.forward.sharpe, 2)}</div>
              <div className="text-xs text-slate-500 mt-1">baseline: {fmt(report.portfolio.baseline.sharpe, 2)}</div>
            </CardContent>
          </Card>
          <Card className="bg-slate-900/60 border-slate-800">
            <CardContent className="p-5">
              <div className="text-xs uppercase text-slate-500 mb-2 font-mono">Max drawdown</div>
              <div className="text-3xl font-mono text-white">{fmt(report.portfolio.forward.maxDD, 1)}R</div>
              <div className="text-xs text-slate-500 mt-1">across {report.portfolio.forward.n} trades</div>
            </CardContent>
          </Card>
          <Card className="bg-slate-900/60 border-slate-800">
            <CardContent className="p-5">
              <div className="text-xs uppercase text-slate-500 mb-2 font-mono">Win rate</div>
              <div className="text-3xl font-mono text-white">{fmt(report.portfolio.forward.win * 100, 0)}%</div>
              <div className="text-xs text-slate-500 mt-1">expectancy {fmt(report.portfolio.forward.exp, 2)}R</div>
            </CardContent>
          </Card>
        </div>

        {/* Equity curve */}
        {equityCurve.length > 1 && (
          <Card className="bg-slate-900/60 border-slate-800 mb-12">
            <CardContent className="p-6">
              <div className="flex items-baseline justify-between mb-4">
                <div>
                  <div className="text-xs uppercase text-slate-500 font-mono">$50K paper account · monthly equity</div>
                  <div className="text-2xl font-mono mt-1">{fmtMoney(currentEquity)}</div>
                </div>
                <div className="text-right">
                  <div className="text-xs text-slate-500">peak {fmtMoney(account?.peak ?? currentEquity)}</div>
                  <div className="text-xs text-slate-500">DD {fmt(peakDD * 100, 1)}%</div>
                </div>
              </div>
              <svg viewBox={`0 0 ${sparkW} ${sparkH}`} className="w-full h-44">
                <defs>
                  <linearGradient id="g" x1="0" x2="0" y1="0" y2="1">
                    <stop offset="0%" stopColor="rgb(52,211,153)" stopOpacity="0.4" />
                    <stop offset="100%" stopColor="rgb(52,211,153)" stopOpacity="0" />
                  </linearGradient>
                </defs>
                {(() => {
                  const points = equityCurve.map((p, i) => {
                    const x = (i / (equityCurve.length - 1)) * sparkW;
                    const y = sparkH - ((p.equity - minEq) / (maxEq - minEq)) * (sparkH - 20) - 10;
                    return { x, y };
                  });
                  const pathD = points.map((p, i) => (i === 0 ? `M ${p.x} ${p.y}` : `L ${p.x} ${p.y}`)).join(" ");
                  const fillD = `${pathD} L ${sparkW} ${sparkH} L 0 ${sparkH} Z`;
                  // baseline (start capital)
                  const baselineY = sparkH - ((startCapital - minEq) / (maxEq - minEq)) * (sparkH - 20) - 10;
                  return (
                    <>
                      <line x1="0" y1={baselineY} x2={sparkW} y2={baselineY} stroke="rgb(71,85,105)" strokeDasharray="3 4" />
                      <path d={fillD} fill="url(#g)" />
                      <path d={pathD} fill="none" stroke="rgb(52,211,153)" strokeWidth="2" />
                    </>
                  );
                })()}
              </svg>
              <div className="flex justify-between text-xs text-slate-500 font-mono mt-2">
                <span>{equityCurve[0]?.month}</span>
                <span>{equityCurve[equityCurve.length - 1]?.month}</span>
              </div>
            </CardContent>
          </Card>
        )}

        {/* Pair-by-pair track record */}
        <div className="mb-12">
          <div className="text-xs uppercase tracking-widest text-slate-500 font-mono mb-4">
            Per-pair forward verification · {passingPairs.length}/{Object.keys(report.pairs).length} active
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {Object.entries(report.pairs).map(([pair, m]) => {
              const isActive = m.verdict === "PASS";
              return (
                <Card key={pair} className={`border ${isActive ? "border-emerald-900/50 bg-emerald-950/10" : "border-slate-800 bg-slate-900/40 opacity-60"}`}>
                  <CardContent className="p-4">
                    <div className="flex items-start justify-between mb-3">
                      <div className="font-mono text-lg">{pair}</div>
                      <Badge variant={isActive ? "default" : "secondary"} className={isActive ? "bg-emerald-900/40 text-emerald-300 border-emerald-800" : ""}>
                        {m.verdict}
                      </Badge>
                    </div>
                    <div className="grid grid-cols-3 gap-2 text-xs font-mono">
                      <div>
                        <div className="text-slate-500 mb-0.5">Trades</div>
                        <div className="text-white">{m.forward.n} / {m.baseline.n}</div>
                      </div>
                      <div>
                        <div className="text-slate-500 mb-0.5">Sharpe</div>
                        <div className="text-white">{fmt(m.forward.sharpe, 2)} / {fmt(m.baseline.sharpe, 2)}</div>
                      </div>
                      <div>
                        <div className="text-slate-500 mb-0.5">Win</div>
                        <div className="text-white">{fmt(m.forward.win * 100, 0)}% / {fmt(m.baseline.win * 100, 0)}%</div>
                      </div>
                    </div>
                    <div className="text-[10px] text-slate-600 mt-2 font-mono">
                      forward / baseline · cost {fmt(report.costBps[pair] ?? 0, 2)}bps measured
                    </div>
                  </CardContent>
                </Card>
              );
            })}
          </div>
        </div>

        {/* Strategy */}
        <Card className="bg-slate-900/60 border-slate-800 mb-12">
          <CardContent className="p-6">
            <div className="text-xs uppercase tracking-widest text-slate-500 font-mono mb-4">Strategy</div>
            <div className="space-y-4 text-slate-300 leading-relaxed">
              <p>
                Eight pairs of economically-linked CME futures — energy refining margins, grain crush
                spreads, FX cross-rates, metal ratios. When the price ratio between paired contracts
                strays statistically far from its 60-bar mean, we enter against the dislocation and
                wait for mean reversion.
              </p>
              <p>
                Dollar-neutral by construction: long one leg, short the other, sized so a 1.5σ adverse
                ratio move equals 1% of capital. Market direction doesn't matter — only the relative
                pricing matters. The strategy was beta-tested across 15 years of Databento bars, then
                run forward on the same code for {report.portfolio.forward.n} live-equivalent trades.
                Forward expectancy matches baseline within 40%.
              </p>
              <p className="text-sm text-slate-500">
                All forward-track data including this page is reproducible from{" "}
                <code className="text-emerald-400">scripts/spread-paper-trade.ts</code> and{" "}
                <code className="text-emerald-400">reports/spread-paper-account.json</code>.
              </p>
            </div>
          </CardContent>
        </Card>

        {/* Fund structure */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-12">
          <Card className="bg-slate-900/60 border-slate-800">
            <CardContent className="p-5">
              <div className="text-xs uppercase text-slate-500 mb-2 font-mono">Structure</div>
              <div className="text-base text-white">Delaware LP</div>
              <div className="text-xs text-slate-500 mt-1">accredited investors only</div>
            </CardContent>
          </Card>
          <Card className="bg-slate-900/60 border-slate-800">
            <CardContent className="p-5">
              <div className="text-xs uppercase text-slate-500 mb-2 font-mono">Fee model</div>
              <div className="text-base text-white">2% / 20%</div>
              <div className="text-xs text-slate-500 mt-1">high-water mark perf fees</div>
            </CardContent>
          </Card>
          <Card className="bg-slate-900/60 border-slate-800">
            <CardContent className="p-5">
              <div className="text-xs uppercase text-slate-500 mb-2 font-mono">Capacity</div>
              <div className="text-base text-white">~$50M</div>
              <div className="text-xs text-slate-500 mt-1">CME futures liquidity bound</div>
            </CardContent>
          </Card>
        </div>

        {/* Contact */}
        <Card className="bg-emerald-950/10 border-emerald-900/40">
          <CardContent className="p-6">
            <div className="text-xs uppercase tracking-widest text-emerald-400 font-mono mb-3">
              Investor inquiries
            </div>
            <div className="text-xl font-light text-white mb-4">
              Looking for accredited and institutional allocators for a $1M – $10M anchor round.
            </div>
            <a
              href="mailto:swolkov@medasynq.com?subject=Esbueno Capital — Investor Inquiry"
              className="inline-block px-6 py-3 bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-mono text-sm font-semibold rounded transition"
            >
              swolkov@medasynq.com →
            </a>
          </CardContent>
        </Card>

        <div className="text-xs text-slate-600 font-mono mt-12 text-center">
          Forward-track data through {report.lastData} · Generated {report.generated.slice(0, 10)} · Past performance does not guarantee future results.
        </div>
      </div>
    </div>
  );
}
