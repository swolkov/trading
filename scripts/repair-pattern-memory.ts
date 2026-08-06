/**
 * REPAIR PATTERN MEMORY — undo the 0.00R winner corruption (2026-08-06).
 *
 * THE BUG: deferredPnlCheck() computed R as `diff / |entryPrice - meta.stopLoss|`, but stopLoss is
 * MUTATED during the trade — moved to breakeven (= entryPrice) at 0.6R, then ratcheted up the
 * profit-lock. So on a winner |entryPrice - stopLoss| collapsed to 0, the divide-by-zero guard
 * returned 0, and the trade was stored as EXACTLY 0.00R. Losses kept their original stop and
 * recorded correctly. Result: 41/48 winning trend_continuation and 15/17 winning
 * extreme_rsi_bounce vectors carried pnlR = 0, so pattern memory computed NEGATIVE expectancy
 * (-0.25R, -0.32R) for the two setups that are actually the account's only money-makers
 * (+$2,062 and +$7,419 on the broker-reconciled ledger).
 *
 * Fixed at source by Position.entryStopLoss (the original stop, never mutated). This script repairs
 * the vectors already written.
 *
 * REPAIR RULE — deliberately conservative:
 *   Only records where outcome === "win" AND pnlR === 0 are touched. A winning trade cannot be 0R,
 *   so those are provably wrong; nothing else is assumed to be. Each is imputed with the MEDIAN win
 *   R-multiple for that setupType from the RoundTrip ledger, which is broker-fill sourced and
 *   derives its R from the entry log's recorded risk rather than the mutated stop.
 *
 *   Median, not mean — the win distribution has a long right tail and the mean would overstate the
 *   typical trade. This restores the SIGN and MAGNITUDE of expectancy, not per-trade precision:
 *   these vectors can no longer be matched 1:1 to fills, and pretending otherwise would be worse
 *   than admitting the imputation.
 *
 *   Dry-run by default. Pass --go to write. Backs up to pattern_memory_backup_20260806 first.
 */
import { prisma } from "../src/lib/db";

const GO = process.argv.includes("--go");

(async () => {
  const stored = await prisma.agentConfig.findUnique({ where: { key: "pattern_memory" } });
  if (!stored?.value) { console.log("no pattern_memory to repair"); return; }
  const vectors: { setupType?: string; outcome?: string; pnlR?: number }[] = JSON.parse(stored.value);

  // Clean per-setup win R from the broker-reconciled ledger.
  const rt = await prisma.roundTrip.findMany({ where: { rMultiple: { not: null } } });
  const medianWinR: Record<string, number> = {};
  for (const st of [...new Set(vectors.map(v => v.setupType).filter(Boolean))] as string[]) {
    const wins = rt.filter(t => t.setupType === st && t.rMultiple! > 0).map(t => t.rMultiple!).sort((a, b) => a - b);
    if (wins.length) medianWinR[st] = wins[Math.floor(wins.length / 2)];
  }
  // Global fallback for setups with no ledger coverage (never traded live under attribution).
  const allWins = rt.filter(t => t.rMultiple! > 0).map(t => t.rMultiple!).sort((a, b) => a - b);
  const globalMedian = allWins.length ? allWins[Math.floor(allWins.length / 2)] : 0.5;

  let fixed = 0;
  const bySetup: Record<string, { n: number; to: number }> = {};
  for (const v of vectors) {
    if (v.outcome !== "win" || (v.pnlR ?? 0) !== 0) continue;
    const st = v.setupType || "unknown";
    const r = medianWinR[st] ?? globalMedian;
    v.pnlR = r;
    fixed++;
    (bySetup[st] ??= { n: 0, to: r }).n++;
  }

  console.log(`\n  ${vectors.length} vectors · ${fixed} provably-wrong winners (outcome=win, pnlR=0)\n`);
  for (const [st, v] of Object.entries(bySetup))
    console.log(`    ${st.padEnd(22)} ${String(v.n).padStart(3)} records → ${v.to.toFixed(2)}R  ${medianWinR[st] != null ? "(ledger median)" : "(global median — no ledger rows)"}`);

  // Expectancy before/after, per setup
  console.log(`\n  ${"setup".padEnd(22)} expectancy after repair`);
  for (const st of Object.keys(bySetup)) {
    const a = vectors.filter(v => v.setupType === st && v.outcome);
    const exp = a.reduce((s, v) => s + (v.pnlR || 0), 0) / a.length;
    const wr = a.filter(v => v.outcome === "win").length / a.length;
    console.log(`  ${st.padEnd(22)} ${exp >= 0 ? "+" : ""}${exp.toFixed(2)}R   (win ${Math.round(wr * 100)}%, n=${a.length})`);
  }

  if (!GO) { console.log(`\n  DRY RUN — re-run with --go to write.\n`); await prisma.$disconnect(); return; }

  await prisma.agentConfig.upsert({
    where: { key: "pattern_memory_backup_20260806" },
    update: { value: stored.value }, create: { key: "pattern_memory_backup_20260806", value: stored.value },
  });
  await prisma.agentConfig.update({ where: { key: "pattern_memory" }, data: { value: JSON.stringify(vectors) } });
  console.log(`\n  ✅ repaired ${fixed} records (backup: pattern_memory_backup_20260806)\n`);
  await prisma.$disconnect();
})();
