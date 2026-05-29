import { STRATEGIES, STRATEGY_REGISTRY_ONLY_SYMBOLS } from "@/lib/strategies/registry";
import { ASSET_CLASSES, assetClassFor, type AssetClass } from "@/lib/asset-classes";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import Link from "next/link";
import { FileText, Code2, Brain, ArrowRight, AlertCircle } from "lucide-react";
import { StrategyAssignmentControls } from "./strategy-row";

// Legacy 5m intraday library — not yet in registry but trades these symbols on Railway realtime engines.
// Shown so the admin page reflects what's actually trading, not just what's in the registry.
interface LegacyStrategy {
  name: string;
  setupTypes: string[];
  symbols: string[];
  assetClass: AssetClass;
  tier: 1 | 2 | 3;
  description: string;
  backtest?: { pf: number; trades: number; period: string };
}

type StatusTag = "active" | "research" | "disabled" | "untested";

interface LegacyStrategyExtra {
  status: StatusTag;
  codeFile?: string;
  capitalRequirement?: string;
}

const LEGACY_STRATEGIES: (LegacyStrategy & LegacyStrategyExtra)[] = [
  {
    name: "Equity index 5m intraday (combined setups)",
    setupTypes: ["RSI bounce", "OR breakout", "IB extension", "Gap fill", "Trend continuation", "VWAP mean-reversion"],
    symbols: ["ES", "NQ", "MES", "MNQ"],
    assetClass: "equity_index_futures",
    tier: 2,
    status: "active",
    description: "The original detectSetup() in futures-agent.ts + futures-realtime.ts tries multiple setup types per 5m bar close. Runs on the Railway realtime engines. PF ~0.98 (break-even) on equity indexes — Tier 2 marginal.",
    backtest: { pf: 0.98, trades: 4400, period: "1yr (2025-05 → 2026-05)" },
    codeFile: "futures-realtime.ts",
  },
  {
    name: "Gold RSI extreme bounce (5m)",
    setupTypes: ["RSI extreme bounce"],
    symbols: ["GC", "MGC"],
    assetClass: "metals_futures",
    tier: 2,
    status: "active",
    description: "Same 5m intraday library, but gold-specific RSI<25/>75 bounce is the only setup type that consistently profits on GC. Verified Tier 2 edge — needs $10K+ to deploy 1 full-size contract.",
    backtest: { pf: 1.23, trades: 720, period: "1yr (2025-05 → 2026-05)" },
    codeFile: "futures-realtime.ts",
  },
  {
    name: "Spread book (relative-value z-score mean reversion)",
    setupTypes: ["Z-score entry", "Mean reversion target", "Per-pair structural break stop"],
    symbols: ["CL-RB (crack)", "ZC-ZS (grain)", "6E-6B (FX)", "GC-SI (metals)"],
    assetClass: "relative_value_spreads",
    tier: 2,
    status: "research",
    description: "The ONLY Tier-1 validated edge in the system. 14/14 rolling 3yr windows positive (2011-2026), Sharpe 1.59 gross. Per-pair multi-leg spreads with z-score entry signals. Forward-tracking via scripts/spread-track.ts. NOT YET deployed — needs $100k+ real capital. Path: forward track record → raise investor capital → deploy.",
    backtest: { pf: 1.59, trades: 280, period: "15yr (2011-2026)" },
    codeFile: "scripts/spread-track.ts",
    capitalRequirement: "$100K+",
  },
  {
    name: "Stocks swing (Alpaca daily)",
    setupTypes: ["AI grader signal", "Watchlist screen", "Earnings/catalyst plays"],
    symbols: ["watchlist-driven"],
    assetClass: "stocks",
    tier: 3,
    status: "untested",
    description: "Daily swing trades on US equities via Alpaca. Symbol universe comes from /watchlist + /research watchlist scoring. Currently in 30-day paper test mode at $1K. No validated edge yet — sample size too small.",
    codeFile: "auto-trader.ts",
  },
  {
    name: "Crypto spot 24/7 (Alpaca)",
    setupTypes: ["Long-only mean reversion", "Watchlist signals"],
    symbols: ["BTCUSD", "ETHUSD"],
    assetClass: "crypto_spot",
    tier: 3,
    status: "untested",
    description: "24/7 spot crypto via Alpaca. No margin, no expiry — simpler than CME crypto futures. Fractional sizing supported. Currently observation-only; no validated strategy.",
    codeFile: "auto-trader.ts",
  },
  {
    name: "Wheel (covered calls + cash-secured puts)",
    setupTypes: ["CSP entry", "Assignment → CC roll", "Bearish put hedge"],
    symbols: ["disabled"],
    assetClass: "options",
    tier: 3,
    status: "disabled",
    description: "Options wheel strategy. DISABLED per project memory (Options Disabled, 2026-05-23). Bearish-put bypass leak fixed. Wheel reserved for isolated paper forward-test, NOT live at $1K. Re-enable only after account grows.",
    codeFile: "wheel/page.tsx",
  },
];

function statusBadge(s: StatusTag) {
  if (s === "active") return <span className="text-[10px] px-1.5 py-0.5 rounded bg-emerald-500/15 text-emerald-300 border border-emerald-500/30">● Live</span>;
  if (s === "research") return <span className="text-[10px] px-1.5 py-0.5 rounded bg-blue-500/15 text-blue-300 border border-blue-500/30">● Research</span>;
  if (s === "disabled") return <span className="text-[10px] px-1.5 py-0.5 rounded bg-red-500/15 text-red-300 border border-red-500/30">● Disabled</span>;
  return <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-500/15 text-amber-300 border border-amber-500/30">● Untested</span>;
}

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

      {/* Per asset-class sections — show all, even if no registered strategies */}
      {ASSET_CLASSES.map((ac) => {
        const strats = strategiesByClass.get(ac.id) ?? [];
        const observed = observationByClass.get(ac.id) ?? [];
        const legacy = LEGACY_STRATEGIES.filter((l) => l.assetClass === ac.id);
        const totalStrategiesInClass = strats.length + legacy.length;
        return (
          <section key={ac.id} className="space-y-3">
            <div className="flex items-center justify-between gap-3 border-b border-border pb-1.5">
              <div>
                <h2 className="text-base font-semibold">{ac.label}</h2>
                <p className="text-[11px] text-muted-foreground mt-0.5">{ac.description}</p>
              </div>
              <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground/70 shrink-0">
                <span className="px-1.5 py-0.5 rounded bg-emerald-500/[0.06] text-emerald-300 border border-emerald-500/20">
                  {totalStrategiesInClass} {totalStrategiesInClass === 1 ? "strategy" : "strategies"}
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

            {/* Legacy strategies — runs outside the registry (realtime engine / scripts / Alpaca) */}
            {legacy.map((l) => (
              <Card key={l.name} className="border-amber-500/20">
                <CardHeader className="pb-2">
                  <div className="flex items-start justify-between gap-3 flex-wrap">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <CardTitle className="text-base">{l.name}</CardTitle>
                        {statusBadge(l.status)}
                        <span className="inline-flex items-center gap-1 text-[10px] text-amber-300/80 bg-amber-500/[0.08] border border-amber-500/20 px-1.5 py-0.5 rounded">
                          <AlertCircle className="w-2.5 h-2.5" />
                          Not in registry
                        </span>
                      </div>
                      <div className="flex items-center gap-2 mt-1 flex-wrap">
                        {l.symbols.slice(0, 6).map((sym) => (
                          <Badge key={sym} variant="outline" className="text-[10px] font-mono">{sym}</Badge>
                        ))}
                        {tierBadge(l.tier)}
                        {l.capitalRequirement && (
                          <span className="text-[10px] px-1.5 py-0.5 rounded bg-blue-500/[0.06] text-blue-300/80 border border-blue-500/20">
                            Needs {l.capitalRequirement}
                          </span>
                        )}
                      </div>
                    </div>
                    {l.codeFile && (
                      <span className="inline-flex items-center gap-1 text-[10px] text-muted-foreground/70 border border-border rounded px-1.5 py-1 font-mono shrink-0" title={l.codeFile}>
                        <Code2 className="w-3 h-3" />
                        {l.codeFile}
                      </span>
                    )}
                  </div>
                </CardHeader>
                <CardContent className="space-y-3">
                  <p className="text-xs text-muted-foreground">{l.description}</p>
                  <div>
                    <div className="text-[10px] uppercase tracking-wider text-muted-foreground/70 mb-1.5">Setup types</div>
                    <div className="flex flex-wrap gap-1.5">
                      {l.setupTypes.map((s) => (
                        <span key={s} className="text-[11px] px-1.5 py-0.5 rounded bg-muted/40 border border-border">{s}</span>
                      ))}
                    </div>
                  </div>
                  {l.backtest && (
                    <div className="border border-border rounded-md bg-muted/20 p-2.5">
                      <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1.5">Backtest evidence</div>
                      <div className="grid grid-cols-3 gap-3 text-[11px]">
                        <div>
                          <div className="text-muted-foreground/70">Profit Factor</div>
                          <div className={`font-semibold tabular-nums text-sm ${l.backtest.pf >= 1.2 ? "text-emerald-400" : l.backtest.pf >= 1.0 ? "text-amber-400" : "text-red-400"}`}>{l.backtest.pf.toFixed(2)}</div>
                        </div>
                        <div>
                          <div className="text-muted-foreground/70">Trades</div>
                          <div className="font-semibold tabular-nums text-sm">{l.backtest.trades.toLocaleString()}</div>
                        </div>
                        <div>
                          <div className="text-muted-foreground/70">Period</div>
                          <div className="text-[11px] tabular-nums text-foreground/80">{l.backtest.period}</div>
                        </div>
                      </div>
                    </div>
                  )}
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

            {/* Empty state */}
            {totalStrategiesInClass === 0 && observed.length === 0 && (
              <Card className="border-dashed">
                <CardContent className="py-4 text-xs text-muted-foreground text-center">
                  No strategies in this asset class yet.
                </CardContent>
              </Card>
            )}
          </section>
        );
      })}
    </div>
  );
}
