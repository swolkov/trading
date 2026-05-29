import { STRATEGIES, STRATEGY_REGISTRY_ONLY_SYMBOLS } from "@/lib/strategies/registry";
import { ASSET_CLASSES, assetClassFor } from "@/lib/asset-classes";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import Link from "next/link";
import { StrategyAssignmentControls } from "./strategy-row";

export const dynamic = "force-dynamic";

function tierBadge(tier: 1 | 2 | 3 | "rejected") {
  if (tier === 1) return <Badge className="bg-emerald-500/15 text-emerald-300 border-emerald-500/30">Tier 1 — Validated</Badge>;
  if (tier === 2) return <Badge className="bg-amber-500/15 text-amber-300 border-amber-500/30">Tier 2 — Plausible</Badge>;
  if (tier === 3) return <Badge className="bg-blue-500/15 text-blue-300 border-blue-500/30">Tier 3 — Speculative</Badge>;
  return <Badge className="bg-red-500/15 text-red-300 border-red-500/30">Rejected</Badge>;
}

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

  // Group strategies by asset class (via their applicable symbols)
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
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Strategies</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Every registered signal-generator, scoped by asset class × timeframe × signal family.
          Tier reflects validation status per <Link href="/edges" className="underline text-emerald-400">Edge Hierarchy</Link>.
        </p>
      </div>

      {ASSET_CLASSES.map((ac) => {
        const strats = strategiesByClass.get(ac.id) ?? [];
        const observed = observationByClass.get(ac.id) ?? [];
        if (strats.length === 0 && observed.length === 0) return null;
        return (
          <Card key={ac.id}>
            <CardHeader className="pb-2">
              <CardTitle className="text-base">{ac.label}</CardTitle>
              <p className="text-xs text-muted-foreground">{ac.description}</p>
            </CardHeader>
            <CardContent className="space-y-4">
              {strats.length > 0 && (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="w-[200px]">Strategy</TableHead>
                      <TableHead>Timeframe</TableHead>
                      <TableHead>Symbols</TableHead>
                      <TableHead>Tier</TableHead>
                      <TableHead>Description</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {strats.map((s) => (
                      <TableRow key={s.id}>
                        <TableCell>
                          <div className="font-medium">{s.name}</div>
                          <div className="text-[11px] text-muted-foreground font-mono">{s.id}</div>
                          <StrategyAssignmentControls strategy={{ id: s.id, name: s.name }} />
                        </TableCell>
                        <TableCell>
                          <Badge variant="outline" className="text-[10px]">{s.timeframe}</Badge>
                        </TableCell>
                        <TableCell>
                          <div className="flex flex-wrap gap-1">
                            {s.applicableSymbols.map((sym) => (
                              <Badge key={sym} variant="outline" className="text-[10px] font-mono">{sym}</Badge>
                            ))}
                          </div>
                        </TableCell>
                        <TableCell>{tierBadge(s.tier)}</TableCell>
                        <TableCell className="text-xs text-muted-foreground max-w-md">{s.description}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}

              {observed.length > 0 && (
                <div className="border-t border-border pt-3">
                  <div className="text-xs font-semibold text-muted-foreground mb-2 uppercase tracking-wider">
                    Observation-only (no registered strategy)
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {observed.map((sym) => (
                      <div key={sym} className="flex items-center gap-1.5 px-2 py-1 rounded bg-muted/40 border border-border">
                        <span className="font-mono text-[11px]">{sym}</span>
                        <span className="text-[10px] text-muted-foreground">streaming, no trades</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </CardContent>
          </Card>
        );
      })}

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Legacy 5m intraday library</CardTitle>
          <p className="text-xs text-muted-foreground">
            The original combined-setup detector in <code className="text-[11px] bg-muted px-1 py-0.5 rounded">futures-agent.ts</code> handles
            ES/NQ/GC/MES/MNQ/MGC via a single function that tries multiple setup types
            (OR breakout, IB extension, gap fill, RSI extreme, etc.). Not yet migrated into
            the strategy registry. PF ~0.98 on equity indexes, PF 1.23 on gold (Tier 2).
          </p>
        </CardHeader>
      </Card>
    </div>
  );
}
