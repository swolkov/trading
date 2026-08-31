import { PrismaClient } from "../src/generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
const p = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }) } as never);
const ago = (v?: string | null) => v ? `${((Date.now() - new Date(v).getTime())/60000).toFixed(0)}m ago` : "NEVER";
async function main() {
  const keys = ["kraken_cron_last_run","margin_watch_last_run","margin_scan_last_run","margin_trades_synced_at","tradingview_last_alert","kraken_margin_auto","kraken_margin_validate_only"];
  const rows = await p.agentConfig.findMany({ where: { key: { in: keys } } });
  const m: Record<string,string> = {}; for (const r of rows) m[r.key] = r.value;
  console.log("HEARTBEATS:");
  console.log(`  Trend bot cron:   ${ago(m.kraken_cron_last_run)}`);
  console.log(`  Margin guardian:  ${ago(m.margin_watch_last_run)}`);
  console.log(`  Scanner:          ${ago(m.margin_scan_last_run)}`);
  console.log(`  Trade sync:       ${ago(m.margin_trades_synced_at)}`);
  console.log(`  TV last alert:    ${ago(m.tradingview_last_alert)}`);
  console.log("SWITCHES:");
  console.log(`  Auto-trade:       ${m.kraken_margin_auto === "true" ? "ARMED" : "OFF (tracked)"}`);
  console.log(`  Validate-only:    ${m.kraken_margin_validate_only !== "false" ? "yes" : "NO (live)"}`);
  try {
    const sc = await p.$queryRawUnsafe<{n:bigint;latest:Date|null}[]>(`SELECT count(*)::bigint n, max(ts) latest FROM margin_scan_signals WHERE ts > now()-interval '2 hours'`);
    console.log(`  Scan signals (2h): ${sc[0].n}, latest ${ago(sc[0].latest?.toISOString())}`);
  } catch { console.log("  scan table: none yet"); }
  try {
    const tv = await p.$queryRawUnsafe<{n:bigint}[]>(`SELECT count(*)::bigint n FROM tradingview_alerts`);
    console.log(`  TV alerts logged: ${tv[0].n}`);
  } catch { console.log("  tv alerts: none yet"); }
  await p.$disconnect();
}
main().catch(e=>{console.error(String(e).slice(0,120));process.exit(1);});
