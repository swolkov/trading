import { prisma } from "@/lib/db";
import { REALTIME_EDGES, edgeFlagKey } from "@/lib/realtime-edges";
import { requireAuthenticatedUser } from "@/lib/api-auth";
import { FUTURES_STRATEGY_VERSION } from "@/lib/strategy-version";
import { pnlEvidence } from "@/lib/futures-admin-state";

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
const CURRENT_STRATEGY_VERSION = FUTURES_STRATEGY_VERSION;
const MAX_P90_SLIPPAGE: Record<string, number> = { MGC: 0.50, MNQ: 1.50, MES: 0.50 };

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

    if (!LIVE_PASSWORD) {
      return Response.json({ error: "Admin trading password is not configured" }, { status: 503 });
    }
    if (!password || password !== LIVE_PASSWORD) {
      return Response.json({ error: "Admin trading password required to change edge switches" }, { status: 403 });
    }

    // Promoting an edge to LIVE (real money) is password-gated. Disabling live, or any demo change, is free.
    if (mode === "live" && enabled === true) {
      const heartbeatRow = await prisma.agentConfig.findUnique({ where: { key: "futures_engine_heartbeat_live" } });
      let heartbeat: { timestamp?: string; ready?: boolean; strategyVersion?: string; deploymentId?: string | null } | null = null;
      try { heartbeat = heartbeatRow?.value ? JSON.parse(heartbeatRow.value) : null; } catch { heartbeat = null; }
      const heartbeatAt = Date.parse(heartbeat?.timestamp ?? "");
      if (!Number.isFinite(heartbeatAt) || Date.now() - heartbeatAt >= 90_000 || heartbeat?.ready !== true
        || heartbeat.strategyVersion !== CURRENT_STRATEGY_VERSION || !heartbeat.deploymentId) {
        return Response.json({ error: "Current live engine deployment is not fresh and ready; promotion is blocked" }, { status: 409 });
      }

      const symbols = edge.symbolClass === "metals" ? ["MGC"] : ["MNQ", "MES"];
      // Only P&L whose entry has a matching current-version execution record may promote. This
      // prevents an old strategy's wins from re-arming materially changed code under the same key.
      let evidence: Array<{ symbol: string; pnl: number }> = [];
      try {
        evidence = await prisma.$queryRawUnsafe<Array<{ symbol: string; pnl: number }>>(
          `SELECT rt.symbol, rt.pnl
             FROM "RoundTrip" rt
            WHERE rt.mode = 'paper' AND rt."setupType" = $1
              AND rt.symbol = ANY($2::text[])
              AND EXISTS (
                SELECT 1 FROM execution_quality eq
                 WHERE eq.mode = 'demo' AND eq.status = 'filled' AND eq.qty > 0
                   AND eq.symbol = rt.symbol AND eq.edge_key = $1 AND eq.strategy_version = $3
                   AND eq.order_id = rt.entry_order_id
              )
            ORDER BY rt."exitTime" ASC`,
          key, symbols, CURRENT_STRATEGY_VERSION,
        );
      } catch {
        return Response.json({ error: "No current-version P&L evidence is available" }, { status: 409 });
      }
      const requiredPnlTrades = edge.symbolClass === "metals" ? 30 : 15;
      const evidenceBySymbol = symbols.map((symbol) => ({
        symbol,
        ...pnlEvidence(evidence.filter((row) => row.symbol === symbol).map((row) => row.pnl), requiredPnlTrades),
      }));
      if (evidenceBySymbol.some((item) => !item.passes)) {
        return Response.json({
          error: "Every traded symbol must independently pass the live-promotion evidence gate",
          evidence: evidenceBySymbol.map((item) => ({ ...item, tStat: Number(item.tStat.toFixed(2)) })),
          required: { tradesPerSymbol: requiredPnlTrades, tStat: "> 2", firstHalf: "> 0", secondHalf: "> 0" },
        }, { status: 409 });
      }

      // Backtest expectancy is not enough for real money. Require a meaningful set of successful
      // demo executions on the same micro instruments so latency and slippage have been observed.
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
    if (mode === "live") {
      const versionFlag = `edge_${key}_live_version`;
      await prisma.$transaction([
        prisma.agentConfig.upsert({ where: { key: flag }, update: { value }, create: { key: flag, value } }),
        prisma.agentConfig.upsert({
          where: { key: versionFlag },
          update: { value: enabled ? CURRENT_STRATEGY_VERSION : "" },
          create: { key: versionFlag, value: enabled ? CURRENT_STRATEGY_VERSION : "" },
        }),
      ]);
    } else {
      await prisma.agentConfig.upsert({ where: { key: flag }, update: { value }, create: { key: flag, value } });
    }

    return Response.json({ ok: true, key, mode, enabled, flag });
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
