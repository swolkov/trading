import { STRATEGIES, STRATEGY_REGISTRY_ONLY_SYMBOLS } from "@/lib/strategies/registry";
import { ASSET_CLASSES, assetClassFor } from "@/lib/asset-classes";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import Link from "next/link";
import { FileText, Code2, Brain, ArrowRight } from "lucide-react";
import { StrategyAssignmentControls } from "./strategy-row";

export const dynamic = "force-dynamic";

function tierBadge(tier: 1 | 2 | 3 | "rejected") {
  if (tier === 1) return <Badge className="bg-emerald-500/15 text-emerald-300 border-emerald-500/30">Tier 1 — Validated</Badge>;
  if (tier === 2) return <Badge className="bg-amber-500/15 text-amber-300 border-amber-500/30">Tier 2 — Plausible</Badge>;
  if (tier === 3) return <Badge className="bg-blue-500/15 text-blue-300 border-blue-500/30">Tier 3 — Speculative</Badge>;
  return <Badge className="bg-red-500/15 text-red-300 border-red-500/30">Rejected</Badge>;
}

const money = (n: number) => `${n < 0 ? "-" : "+"}$${Math.abs(n).toLocaleString()}`;

export default function StrategiesAdminPage() {
  // Group observation-only symbols by asset class
  const observationByClass = new Map<string, string[]>();
  for (const sym of STRATEGY_REGISTRY_ONLY_SYMBOLS) {
    const hasStrategy = STRATEGIES.some((s) => s.applicableSymbols.includes(sym));
    if (hasStrategy) continue;
    const ac = assetClassFor(sym);
    const key = ac ?? "other";
    if (!observationByClass.has(key)) observationByClass.set(key, []);
    observationByClass.get(key)!.push(sym);
  }

  // Group strategies by asset class
  const strategiesByClass = new Map<string, typeof STRATEGIES>();
  for (const strat of STRATEGIES) {
    const acs = new Set<string>();
    for (const sym of strat.applicableSymbols) {
      const ac = assetClassFor(sym);
      if (ac) acs.add(ac);
    }
    for (const ac of acs) {
      if (!strategiesByClass.has(ac)) strategiesByClass.set(ac, []);
      strategiesByClass.get(ac)!.push(strat);
    }
  }

  // Summary stats
  const totalStrategies = STRATEGIES.length;
  const totalObservation = [...observationByClass.values()].reduce((s, arr) => s + arr.length, 0);
  const totalAssetClasses = ASSET_CLASSES.filter(
    (ac) => (strategiesByClass.get(ac.id)?.length ?? 0) + (observationByClass.get(ac.id)?.length ?? 0) > 0,
  ).length;

  return (
    <div className="max-w-6xl mx-auto space-y-5">
      {/* Header */}
      <div>
        <div className="flex items-center justify-between gap-4 flex-wrap">
          <div>
            <h1 className="text-2xl font-bold tracking-tight">Strategies</h1>
            <p className="text-sm text-muted-foreground mt-1">
              Every registered signal-generator, scoped by asset class × timeframe × signal family.
            </p>
          </div>
          <Link
            href="/edges"
            className="inline-flex items-center gap-1.5 text-xs px-2.5 py-1.5 rounded-md border border-border bg-muted/30 hover:bg-muted/60 transition-colors"
          >
            <Brain className="w-3.5 h-3.5" />
            Edge Hierarchy
            <ArrowRight className="w-3 h-3" />
          </Link>
        </div>

        {/* Summary stats row */}
        <div className="grid grid-cols-3 gap-2 mt-3">
          <div className="border border-border rounded-md p-2.5 bg-muted/20">
            <div className="text-[10px] uppercase tracking-wider text-muted-foreground">Registered Strategies</div>
            <div className="text-xl font-semibold tabular-nums">{totalStrategies}</div>
          </div>
          <div className="border border-border rounded-md p-2.5 bg-muted/20">
            <div className="text-[10px] uppercase tracking-wider text-muted-foreground">Observation Symbols</div>
            <div className="text-xl font-semibold tabular-nums">{totalObservation}</div>
          </div>
          <div className="border border-border rounded-md p-2.5 bg-muted/20">
            <div className="text-[10px] uppercase tracking-wider text-muted-foreground">Asset Classes Live</div>
            <div className="text-xl font-semibold tabular-nums">{totalAssetClasses}</div>
          </div>
        </div>
      </div>

      {/* Per asset-class sections */}
      {ASSET_CLASSES.map((ac) => {
        const strats = strategiesByClass.get(ac.id) ?? [];
        const observed = observationByClass.get(ac.id) ?? [];
        if (strats.length === 0 && observed.length === 0) return null;
        return (
          <section key={ac.id} className="space-y-3">
            <div className="flex items-center justify-between gap-3 border-b border-border pb-1.5">
              <div>
                <h2 className="text-base font-semibold">{ac.label}</h2>
                <p className="text-[11px] text-muted-foreground mt-0.5">{ac.description}</p>
              </div>
              <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground/70 shrink-0">
                <span className="px-1.5 py-0.5 rounded bg-emerald-500/[0.06] text-emerald-300 border border-emerald-500/20">
                  {strats.length} {strats.length === 1 ? "strategy" : "strategies"}
                </span>
                {observed.length > 0 && (
                  <span className="px-1.5 py-0.5 rounded bg-muted/40 border border-border">
                    {observed.length} observation
                  </span>
                )}
              </div>
            </div>

            {/* Strategy cards */}
            {strats.map((s) => (
              <Card key={s.id} className="overflow-hidden">
                <CardHeader className="pb-2">
                  <div className="flex items-start justify-between gap-3 flex-wrap">
                    <div className="min-w-0">
                      <CardTitle className="text-base">{s.name}</CardTitle>
                      <div className="flex items-center gap-2 mt-1">
                        <Badge variant="outline" className="text-[10px]">{s.timeframe}</Badge>
                        {s.applicableSymbols.map((sym) => (
                          <Badge key={sym} variant="outline" className="text-[10px] font-mono">{sym}</Badge>
                        ))}
                        {tierBadge(s.tier)}
                      </div>
                    </div>
                    <div className="flex items-center gap-1.5 shrink-0">
                      {s.vaultDoc && (
                        <Link
                          href={`/edges`}
                          className="inline-flex items-center gap-1 text-[10px] text-muted-foreground hover:text-foreground border border-border rounded px-1.5 py-1"
                          title={s.vaultDoc}
                        >
                          <FileText className="w-3 h-3" />
                          Vault doc
                        </Link>
                      )}
                      <span
                        className="inline-flex items-center gap-1 text-[10px] text-muted-foreground/70 border border-border rounded px-1.5 py-1 font-mono"
                        title={s.codePath}
                      >
                        <Code2 className="w-3 h-3" />
                        {s.codePath.split("/").pop()}
                      </span>
                    </div>
                  </div>
                </CardHeader>
                <CardContent className="space-y-3">
                  <p className="text-xs text-muted-foreground">{s.description}</p>

                  {/* Backtest evidence */}
                  {s.backtest && (
                    <div className="border border-border rounded-md bg-muted/20 p-2.5">
                      <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1.5">Backtest evidence</div>
                      <div className="grid grid-cols-2 sm:grid-cols-5 gap-3 text-[11px]">
                        <div>
                          <div className="text-muted-foreground/70">Profit Factor</div>
                          <div className={`font-semibold tabular-nums text-sm ${s.backtest.pf >= 1.5 ? "text-emerald-400" : s.backtest.pf >= 1.0 ? "text-amber-400" : "text-red-400"}`}>
                            {s.backtest.pf.toFixed(2)}
                          </div>
                        </div>
                        <div>
                          <div className="text-muted-foreground/70">Trades</div>
                          <div className="font-semibold tabular-nums text-sm">{s.backtest.trades}</div>
                        </div>
                        <div>
                          <div className="text-muted-foreground/70">Net/contract</div>
                          <div className={`font-semibold tabular-nums text-sm ${s.backtest.netPerContract >= 0 ? "text-emerald-400" : "text-red-400"}`}>
                            {money(s.backtest.netPerContract)}
                          </div>
                        </div>
                        <div>
                          <div className="text-muted-foreground/70">Win rate</div>
                          <div className="font-semibold tabular-nums text-sm">{(s.backtest.winRate * 100).toFixed(0)}%</div>
                        </div>
                        <div>
                          <div className="text-muted-foreground/70">Years positive</div>
                          <div className="font-semibold tabular-nums text-sm">{s.backtest.yearsPositive}</div>
                        </div>
                      </div>
                      <div className="text-[10px] text-muted-foreground/60 mt-1.5">Period: {s.backtest.period}</div>
                    </div>
                  )}

                  {/* Per-account assignment controls */}
                  <StrategyAssignmentControls strategy={{ id: s.id, name: s.name }} />
                </CardContent>
              </Card>
            ))}

            {/* Observation-only symbols (no strategy registered) */}
            {observed.length > 0 && (
              <Card className="border-dashed">
                <CardContent className="py-3">
                  <div className="text-[10px] uppercase tracking-wider text-muted-foreground/70 mb-2">
                    Observation-only — sidecar streams prices, no strategy fires
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {observed.map((sym) => (
                      <div key={sym} className="flex items-center gap-1.5 px-2 py-1 rounded bg-muted/40 border border-border">
                        <span className="font-mono text-[11px] font-semibold">{sym}</span>
                        <span className="text-[10px] text-muted-foreground/70">streaming</span>
                      </div>
                    ))}
                  </div>
                </CardContent>
              </Card>
            )}
          </section>
        );
      })}

      {/* Legacy library */}
      <section className="space-y-3">
        <div className="border-b border-border pb-1.5">
          <h2 className="text-base font-semibold">Legacy intraday library</h2>
          <p className="text-[11px] text-muted-foreground mt-0.5">Combined-setup detector not yet migrated into the registry.</p>
        </div>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">5m equity intraday (combined setups)</CardTitle>
            <div className="flex items-center gap-2 mt-1">
              <Badge variant="outline" className="text-[10px]">5m</Badge>
              {["ES", "NQ", "GC", "MES", "MNQ", "MGC"].map((sym) => (
                <Badge key={sym} variant="outline" className="text-[10px] font-mono">{sym}</Badge>
              ))}
              {tierBadge(2)}
            </div>
          </CardHeader>
          <CardContent>
            <p className="text-xs text-muted-foreground">
              The original <code className="text-[11px] bg-muted px-1 py-0.5 rounded font-mono">detectSetup()</code> in
              {" "}<code className="text-[11px] bg-muted px-1 py-0.5 rounded font-mono">futures-agent.ts</code> tries multiple
              setup types per cycle (OR breakout, IB extension, gap fill, RSI extreme, trend continuation). Backtest:
              PF ~0.98 on equity indexes (break-even), PF 1.23 on gold (GC RSI bounce — Tier 2 edge). Will be split into
              per-symbol strategies (e.g. <code className="text-[11px] bg-muted px-1 py-0.5 rounded font-mono">gc-rsi-bounce</code>)
              in a future migration.
            </p>
          </CardContent>
        </Card>
      </section>
    </div>
  );
}
