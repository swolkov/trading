import { prisma } from "@/lib/db";

/**
 * EDGE TRUTH — per-edge performance from the CLEAN broker-reconciled ledger, with the statistics
 * that decide whether an edge is real or noise.
 *
 * WHY IT IS SEPARATE FROM /edge-scoreboard: that one reconstructs from autoTradeLog, which is
 * fragmented and historically double-logged. This reads RoundTrip — one row per closed position,
 * sourced from actual broker fills — now that setupType/rMultiple are populated
 * (see lib/roundtrip-attribution.ts). Same question, trustworthy source.
 *
 * The number that matters is the t-stat, not the P&L. A positive edge over 14 trades is not an
 * edge, it is 14 trades. The project rule is scale only at t > 2, so this reports t and the
 * trades-still-needed to reach it rather than leaving that arithmetic to the reader.
 */
export const dynamic = "force-dynamic";

interface Row {
  setupType: string; n: number; net: number; pf: number; winRate: number;
  avgPerTrade: number; avgR: number | null; tStat: number;
  tradesForSignificance: number | null; verdict: string;
}

function stats(setupType: string, pnls: number[], rs: number[]): Row {
  const n = pnls.length;
  const net = pnls.reduce((a, b) => a + b, 0);
  const mean = net / n;
  const sd = n > 1 ? Math.sqrt(pnls.reduce((s, x) => s + (x - mean) ** 2, 0) / (n - 1)) : 0;
  const tStat = sd > 0 ? mean / (sd / Math.sqrt(n)) : 0;
  const gp = pnls.filter(x => x > 0).reduce((a, b) => a + b, 0);
  const gl = Math.abs(pnls.filter(x => x < 0).reduce((a, b) => a + b, 0));
  // n required for t=2 at this mean/sd — i.e. "how much longer until this is provable?"
  const need = mean > 0 && sd > 0 ? Math.ceil(((2 * sd) / mean) ** 2) : null;
  const verdict =
    n < 30 ? "too few trades"
    : tStat > 2 ? "PROVEN — safe to scale"
    : tStat > 1 ? "promising, not proven"
    : tStat < -1 ? "losing"
    : "noise";
  return {
    setupType, n, net: +net.toFixed(2),
    pf: gl > 0 ? +(gp / gl).toFixed(2) : 0,
    winRate: Math.round((pnls.filter(x => x > 0).length / n) * 100),
    avgPerTrade: +mean.toFixed(2),
    avgR: rs.length ? +(rs.reduce((a, b) => a + b, 0) / rs.length).toFixed(2) : null,
    tStat: +tStat.toFixed(2),
    tradesForSignificance: need && need > n ? need : null,
    verdict,
  };
}

export async function GET() {
  try {
    const rt = await prisma.roundTrip.findMany({ orderBy: { id: "asc" } });

    const out: Record<string, { edges: Row[]; overall: Row | null }> = {};
    for (const mode of ["live", "paper"]) {
      const rows = rt.filter(t => t.mode === mode);
      const byEdge: Record<string, { p: number[]; r: number[] }> = {};
      for (const t of rows) {
        const k = t.setupType ?? "unattributed";
        (byEdge[k] ??= { p: [], r: [] });
        byEdge[k].p.push(t.pnl);
        if (t.rMultiple != null) byEdge[k].r.push(t.rMultiple);
      }
      const edges = Object.entries(byEdge)
        .map(([k, v]) => stats(k, v.p, v.r))
        .sort((a, b) => b.net - a.net);
      const allP = rows.map(t => t.pnl);
      const allR = rows.filter(t => t.rMultiple != null).map(t => t.rMultiple!);
      out[mode] = { edges, overall: allP.length ? stats("ALL", allP, allR) : null };
    }

    // Execution cost — the other thing that was invisible. Slippage is only meaningful against the
    // risk it eats, so report the dollar cost per fill alongside the raw points.
    const PT: Record<string, number> = { ES: 50, NQ: 20, GC: 100, MES: 5, MNQ: 2, MGC: 10 };
    const eq = await prisma.$queryRawUnsafe<{ mode: string; symbol: string; slippage: number }[]>(
      "SELECT mode, symbol, slippage FROM execution_quality ORDER BY ts DESC LIMIT 500"
    ).catch(() => []);
    const slipMap: Record<string, number[]> = {};
    for (const r of eq) (slipMap[`${r.mode}|${r.symbol}`] ??= []).push(Math.abs(Number(r.slippage)));
    const slippage = Object.entries(slipMap).map(([k, a]) => {
      const [mode, symbol] = k.split("|");
      const s = [...a].sort((x, y) => x - y);
      const median = s[Math.floor(s.length / 2)];
      return {
        mode, symbol, n: a.length,
        medianPts: +median.toFixed(2),
        meanPts: +(a.reduce((x, y) => x + y, 0) / a.length).toFixed(2),
        maxPts: +s[s.length - 1].toFixed(2),
        medianCost: +(median * (PT[symbol] ?? 5)).toFixed(2),
      };
    }).sort((a, b) => b.medianCost - a.medianCost);

    return Response.json({ ...out, slippage });
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
