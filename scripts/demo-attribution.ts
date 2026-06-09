/**
 * DEMO P&L ATTRIBUTION — clean, from the DB, separated from live by instrument.
 * Answers: is the demo's gain a repeatable EDGE or a few lucky trades (VARIANCE)? Where do losses come from?
 * Note: DB dollar totals are ~inflated (double-logged) — but CONCENTRATION RATIOS and instrument MIX are
 * robust to a uniform factor, and win-rates/counts are reliable. Balance-delta truth: demo ≈ +$9,835.
 *
 * Run: node_modules/.bin/tsx scripts/demo-attribution.ts
 */
import { prisma } from "../src/lib/db";

const DEMO = ["ES", "NQ", "GC", "MBT", "MGC"];
const LIVE = ["MES", "MNQ", "MYM", "M2K"];

function analyze(label: string, trades: { symbol: string; pnl: number; createdAt: Date }[]) {
  if (!trades.length) { console.log(`\n${label}: no trades`); return; }
  const total = trades.reduce((s, t) => s + t.pnl, 0);
  const wins = trades.filter((t) => t.pnl > 0);
  const losses = trades.filter((t) => t.pnl < 0);
  const grossWin = wins.reduce((s, t) => s + t.pnl, 0);
  const grossLoss = -losses.reduce((s, t) => s + t.pnl, 0);
  const sorted = [...trades].sort((a, b) => b.pnl - a.pnl);
  const top3 = sorted.slice(0, 3).reduce((s, t) => s + t.pnl, 0);
  const exTop3 = total - top3;
  const $ = (x: number) => (x >= 0 ? "+$" : "-$") + Math.abs(x).toFixed(0);

  console.log(`\n══ ${label} ══`);
  console.log(`  ${trades.length} trades | win ${(wins.length / trades.length * 100).toFixed(0)}% | PF ${grossLoss > 0 ? (grossWin / grossLoss).toFixed(2) : "INF"} | net ${$(total)} (DB ~inflated; shape is what matters)`);
  console.log(`  Top 3 winners = ${$(top3)}  →  ${(top3 / total * 100).toFixed(0)}% of all profit`);
  console.log(`  Net WITHOUT the top 3 winners: ${$(exTop3)}  ${exTop3 <= 0 ? "◀ ⚠️ the 'edge' IS those 3 trades (variance, not repeatable)" : "← still positive without them (more edge-like)"}`);
  console.log(`  Biggest winners:  ${sorted.slice(0, 5).map((t) => `${t.symbol} ${$(t.pnl)}`).join("  ")}`);
  console.log(`  Biggest losers:   ${sorted.slice(-5).reverse().map((t) => `${t.symbol} ${$(t.pnl)}`).join("  ")}`);

  // by instrument
  const bySym = new Map<string, { n: number; pnl: number; w: number }>();
  for (const t of trades) { const e = bySym.get(t.symbol) ?? { n: 0, pnl: 0, w: 0 }; e.n++; e.pnl += t.pnl; if (t.pnl > 0) e.w++; bySym.set(t.symbol, e); }
  console.log(`  By instrument:`);
  for (const [sym, e] of [...bySym.entries()].sort((a, b) => b[1].pnl - a[1].pnl))
    console.log(`     ${sym.padEnd(4)} ${String(e.n).padStart(3)} trades  win ${(e.w / e.n * 100).toFixed(0).padStart(3)}%  ${$(e.pnl).padStart(9)}  ${e.pnl < 0 ? "◀ LOSER — candidate to cut" : ""}`);

  // worst days
  const byDay = new Map<string, number>();
  for (const t of trades) { const d = t.createdAt.toISOString().slice(0, 10); byDay.set(d, (byDay.get(d) ?? 0) + t.pnl); }
  const days = [...byDay.entries()].sort((a, b) => a[1] - b[1]);
  console.log(`  Worst days: ${days.slice(0, 3).map(([d, p]) => `${d} ${$(p)}`).join("  ")}`);
  console.log(`  Best days:  ${days.slice(-3).reverse().map(([d, p]) => `${d} ${$(p)}`).join("  ")}`);
}

async function main() {
  const trades = await prisma.autoTradeLog.findMany({
    where: { pnl: { not: null }, createdAt: { gte: new Date("2026-05-18") } },
    select: { symbol: true, pnl: true, createdAt: true },
    orderBy: { createdAt: "asc" },
  });
  const demo = trades.filter((t) => DEMO.includes(t.symbol)) as { symbol: string; pnl: number; createdAt: Date }[];
  const live = trades.filter((t) => LIVE.includes(t.symbol)) as { symbol: string; pnl: number; createdAt: Date }[];
  const other = trades.filter((t) => !DEMO.includes(t.symbol) && !LIVE.includes(t.symbol));
  console.log(`Pulled ${trades.length} realized trades since 2026-05-18  (demo ${demo.length} / live ${live.length} / other ${other.length})`);
  if (other.length) console.log(`Other symbols: ${[...new Set(other.map((t) => t.symbol))].join(", ")}`);
  analyze("DEMO ($59k — ES/NQ/GC/MBT)", demo);
  analyze("LIVE ($1k — MES/MNQ)", live);
  await prisma.$disconnect();
}
main().catch(async (e) => { console.error("Failed:", e); await prisma.$disconnect().catch(() => {}); process.exit(1); });
