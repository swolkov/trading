/**
 * VERIFY TRADOVATE BALANCES (READ-ONLY) — confirm the admin view pulls the CORRECT, separate
 * live vs demo numbers from Tradovate (not crossed, not contaminated).
 * Run: railway run npx tsx scripts/verify-tradovate-balances.ts
 */
import { prisma } from "../src/lib/db";
import { getTradovateAccountSummary, checkTradovateAuth } from "../src/lib/tradovate";

const $ = (x: number | null | undefined) => x == null ? "n/a" : (x >= 0 ? "+$" : "-$") + Math.abs(x).toFixed(0);

async function latestBalance(prefix: string) {
  const rows = await prisma.agentConfig.findMany({ where: { key: { startsWith: prefix } }, orderBy: { key: "asc" } });
  const parsed = rows.map((r) => ({ date: r.key.slice(prefix.length), bal: parseFloat(r.value) })).filter((x) => !isNaN(x.bal));
  parsed.sort((a, b) => a.date.localeCompare(b.date));
  return { last: parsed[parsed.length - 1], prev: parsed[parsed.length - 2], count: parsed.length };
}

async function dbSum(symbols: string[]) {
  const logs = await prisma.autoTradeLog.findMany({ where: { symbol: { in: symbols }, pnl: { not: null }, createdAt: { gte: new Date("2026-05-18") } }, select: { pnl: true } });
  return logs.reduce((s, l) => s + (l.pnl || 0), 0);
}

async function side(label: string, mode: "paper" | "live", cachePrefix: string, demoSyms: string[]) {
  console.log(`\n══ ${label} (mode="${mode}") ══`);
  let auth: any = null, summary: any = null;
  try { auth = await checkTradovateAuth(mode); } catch (e) { console.log(`  auth error: ${e instanceof Error ? e.message : e}`); }
  if (auth) console.log(`  Tradovate account: ${auth.accountName} (id ${auth.accountId})  authenticated=${auth.authenticated}`);
  if (auth?.authenticated) { try { summary = await getTradovateAccountSummary(mode); } catch (e) { console.log(`  summary error: ${e instanceof Error ? e.message : e}`); } }
  console.log(`  Broker balance (LIVE query): ${summary ? "$" + summary.balance.toFixed(0) : "unavailable → falls back to cache"}`);
  const cache = await latestBalance(cachePrefix);
  console.log(`  Cache (${cachePrefix}*): latest ${cache.last ? `${cache.last.date} = $${cache.last.bal.toFixed(0)}` : "none"}  (${cache.count} days)`);
  console.log(`  DB trade-sum P&L (${demoSyms.map((s) => s.replace("FUT:", "")).join("/")}): ${$(await dbSum(demoSyms))}`);
  return { account: auth?.accountName, balance: summary?.balance ?? cache.last?.bal ?? null };
}

async function main() {
  console.log("VERIFYING admin-view Tradovate numbers are correctly separated (read-only)\n");
  const demo = await side("DEMO FUTURES", "paper", "daily_balance_", ["FUT:ES", "FUT:NQ", "FUT:GC", "FUT:MBT"]);
  const live = await side("LIVE FUTURES", "live", "live_daily_balance_", ["FUT:MES", "FUT:MNQ"]);

  console.log("\n── CROSS-CHECK ──");
  if (demo.account && live.account && demo.account === live.account)
    console.log(`  🚨 CROSSED: demo and live resolve to the SAME Tradovate account (${demo.account}) — numbers are NOT separated!`);
  else
    console.log(`  ✓ Separate accounts: demo=${demo.account ?? "?"}  live=${live.account ?? "?"}`);
  if (demo.balance != null && live.balance != null) {
    if (demo.balance < 5000 && live.balance > 5000) console.log(`  🚨 SWAPPED? demo balance $${demo.balance.toFixed(0)} < live $${live.balance.toFixed(0)} — looks reversed (demo should be ~$50k, live ~$1k)`);
    else console.log(`  ✓ Magnitudes sane: demo $${demo.balance.toFixed(0)} (expect ~$50-70k), live $${live.balance.toFixed(0)} (expect ~$0.9-1k)`);
  }
  await prisma.$disconnect();
}
main().catch(async (e) => { console.error("Failed:", e instanceof Error ? e.message : e); await prisma.$disconnect().catch(() => {}); process.exit(1); });
