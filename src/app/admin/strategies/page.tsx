import { STRATEGIES, STRATEGY_REGISTRY_ONLY_SYMBOLS } from "@/lib/strategies/registry";
import { ASSET_CLASSES, assetClassFor, type AssetClass } from "@/lib/asset-classes";
import { Card, CardContent } from "@/components/ui/card";
import Link from "next/link";
import { Brain, ArrowRight, Activity, Eye, PowerOff, Info } from "lucide-react";
import { StrategyRowCompact } from "./strategy-row-compact";
import { AccountsPanel } from "./accounts-panel";
import { getEdgePerformance, getRealtimeEdgePerformance, type RealtimeEdgePerf } from "@/lib/edge-performance";
import { REALTIME_EDGES, isEdgeEnabled } from "@/lib/realtime-edges";
import { prisma } from "@/lib/db";
import { EdgeControlBoard, type EdgeVM } from "./edge-control-board";

export const dynamic = "force-dynamic";

type StatusTag = "active" | "research" | "disabled" | "untested";

interface LegacyStrategy {
  name: string;
  setupTypes: string[];
  symbols: string[];
  assetClass: AssetClass;
  tier: 1 | 2 | 3;
  status: StatusTag;
  description: string;
  backtest?: { pf: number; trades: number; period: string };
  codeFile?: string;
  capitalRequirement?: string;
}

const LEGACY_STRATEGIES: LegacyStrategy[] = [
  {
    name: "Equity index 5m — GATED to 2 validated edges",
    setupTypes: ["RSI≥80 overbought SHORT (MNQ/MES)", "Trend-continuation LONG in uptrend, price>200-EMA (MNQ/MES)"],
    symbols: ["MNQ", "MES"],
    assetClass: "equity_index_futures",
    tier: 2,
    status: "active",
    description: "The engine scans ~8 setup types per 5m bar, but the GATE rejects all index setups except two that hold out-of-sample: (1) extreme-RSI overbought SHORT at RSI≥80, and (2) trend-continuation LONG — buy EMA9 pullbacks ONLY when price is above the 200-EMA (confirmed uptrend). The long is validated on a 4.5-yr backtest INCLUDING the 2022 bear (real micro fills): PF 1.22 pooled, positive in BOTH train (1.15) and test (1.31); NQ 1.24 / ES 1.18. The SAME long below the 200-EMA loses (PF 0.55) — the regime filter is the edge. Everything else (gap-fill, OR-breakout, IB-ext, VWAP, index shorts other than the RSI≥80 fade) is GATED OFF. 1 micro, RTH.",
    backtest: { pf: 1.22, trades: 5077, period: "4.5yr (2022-2026), regime-filtered long" },
    codeFile: "futures-realtime.ts",
  },
  {
    name: "Gold RSI extreme bounce (5m) — flagship edge",
    setupTypes: ["extreme_rsi_bounce ONLY (RSI<25 long / RSI>75 short)"],
    symbols: ["MGC", "GC"],
    assetClass: "metals_futures",
    tier: 2,
    status: "active",
    description: "Gold is GATED to its single out-of-sample edge: the RSI extreme bounce (both directions). Every other gold setup (trend-continuation, gap-fill, VWAP) is REJECTED — trend-continuation is exactly what bled the live account in early July. 26-yr daily backtest PF 1.58 (positive in every 5-yr block, 2000-2026); live PF ~1.5 over 60d. Evening half-size on MGC once equity ≥ $3k. The most durable edge in the system.",
    backtest: { pf: 1.24, trades: 720, period: "OOS 2026 / 26yr daily PF 1.58" },
    codeFile: "futures-realtime.ts",
  },
  {
    name: "Spread book (relative-value z-score)",
    setupTypes: ["Z-score entry", "Mean-reversion exit", "Per-pair structural stop"],
    symbols: ["CL-RB", "ZC-ZS", "6E-6B", "GC-SI"],
    assetClass: "relative_value_spreads",
    tier: 2,
    status: "research",
    description: "Only Tier-1 validated edge. 14/14 rolling 3yr windows positive (2011-2026), Sharpe 1.59. Forward-tracking via scripts/spread-track.ts. Needs $100K+ to deploy.",
    backtest: { pf: 1.59, trades: 280, period: "15yr (2011-2026)" },
    codeFile: "scripts/spread-track.ts",
    capitalRequirement: "$100K+",
  },
  {
    name: "Stocks swing (Alpaca daily)",
    setupTypes: ["AI grader signal", "Watchlist screen", "Earnings/catalyst"],
    symbols: ["watchlist"],
    assetClass: "stocks",
    tier: 3,
    status: "untested",
    description: "Daily swing trades from /watchlist + /research scoring. 30-day paper test at $1K. No edge yet — sample too small.",
    codeFile: "auto-trader.ts",
  },
  {
    name: "Crypto spot 24/7 (Alpaca)",
    setupTypes: ["Long-only mean reversion", "Watchlist signals"],
    symbols: ["BTCUSD", "ETHUSD"],
    assetClass: "crypto_spot",
    tier: 3,
    status: "untested",
    description: "24/7 spot via Alpaca. No margin, no expiry. Fractional sizing. Observation-only — no validated strategy yet.",
    codeFile: "auto-trader.ts",
  },
  {
    name: "Wheel (covered calls + cash-secured puts)",
    setupTypes: ["CSP entry", "Assignment → CC roll"],
    symbols: ["disabled"],
    assetClass: "options",
    tier: 3,
    status: "disabled",
    description: "Wheel strategy. DISABLED per project memory. Re-enable only after account scales.",
    codeFile: "wheel/page.tsx",
  },
];

function statusPill(s: StatusTag) {
  const styles: Record<StatusTag, { color: string; label: string }> = {
    active: { color: "bg-emerald-500/15 text-emerald-300 border-emerald-500/30", label: "Live" },
    research: { color: "bg-blue-500/15 text-blue-300 border-blue-500/30", label: "Research" },
    disabled: { color: "bg-red-500/15 text-red-300 border-red-500/30", label: "Disabled" },
    untested: { color: "bg-amber-500/15 text-amber-300 border-amber-500/30", label: "Untested" },
  };
  const s2 = styles[s];
  return <span className={`text-[10px] px-1.5 py-0.5 rounded border ${s2.color}`}>● {s2.label}</span>;
}

function tierPill(tier: 1 | 2 | 3) {
  if (tier === 1) return <span className="text-[10px] font-bold px-1.5 py-0.5 rounded border bg-emerald-500/15 text-emerald-300 border-emerald-500/30">T1</span>;
  if (tier === 2) return <span className="text-[10px] font-bold px-1.5 py-0.5 rounded border bg-amber-500/15 text-amber-300 border-amber-500/30">T2</span>;
  return <span className="text-[10px] font-bold px-1.5 py-0.5 rounded border bg-blue-500/15 text-blue-300 border-blue-500/30">T3</span>;
}

export default async function StrategiesAdminPage() {
  const edgePerf = await getEdgePerformance().catch(() => null);

  // Realtime-engine edge control board: current per-engine switch state + demo/live results per edge.
  const [flagRows, livePerf, demoPerf] = await Promise.all([
    prisma.agentConfig.findMany({ where: { key: { startsWith: "edge_" } } }).catch(() => [] as { key: string; value: string }[]),
    getRealtimeEdgePerformance("live").catch(() => ({}) as Record<string, RealtimeEdgePerf>),
    getRealtimeEdgePerformance("demo").catch(() => ({}) as Record<string, RealtimeEdgePerf>),
  ]);
  const flagCfg: Record<string, string | undefined> = {};
  for (const r of flagRows) flagCfg[r.key] = r.value;
  const edgeControlVMs: EdgeVM[] = REALTIME_EDGES.map((e) => ({
    key: e.key,
    name: e.name,
    blurb: e.blurb,
    evidence: e.evidence,
    symbolClass: e.symbolClass,
    demoEnabled: isEdgeEnabled(e.key, "demo", flagCfg),
    liveEnabled: isEdgeEnabled(e.key, "live", flagCfg),
    demoPerf: demoPerf[e.key] ?? null,
    livePerf: livePerf[e.key] ?? null,
  }));
  const observationByClass = new Map<string, string[]>();
  for (const sym of STRATEGY_REGISTRY_ONLY_SYMBOLS) {
    const hasStrategy = STRATEGIES.some((s) => s.applicableSymbols.includes(sym));
    if (hasStrategy) continue;
    const ac = assetClassFor(sym);
    const key = ac ?? "other";
    if (!observationByClass.has(key)) observationByClass.set(key, []);
    observationByClass.get(key)!.push(sym);
  }
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

  return (
    <div className="max-w-6xl mx-auto space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-xl font-bold tracking-tight">Strategies</h1>
          <p className="text-[11px] text-muted-foreground/50">Every trading activity organized by asset class. Tier reflects validation per Edge Hierarchy.</p>
        </div>
        <Link href="/edges" className="inline-flex items-center gap-1.5 text-xs px-2.5 py-1.5 rounded-md border border-border bg-muted/30 hover:bg-muted/60 transition-colors">
          <Brain className="w-3.5 h-3.5" />
          Edge Hierarchy
          <ArrowRight className="w-3 h-3" />
        </Link>
      </div>

      {/* LIVE per-edge results — what's actually working in real money, since inception */}
      {edgePerf && (
        <div className="border border-border rounded-lg bg-muted/10 p-3">
          <div className="flex items-center justify-between mb-2">
            <div className="text-xs font-bold tracking-tight flex items-center gap-1.5"><Activity className="w-3.5 h-3.5 text-emerald-400" /> Which edge works — real money</div>
            <div className="text-[10px] text-muted-foreground/60">
              per-edge sum{" "}
              <span className={edgePerf.totalNet >= 0 ? "text-emerald-400 font-bold" : "text-red-400 font-bold"}>{edgePerf.totalNet >= 0 ? "+" : ""}${edgePerf.totalNet.toFixed(0)}</span>
              <span className="ml-1 text-muted-foreground/40">· account balance = true total</span>
            </div>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
            {edgePerf.edges.map((e) => (
              <div key={e.key} className="border border-border/60 rounded-md bg-background/40 p-2.5">
                <div className="flex items-center justify-between gap-2">
                  <div className="text-[11px] font-semibold truncate">{e.name}</div>
                  <div className={`text-xs font-bold shrink-0 ${e.net > 0 ? "text-emerald-400" : e.net < 0 ? "text-red-400" : "text-muted-foreground"}`}>{e.net >= 0 ? "+" : ""}${e.net.toFixed(0)}</div>
                </div>
                <div className="text-[10px] text-muted-foreground mt-1">
                  {e.trades === 0 ? (
                    <span className="text-amber-400/80">no live trades yet</span>
                  ) : (
                    <>{e.trades} trade{e.trades === 1 ? "" : "s"} · {(e.winRate * 100).toFixed(0)}% win ({e.wins}W/{e.losses}L)</>
                  )}
                </div>
                <div className="text-[9px] text-muted-foreground/50 mt-1 leading-tight">{e.blurb}</div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Realtime-engine edge switches — the demo→live promotion control board */}
      <EdgeControlBoard edges={edgeControlVMs} />

      {/* Accounts + master mode panel */}
      <AccountsPanel />

      {/* Layer explainer — the 3-layer truth that's been confusing */}
      <details className="text-xs">
        <summary className="cursor-pointer text-muted-foreground/60 hover:text-foreground inline-flex items-center gap-1">
          <Info className="w-3 h-3" />
          Why am I seeing different "live" indicators? (3 layers explained)
        </summary>
        <div className="mt-2 border border-border rounded-md bg-muted/10 p-3 space-y-2 text-[11px] text-muted-foreground">
          <div><strong className="text-foreground">1. View Mode (top bar):</strong> which account&apos;s data you&apos;re looking at. Toggle freely. Does NOT cause live trades.</div>
          <div><strong className="text-foreground">2. Trading Mode (Agent Hub → LIVE TRADING):</strong> whether the engine actually fires live trades. Password-gated. This is the &quot;live trading activated&quot; state shown in the red banner above.</div>
          <div><strong className="text-foreground">3. Strategy Assignment (this page):</strong> per-strategy per-account on/off switch. Even with Trading Mode = LIVE, individual strategies stay in observation/disabled here unless you flip them.</div>
          <div className="pt-1 border-t border-border/40 text-foreground/70">
            For a strategy to fire live trades: Trading Mode = LIVE <strong>AND</strong> strategy assignment on live = ACTIVE. Both required.
          </div>
        </div>
      </details>

      {/* Status legend */}
      <div className="flex flex-wrap items-center gap-3 text-[10px] text-muted-foreground/60 pb-1 border-b border-border/40">
        <span className="uppercase tracking-wider">Status:</span>
        <span className="inline-flex items-center gap-1"><Activity className="w-3 h-3 text-emerald-400" /> Active = fires real trades</span>
        <span className="inline-flex items-center gap-1"><Eye className="w-3 h-3 text-amber-400" /> Observation = logs signals, no trades</span>
        <span className="inline-flex items-center gap-1"><PowerOff className="w-3 h-3 text-red-400" /> Disabled = skipped entirely</span>
      </div>

      {/* Per asset-class sections */}
      {ASSET_CLASSES.map((ac) => {
        const strats = strategiesByClass.get(ac.id) ?? [];
        const observed = observationByClass.get(ac.id) ?? [];
        const legacy = LEGACY_STRATEGIES.filter((l) => l.assetClass === ac.id);
        const totalCount = strats.length + legacy.length;
        // Auto-expand sections that have a registered (registry) strategy
        const defaultExpand = strats.length > 0;

        return (
          <details key={ac.id} className="group" open={defaultExpand}>
            <summary className="cursor-pointer list-none">
              <div className="flex items-center justify-between gap-3 px-3 py-2.5 border border-border rounded-md bg-muted/20 hover:bg-muted/30 transition-colors">
                <div className="flex items-center gap-2 min-w-0 flex-1">
                  <ArrowRight className="w-3.5 h-3.5 text-muted-foreground/60 transition-transform group-open:rotate-90 shrink-0" />
                  <div className="min-w-0">
                    <div className="text-sm font-semibold truncate">{ac.label}</div>
                    <div className="text-[10px] text-muted-foreground/60 mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5">
                      <span title="Exchange">📊 {ac.exchange}</span>
                      <span title="Data feed">📡 {ac.dataFeed}</span>
                      <span title="Broker">💼 {ac.broker}</span>
                      <span title="Trading hours">🕒 {ac.hours}</span>
                    </div>
                  </div>
                </div>
                <div className="flex items-center gap-1.5 shrink-0">
                  <span className="text-[10px] px-1.5 py-0.5 rounded bg-emerald-500/[0.06] text-emerald-300 border border-emerald-500/20">
                    {totalCount} {totalCount === 1 ? "strategy" : "strategies"}
                  </span>
                  {observed.length > 0 && (
                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-muted/40 border border-border">
                      {observed.length} obs
                    </span>
                  )}
                </div>
              </div>
            </summary>

            <div className="mt-2 space-y-2 pl-1">
              {/* Registry strategies (compact rows) */}
              {strats.map((s) => (
                <StrategyRowCompact
                  key={s.id}
                  strategy={{
                    id: s.id,
                    name: s.name,
                    timeframe: s.timeframe,
                    tier: s.tier,
                    description: s.description,
                    applicableSymbols: s.applicableSymbols,
                    backtest: s.backtest,
                    vaultDoc: s.vaultDoc,
                    codePath: s.codePath,
                  }}
                  defaultOpen={s.tier === 2 && strats.length === 1}
                />
              ))}

              {/* Legacy strategies (not in registry, show as info cards) */}
              {legacy.map((l) => (
                <details key={l.name} className="border border-amber-500/20 rounded-md bg-card overflow-hidden">
                  <summary className="cursor-pointer list-none">
                    <div className="px-3 py-2.5 flex items-center gap-3 hover:bg-muted/20">
                      <span className="text-[9px] uppercase tracking-wider text-amber-300/80 bg-amber-500/[0.08] border border-amber-500/20 px-1.5 py-0.5 rounded shrink-0">Legacy</span>
                      {tierPill(l.tier)}
                      <div className="min-w-0 flex-1">
                        <div className="font-medium text-[13px] truncate">{l.name}</div>
                        <div className="flex items-center gap-1 mt-0.5 flex-wrap">
                          {l.symbols.slice(0, 5).map((s) => (
                            <span key={s} className="text-[10px] font-mono px-1 py-0 rounded bg-muted/30 text-foreground/60">{s}</span>
                          ))}
                          {l.capitalRequirement && (
                            <span className="text-[10px] px-1.5 py-0.5 rounded bg-blue-500/[0.06] text-blue-300/80 border border-blue-500/20">Needs {l.capitalRequirement}</span>
                          )}
                        </div>
                      </div>
                      {l.backtest && (
                        <div className="hidden sm:block text-right shrink-0">
                          <div className={`text-sm font-semibold tabular-nums ${l.backtest.pf >= 1.3 ? "text-emerald-400" : l.backtest.pf >= 1.0 ? "text-amber-400" : "text-red-400"}`}>{l.backtest.pf.toFixed(2)}</div>
                          <div className="text-[9px] text-muted-foreground/60 uppercase tracking-wider">PF</div>
                        </div>
                      )}
                      {statusPill(l.status)}
                    </div>
                  </summary>
                  <div className="border-t border-border bg-muted/10 px-3 py-3 space-y-2">
                    <p className="text-xs text-muted-foreground">{l.description}</p>
                    <div className="flex flex-wrap gap-1.5">
                      <span className="text-[10px] uppercase tracking-wider text-muted-foreground/50 mr-1">Setups:</span>
                      {l.setupTypes.map((s) => (
                        <span key={s} className="text-[10px] px-1.5 py-0.5 rounded bg-muted/30 border border-border/40">{s}</span>
                      ))}
                    </div>
                    {l.backtest && (
                      <div className="text-[11px] text-muted-foreground/70">
                        Backtest: <span className="font-semibold tabular-nums">{l.backtest.pf.toFixed(2)}</span> PF over <span className="tabular-nums">{l.backtest.trades.toLocaleString()}</span> trades, {l.backtest.period}
                      </div>
                    )}
                    {l.codeFile && (
                      <div className="text-[10px] text-muted-foreground/50 font-mono">Code: {l.codeFile}</div>
                    )}
                    <div className="text-[10px] text-muted-foreground/50 italic">Not in registry — controlled by realtime engine / agent hub.</div>
                  </div>
                </details>
              ))}

              {/* Observation-only symbols */}
              {observed.length > 0 && (
                <div className="border border-dashed border-border rounded-md px-3 py-2 bg-card">
                  <div className="text-[10px] uppercase tracking-wider text-muted-foreground/60 mb-1.5">Observation symbols — sidecar streams, no strategy fires</div>
                  <div className="flex flex-wrap gap-1.5">
                    {observed.map((sym) => (
                      <span key={sym} className="inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded bg-muted/40 border border-border">
                        <span className="font-mono font-semibold">{sym}</span>
                        <span className="text-muted-foreground/60">streaming</span>
                      </span>
                    ))}
                  </div>
                </div>
              )}

              {totalCount === 0 && observed.length === 0 && (
                <div className="text-[11px] text-muted-foreground/50 italic px-3 py-2">No strategies in this asset class yet.</div>
              )}
            </div>
          </details>
        );
      })}

      <div className="text-[10px] text-muted-foreground/40 pt-3 border-t border-border/40">
        Asset class metadata in <code className="font-mono">src/lib/asset-classes.ts</code> · Strategy registry in <code className="font-mono">src/lib/strategies/registry.ts</code> · Assignment state from <code className="font-mono">StrategyAssignment</code> DB table
      </div>
    </div>
  );
}
