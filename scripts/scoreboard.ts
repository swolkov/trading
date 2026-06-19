/**
 * SCOREBOARD — the honest, always-current read on whether demo & live are working.
 * Uses CLEAN balance-delta (broker EOD balances), never inflated trade-log sums. Shows total P&L,
 * how concentrated it is (a few lucky days vs. a steady climb), and a t-stat that says whether the
 * results are yet distinguishable from luck. Updates itself as trades accumulate — so we stop
 * debating and just watch the number.
 *   railway run npx tsx scripts/scoreboard.ts
 */
import { PrismaClient } from "../src/generated/prisma/client.js";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });

const mean = (a: number[]) => a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0;
const std = (a: number[]) => { if (a.length < 2) return 0; const m = mean(a); return Math.sqrt(a.reduce((s, v) => s + (v - m) ** 2, 0) / a.length); };

async function line(prefix: string, label: string, poolSize?: number, baselineKey?: string) {
  const rows = await prisma.agentConfig.findMany({ where: { key: { startsWith: prefix } }, orderBy: { key: "asc" } });
  const series = rows.map(r => ({ d: r.key.replace(prefix, ""), bal: parseFloat(r.value) })).filter(x => isFinite(x.bal));
  console.log("\n" + "═".repeat(74));
  console.log(`  ${label}`);
  console.log("═".repeat(74));
  if (series.length < 1) { console.log("  not enough history yet"); return; }
  // Anchor P&L to the test baseline when given (Alpaca paper shell is ~$90k; the test pool is $1k —
  // measure delta from baseline and show % against the real pool size, not the shell equity).
  let anchor = series[0].bal;
  if (baselineKey) { const b = await prisma.agentConfig.findUnique({ where: { key: baselineKey } }); const bv = b ? parseFloat(b.value) : NaN; if (isFinite(bv)) anchor = bv; }
  if (series.length < 2 && !baselineKey) { console.log("  not enough history yet"); return; }
  const deltas: number[] = [];
  for (let i = 1; i < series.length; i++) deltas.push(series[i].bal - series[i - 1].bal);
  const moves = deltas.filter(d => Math.abs(d) > 0.01);          // actual trading days
  const tot = series[series.length - 1].bal - anchor;
  const pct = (poolSize ?? series[0].bal) ? tot / (poolSize ?? series[0].bal) * 100 : 0;
  const sorted = [...deltas].sort((a, b) => b - a);
  const top3 = sorted.slice(0, 3).reduce((a, b) => a + b, 0);
  const m = mean(moves), sd = std(moves);
  const t = moves.length >= 3 && sd > 0 ? m / (sd / Math.sqrt(moves.length)) : 0;
  console.log(`  P&L: ${tot >= 0 ? "+" : ""}$${tot.toFixed(0)} (${pct >= 0 ? "+" : ""}${pct.toFixed(1)}%)  ·  ${series[0].d} → ${series[series.length - 1].d}`);
  console.log(`  Days with a move: ${moves.length}  (up ${moves.filter(d => d > 0).length} / down ${moves.filter(d => d < 0).length})`);
  console.log(`  Top 3 days = $${top3.toFixed(0)}  (${tot !== 0 ? (top3 / tot * 100).toFixed(0) : "—"}% of all P&L)  ← high % = a few lucky days, not a steady edge`);
  console.log(`  Edge signal (t-stat on trading days): ${t.toFixed(2)}`);
  const verdict = moves.length < 10 ? `⏳ TOO FEW TRADING DAYS (${moves.length}) — no read yet; keep trading`
    : Math.abs(t) < 1 ? "🎲 LUCK-LEVEL — profit indistinguishable from a coin flip; do NOT scale real money"
    : t < 2 ? "🟡 INCONCLUSIVE — leaning, but not proven; keep watching"
    : "✅ EDGE EMERGING — statistically real; THIS is when scaling up is justified";
  console.log(`  → ${verdict}`);
}

async function main() {
  console.log("\n  TRADING SCOREBOARD — clean balance-delta, honest read (run anytime)");
  await line("eod_balance_", "FUTURES DEMO ($50K paper)");
  await line("live_eod_balance_", "FUTURES LIVE ($1K real)");
  await line("alpaca_test_eod_", "STOCKS + CRYPTO ($1K paper day-trade test)", 1000, "alpaca_test_baseline_equity");
  console.log("\n  Rule: scale real capital only when a mode reads ✅ EDGE EMERGING. Until then it's a free test.");
  console.log("═".repeat(74) + "\n");
  await pool.end();
}
main().catch(e => { console.error(e); pool.end(); });
