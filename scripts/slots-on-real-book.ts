// DOES CONCENTRATION HOLD ON THE REAL PAPER BOOK? — the forward test of the backtest finding.
//
//   node --env-file=/Users/user/trading/.env.local --import tsx scripts/slots-on-real-book.ts
//
// backtest-portfolio.ts says one big position beats three small ones (paired t=3.27 over 12
// tiebreak seeds). That is a REPLAY over Kraken history. The paper book is FORWARD data the
// rule actually generated, so it is the honest check. replaySlots is the same admission
// engine the capacity card uses; running it at 1..4 slots over the whole book answers the
// same question on data the backtest never saw.
//
// Sizing: paper records P&L at its own base risk, and each slot config would run a DIFFERENT
// base (one slot can afford 3% because 1x6% = 6% of equity, well inside the 15% breaker;
// three slots must sit at 2.2% or 3x4.4% breaches it). Net is scaled by that ratio, which is
// exact because notional is linear in risk.
import { PrismaClient } from "../src/generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { replaySlots, type CapacitySetup } from "../src/lib/margin-capacity";

const p = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }) } as never);

// base risk each slot count can carry inside the 15% drawdown breaker (slots x base x 2 <= 15%)
const BASE_FOR: Record<number, number> = { 1: 3.0, 2: 3.0, 3: 2.2, 4: 1.6 };
const PAPER_BASE = 3.0;

async function main() {
  const rows = await p.$queryRawUnsafe<{
    id: number; time: Date; symbol: string; shadow_status: string | null;
    shadow_pnl: number | null; shadow_unrealized: number | null; shadow_resolved_at: Date | null;
  }[]>(
    `SELECT id, time, symbol, shadow_status, shadow_pnl, shadow_unrealized, shadow_resolved_at
       FROM tradingview_alerts
      WHERE source = 'swing-lev' AND side = 'buy' AND mark_price > 0
      ORDER BY time ASC`,
  );
  const setups: CapacitySetup[] = rows.map((r) => ({
    id: r.id, time: r.time.toISOString(), symbol: r.symbol, timeframe: null,
    kind: "taken", note: null,
    status: r.shadow_status === "resolved" ? "resolved" : "open",
    pnl: r.shadow_status === "resolved" ? r.shadow_pnl : null,
    unrealized: r.shadow_status === "resolved" ? null : r.shadow_unrealized,
    resolvedAt: r.shadow_resolved_at?.toISOString() ?? null,
  }));
  const resolved = setups.filter((s) => s.status === "resolved");
  const first = setups[0]?.time?.slice(0, 10), last = setups[setups.length - 1]?.time?.slice(0, 10);
  console.log(`swing-lev paper book: ${setups.length} setups (${resolved.length} resolved), ${first} → ${last}`);
  console.log(`paper sizes every setup at base ${PAPER_BASE}%; each slot count is rescaled to the base it could actually carry\n`);
  console.log("  slots   base   takes   resolved   net (at that base)   per resolved trade");
  for (const n of [1, 2, 3, 4]) {
    const r = replaySlots(setups, { slots: n, perDay: Number.POSITIVE_INFINITY, cooldownMin: 0 });
    const scale = BASE_FOR[n] / PAPER_BASE;
    const net = r.net * scale;
    const per = r.resolved ? net / r.resolved : 0;
    console.log(
      `  ${String(n).padStart(5)}   ${BASE_FOR[n].toFixed(1)}%   ${String(r.taken).padStart(5)}   ${String(r.resolved).padStart(8)}   ` +
      `${((net < 0 ? "−$" : "+$") + Math.abs(Math.round(net)).toLocaleString()).padStart(18)}   ${(per < 0 ? "−$" : "+$") + Math.abs(Math.round(per)).toLocaleString()}`,
    );
  }
  const all = replaySlots(setups, { slots: 0, perDay: Number.POSITIVE_INFINITY, cooldownMin: 0 });
  console.log(`\n  every setup (no slot limit, base ${PAPER_BASE}%): ${all.taken} takes, ${all.resolved} resolved, net ${(all.net < 0 ? "−$" : "+$") + Math.abs(Math.round(all.net)).toLocaleString()}`);
}
main().catch((e) => { console.error(String(e).slice(0, 300)); process.exit(1); }).finally(() => p.$disconnect());
