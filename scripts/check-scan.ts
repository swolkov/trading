import { PrismaClient } from "../src/generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
const p = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }) } as never);
async function main() {
  const hb = await p.agentConfig.findUnique({ where: { key: "margin_scan_last_run" } });
  console.log("margin_scan_last_run:", hb?.value ?? "NEVER (cron hasn't fired since deploy)");
  try {
    const rows = await p.$queryRawUnsafe<{ n: bigint; latest: Date | null }[]>(
      `SELECT count(*)::bigint AS n, max(ts) AS latest FROM margin_scan_signals`);
    console.log(`scan signals logged: ${rows[0].n}, latest: ${rows[0].latest?.toISOString() ?? "none"}`);
    const recent = await p.$queryRawUnsafe<{ coin: string; timeframe: string; detail: string }[]>(
      `SELECT coin, timeframe, detail FROM margin_scan_signals ORDER BY ts DESC LIMIT 8`);
    for (const r of recent) console.log(`  ${r.coin} ${r.timeframe}: ${r.detail}`);
  } catch (e) { console.log("no scan table yet:", String(e).slice(0, 60)); }
  await p.$disconnect();
}
main().catch(e => { console.error(String(e).slice(0,100)); process.exit(1); });
