import { PrismaClient } from "../src/generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
const p = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }) } as never);
const ago = (v?: string|null) => v ? `${((Date.now()-new Date(v).getTime())/60000).toFixed(0)}m ago` : "NEVER";
async function main() {
  const keys = ["kraken_cron_last_run","margin_watch_last_run","margin_scan_last_run","margin_trades_synced_at",
    "kraken_margin_auto","kraken_margin_validate_only","kraken_margin_max_risk_pct",
    "webhook_kraken","webhook_general","webhook_margin_urgent","webhook_margin_signals","webhook_margin_results"];
  const rows = await p.agentConfig.findMany({ where: { key: { in: keys } } });
  const m: Record<string,string> = {}; for (const r of rows) m[r.key] = r.value;
  console.log("=== CRON HEARTBEATS ===");
  console.log(`  trend bot:    ${ago(m.kraken_cron_last_run)}`);
  console.log(`  guardian:     ${ago(m.margin_watch_last_run)}`);
  console.log(`  scanner:      ${ago(m.margin_scan_last_run)}`);
  console.log(`  trade sync:   ${ago(m.margin_trades_synced_at)}`);
  console.log("=== SAFETY SWITCHES ===");
  console.log(`  auto-trade:   ${m.kraken_margin_auto === "true" ? "ARMED" : "OFF (tracked)"}`);
  console.log(`  validate-only:${m.kraken_margin_validate_only !== "false" ? " yes" : " NO(live)"}`);
  console.log(`  risk/trade:   ${m.kraken_margin_max_risk_pct ?? "1.5"}%`);
  console.log("=== SLACK LANES (fallback if dedicated not set) ===");
  console.log(`  webhook_kraken:         ${m.webhook_kraken ? "SET" : "—"}`);
  console.log(`  webhook_general:        ${m.webhook_general ? "SET" : "—"}`);
  console.log(`  webhook_margin_urgent:  ${m.webhook_margin_urgent ? "SET (own channel)" : "not set → falls back to kraken/general"}`);
  console.log(`  webhook_margin_signals: ${m.webhook_margin_signals ? "SET (own channel)" : "not set → falls back to kraken/general"}`);
  console.log(`  webhook_margin_results: ${m.webhook_margin_results ? "SET (own channel)" : "not set → falls back to kraken/general"}`);
  const shadowCols = await p.$queryRawUnsafe<{c:string}[]>(`SELECT column_name c FROM information_schema.columns WHERE table_name='tradingview_alerts' AND column_name IN ('shadow_peak','shadow_stop')`);
  console.log("=== SHADOW MANAGED-EXIT (PR24) ===");
  console.log(`  peak/stop columns: ${shadowCols.length === 2 ? "present (managed exits live)" : "NOT YET (PR24 scan not run)"}`);
  await p.$disconnect();
}
main().catch(e=>{console.error(String(e).slice(0,120));process.exit(1);});
