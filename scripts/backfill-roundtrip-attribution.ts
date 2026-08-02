/**
 * Backfill setupType + rMultiple on RoundTrip rows banked before attribution existed.
 *
 * The clean ledger promised these fields and never got them, so historical P&L could not be split
 * by edge. Idempotent and conservative — only fills blanks, never overwrites, and skips any row it
 * cannot match confidently.
 *
 *   npx tsx scripts/backfill-roundtrip-attribution.ts          # dry run
 *   npx tsx scripts/backfill-roundtrip-attribution.ts --write  # apply
 */
import { prisma } from "../src/lib/db";
import { attributeRoundTrip } from "../src/lib/roundtrip-attribution";

const WRITE = process.argv.includes("--write");

(async () => {
  const rows = await prisma.roundTrip.findMany({ orderBy: { id: "asc" } });
  const todo = rows.filter(r => !r.setupType || r.rMultiple == null);
  console.log(`\n  ${rows.length} round-trips, ${todo.length} missing attribution${WRITE ? "" : "  (DRY RUN — pass --write to apply)"}\n`);

  let matched = 0, unmatched = 0;
  const bySetup: Record<string, { n: number; net: number; r: number[] }> = {};

  for (const r of todo) {
    const a = await attributeRoundTrip({
      mode: r.mode, symbol: r.symbol, direction: r.direction, contracts: r.contracts,
      entryPrice: r.entryPrice, entryTime: r.entryTime, pnl: r.pnl,
    });
    if (!a.setupType && a.rMultiple == null) { unmatched++; continue; }
    matched++;
    const k = a.setupType ?? "unknown";
    (bySetup[k] ??= { n: 0, net: 0, r: [] });
    bySetup[k].n++; bySetup[k].net += r.pnl;
    if (a.rMultiple != null) bySetup[k].r.push(a.rMultiple);

    if (WRITE) {
      await prisma.roundTrip.update({
        where: { id: r.id },
        data: {
          ...(a.setupType && !r.setupType ? { setupType: a.setupType } : {}),
          ...(a.rMultiple != null && r.rMultiple == null ? { rMultiple: a.rMultiple } : {}),
        },
      });
    }
  }

  console.log(`  matched ${matched}   unmatched ${unmatched}\n`);
  console.log(`  ── P&L BY EDGE (what this unlocks) ──`);
  for (const [k, v] of Object.entries(bySetup).sort((a, b) => b[1].net - a[1].net)) {
    const avgR = v.r.length ? v.r.reduce((a, b) => a + b, 0) / v.r.length : null;
    console.log(`    ${k.padEnd(22)} n=${String(v.n).padStart(3)}  net $${v.net.toFixed(2).padStart(9)}  avgR ${avgR != null ? avgR.toFixed(2) : "  —"}`);
  }
  if (!WRITE) console.log(`\n  (nothing written — re-run with --write)`);
  await prisma.$disconnect();
})();
