import { PrismaClient } from "../src/generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
const p = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }) } as never);
async function main() {
  const base = await p.$queryRawUnsafe<{id:number;symbol:string;side:string;time:Date}[]>(`SELECT id, symbol, side, time FROM tradingview_alerts ORDER BY time DESC LIMIT 5`);
  console.log(`tradingview_alerts rows: ${base.length}`);
  for (const r of base) console.log(`  #${r.id} ${r.symbol} ${r.side} @ ${r.time.toISOString()}`);
  const cols = await p.$queryRawUnsafe<{column_name:string}[]>(`SELECT column_name FROM information_schema.columns WHERE table_name='tradingview_alerts' AND column_name LIKE 'shadow%'`);
  console.log(`shadow columns present: ${cols.map(c=>c.column_name).join(", ") || "NONE (scan cron hasn't added them yet)"}`);
  const scan = await p.agentConfig.findUnique({ where: { key: "margin_scan_last_run" } });
  console.log(`scanner last run: ${scan?.value ? `${((Date.now()-new Date(scan.value).getTime())/60000).toFixed(1)}m ago` : "never"}`);
  await p.$disconnect();
}
main().catch(e=>{console.error(String(e).slice(0,120));process.exit(1);});
