import { prisma } from "@/lib/db";
import { REALTIME_EDGES, edgeFlagKey } from "@/lib/realtime-edges";
import { requireAuthenticatedUser } from "@/lib/api-auth";

/**
 * Per-edge, per-engine on/off switch for the realtime futures engine.
 *
 * Writes agentConfig `edge_<key>_<mode>` = "true" | "false". The engine reads this on its next
 * config-refresh cycle (~30s) and gates trades accordingly (see src/lib/realtime-edges.ts).
 *
 * SAFETY: turning an edge ON for LIVE (real money) requires the live password — same guard as the
 * kill switch. Turning anything OFF, or any DEMO change, is unguarded (you can always stop / test).
 */

const LIVE_PASSWORD = process.env.LIVE_TRADING_PASSWORD;
const CURRENT_STRATEGY_VERSION = "2026-08-20-parity-v1";
const MAX_P90_SLIPPAGE: Record<string, number> = { MGC: 0.50, MNQ: 1.50, MES: 0.50 };

function tStat(values: number[]): number {
  if (values.length < 2) return 0;
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (values.length - 1);
  const sd = Math.sqrt(variance);
  return sd > 0 ? mean / (sd / Math.sqrt(values.length)) : 0;
}

export async function POST(request: Request) {
  const unauthorized = await requireAuthenticatedUser();
  if (unauthorized) return unauthorized;

  try {
    const body = await request.json().catch(() => ({}));
    const { key, mode, enabled, password } = body as {
      key?: string;
      mode?: "demo" | "live";
      enabled?: boolean;
      password?: string;
    };

    const edge = REALTIME_EDGES.find((candidate) => candidate.key === key);
    if (!key || !edge) {
      return Response.json({ error: `unknown edge key: ${key}` }, { status: 400 });
    }
    if (mode !== "demo" && mode !== "live") {
      return Response.json({ error: "mode must be 'demo' or 'live'" }, { status: 400 });
    }
    if (typeof enabled !== "boolean") {
      return Response.json({ error: "enabled must be a boolean" }, { status: 400 });
    }

    // Promoting an edge to LIVE (real money) is password-gated. Disabling live, or any demo change, is free.
    if (mode === "live" && enabled === true) {
      if (!LIVE_PASSWORD) {
        return Response.json({ error: "Live trading password is not configured" }, { status: 503 });
      }
      if (!password || password !== LIVE_PASSWORD) {
        return Response.json({ error: "Live password required to enable an edge on real money" }, { status: 403 });
      }

      const evidence = await prisma.roundTrip.findMany({
        where: { mode: "paper", setupType: key },
        orderBy: { exitTime: "asc" },
        select: { pnl: true },
      });
      const pnls = evidence.map((row) => row.pnl);
      const split = Math.floor(pnls.length / 2);
      const firstHalf = pnls.slice(0, split).reduce((sum, pnl) => sum + pnl, 0);
      const secondHalf = pnls.slice(split).reduce((sum, pnl) => sum + pnl, 0);
      const statistic = tStat(pnls);
      if (pnls.length < 30 || statistic <= 2 || firstHalf <= 0 || secondHalf <= 0) {
        return Response.json({
          error: "Edge has not passed the live-promotion evidence gate",
          evidence: { trades: pnls.length, tStat: Number(statistic.toFixed(2)), firstHalf, secondHalf },
          required: { trades: 30, tStat: "> 2", firstHalf: "> 0", secondHalf: "> 0" },
        }, { status: 409 });
      }

      // Backtest expectancy is not enough for real money. Require a meaningful set of successful
      // demo executions on the same micro instruments so latency and slippage have been observed.
      const symbols = edge.symbolClass === "metals" ? ["MGC"] : ["MNQ", "MES"];
      let execution: Array<{ symbol: string; trades: bigint; p90: number | null }> = [];
      try {
        execution = await prisma.$queryRawUnsafe<Array<{ symbol: string; trades: bigint; p90: number | null }>>(
          `SELECT symbol, COUNT(*)::bigint AS trades,
                  percentile_cont(0.9) WITHIN GROUP (ORDER BY slippage) AS p90
             FROM execution_quality
            WHERE mode = 'demo' AND status = 'filled' AND qty > 0
              AND symbol = ANY($1::text[]) AND edge_key = $2 AND strategy_version = $3
            GROUP BY symbol`,
          symbols, key, CURRENT_STRATEGY_VERSION,
        );
      } catch {
        return Response.json({ error: "No verified demo execution-quality record is available" }, { status: 409 });
      }
      const requiredPerSymbol = edge.symbolClass === "metals" ? 30 : 15;
      const failedExecution = symbols.some((symbol) => {
        const row = execution.find((item) => item.symbol === symbol);
        return !row || Number(row.trades) < requiredPerSymbol || row.p90 == null || Number(row.p90) > MAX_P90_SLIPPAGE[symbol];
      });
      if (failedExecution) {
        return Response.json({
          error: "Edge has not passed current-version demo execution quality",
          execution: execution.map((row) => ({ symbol: row.symbol, trades: Number(row.trades), p90Slippage: row.p90 })),
          required: symbols.map((symbol) => ({ symbol, trades: requiredPerSymbol, maxP90Slippage: MAX_P90_SLIPPAGE[symbol] })),
          strategyVersion: CURRENT_STRATEGY_VERSION,
        }, { status: 409 });
      }
    }

    const flag = edgeFlagKey(key, mode);
    const value = enabled ? "true" : "false";
    await prisma.agentConfig.upsert({
      where: { key: flag },
      update: { value },
      create: { key: flag, value },
    });

    return Response.json({ ok: true, key, mode, enabled, flag });
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
