/** One-shot repair (2026-08-11): re-run attribution over every RoundTrip with the FIXED matcher
 *  (exact symbol + mode-exact action — no more ES↔MES collisions). Only updates rows where the new
 *  attribution RESOLVES; never blanks an existing value with a null. Prints every change. */
import { prisma } from "../src/lib/db";
import { attributeRoundTrip } from "../src/lib/roundtrip-attribution";
(async () => {
  const rows = await prisma.roundTrip.findMany({ orderBy: { id: "asc" } });
  let changed = 0;
  for (const t of rows) {
    if (!t.entryTime || !t.entryPrice) continue;
    const a = await attributeRoundTrip({ mode: t.mode, symbol: t.symbol, direction: t.direction,
      contracts: t.contracts ?? 1, entryPrice: t.entryPrice, entryTime: t.entryTime, pnl: t.pnl });
    const upd: Record<string, unknown> = {};
    if (a.setupType && a.setupType !== t.setupType) upd.setupType = a.setupType;
    if (a.rMultiple != null && Math.abs((t.rMultiple ?? 999) - a.rMultiple) > 0.005) upd.rMultiple = a.rMultiple;
    if (Object.keys(upd).length) {
      await prisma.roundTrip.update({ where: { id: t.id }, data: upd });
      changed++;
      console.log(`  #${t.id} ${t.mode} ${t.symbol} ${t.direction}  ${t.rMultiple?.toFixed(2) ?? "—"}R→${a.rMultiple?.toFixed(2) ?? "keep"}R  ${t.setupType ?? "—"}→${a.setupType ?? "keep"}`);
    }
  }
  console.log(`\n  ${changed} of ${rows.length} rows corrected`);
  await prisma.$disconnect();
})();
