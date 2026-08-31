import { PrismaClient } from "../src/generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
const p = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }) } as never);
async function main() {
  try {
    const rows = await p.$queryRawUnsafe<Record<string, unknown>[]>(
      `SELECT id, symbol, side, leverage, mark_price, shadow_status, shadow_pnl, shadow_reason, shadow_peak, shadow_stop, time
       FROM tradingview_alerts ORDER BY time DESC LIMIT 10`);
    console.log(`tracked alerts: ${rows.length}`);
    for (const r of rows) console.log(`  #${r.id} ${r.symbol} ${r.side} ${r.leverage}x @ ${r.mark_price} · status=${r.shadow_status ?? "open"}${r.shadow_pnl != null ? ` pnl=$${Number(r.shadow_pnl).toFixed(2)} (${r.shadow_reason})` : ""}`);
    const scanLast = await p.agentConfig.findUnique({ where: { key: "margin_scan_last_run" } });
    console.log(`scanner last run: ${scanLast?.value ? `${((Date.now()-new Date(scanLast.value).getTime())/60000).toFixed(0)}m ago` : "never"}`);
  } catch (e) { console.log("shadow table:", String(e).slice(0,80)); }
  await p.$disconnect();
}
main().catch(e=>{console.error(String(e).slice(0,120));process.exit(1);});
