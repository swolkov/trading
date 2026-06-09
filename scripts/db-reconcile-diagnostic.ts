/**
 * DB RECONCILE DIAGNOSTIC (READ-ONLY) — finds the ~3x P&L inflation at the row level and computes
 * the TRUE deduplicated P&L per account. No writes; safe to run against production.
 *
 * Root cause (from fill-reconciliation.ts): the reconciler creates a backfill exit row when it can't
 * match an existing log (timestamp skew / orderId mismatch / scale-outs), duplicating the same real
 * trade. This script clusters near-identical exit rows (same symbol, ~same pnl, ~same time, or same
 * orderId) into one logical trade and reports raw-sum vs deduped-sum so we SEE the inflation and
 * confirm the dedup rule BEFORE any write-side fix.
 *
 * Run in prod context:  railway run npx tsx scripts/db-reconcile-diagnostic.ts
 * (or locally if DATABASE_URL reaches the prod DB)
 */
import { prisma } from "../src/lib/db";

const DEMO = new Set(["NQ", "ES", "GC", "MBT", "MGC"]);
const LIVE = new Set(["MES", "MNQ", "MYM", "M2K"]);
const sym = (s: string) => s.replace("FUT:", "");

async function main() {
  const rows = await prisma.autoTradeLog.findMany({
    where: { pnl: { not: null }, symbol: { startsWith: "FUT:" }, createdAt: { gte: new Date("2026-05-18") } },
    select: { id: true, symbol: true, qty: true, pnl: true, orderId: true, action: true, createdAt: true, reconciledAt: true },
    orderBy: { createdAt: "asc" },
  });

  // Cluster near-duplicate rows into one logical trade.
  type R = (typeof rows)[number];
  const used = new Set<number>();
  const clusters: R[][] = [];
  for (const r of rows) {
    if (used.has(r.id)) continue;
    const group = [r]; used.add(r.id);
    for (const o of rows) {
      if (used.has(o.id)) continue;
      const sameOrder = r.orderId && o.orderId && r.orderId === o.orderId;
      const near = sym(o.symbol) === sym(r.symbol)
        && Math.abs((o.pnl || 0) - (r.pnl || 0)) <= 1
        && Math.abs(o.createdAt.getTime() - r.createdAt.getTime()) < 10 * 60 * 1000;
      if (sameOrder || near) { group.push(o); used.add(o.id); }
    }
    clusters.push(group);
  }

  const $ = (x: number) => (x >= 0 ? "+$" : "-$") + Math.abs(x).toFixed(0);
  function report(label: string, keep: (s: string) => boolean) {
    const cl = clusters.filter((g) => keep(sym(g[0].symbol)));
    const rawRows = cl.flat();
    const rawSum = rawRows.reduce((s, r) => s + (r.pnl || 0), 0);
    const dedupSum = cl.reduce((s, g) => s + (g[0].pnl || 0), 0);  // one row per cluster
    const dupes = cl.filter((g) => g.length > 1);
    console.log(`\n══ ${label} ══`);
    console.log(`  raw rows: ${rawRows.length}  |  logical trades: ${cl.length}  |  duplicate clusters: ${dupes.length}`);
    console.log(`  RAW sum (inflated):     ${$(rawSum)}`);
    console.log(`  DEDUPED sum (true-ish): ${$(dedupSum)}   →  inflation factor ${dedupSum !== 0 ? (rawSum / dedupSum).toFixed(2) : "—"}x`);
    if (dupes.length) {
      console.log(`  Sample duplicate clusters:`);
      for (const g of dupes.slice(0, 6))
        console.log(`     ${sym(g[0].symbol)} ${$(g[0].pnl || 0)} × ${g.length} rows  ids[${g.map((r) => r.id).join(",")}] ${g[0].createdAt.toISOString().slice(0, 16)}`);
    }
  }

  console.log(`Pulled ${rows.length} realized futures rows since 2026-05-18`);
  report("DEMO (NQ/ES/GC/MBT)", (s) => DEMO.has(s));
  report("LIVE (MES/MNQ)", (s) => LIVE.has(s));
  console.log(`\nNOTE: read-only. If inflation factor ≈ 2-3x and clusters are real dupes, the write-side fix is to make`);
  console.log(`fill-reconciliation match by a tolerant key (symbol+qty+pnl±$1 OR orderId) before backfill-creating.`);
  await prisma.$disconnect();
}
main().catch(async (e) => { console.error("Failed:", e instanceof Error ? e.message : e); await prisma.$disconnect().catch(() => {}); process.exit(1); });
