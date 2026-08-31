import { PrismaClient } from "../src/generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }) } as never);
async function main() {
  const rows = await prisma.$queryRawUnsafe<Record<string, unknown>[]>(
    `SELECT txid, ordertxid, pair, time, type, ordertype, price, cost, fee, vol, margin, posstatus, net, misc
     FROM kraken_my_trades WHERE pair LIKE '%BTNL%' ORDER BY time DESC LIMIT 8`,
  );
  for (const r of rows) console.log(JSON.stringify(r));
  console.log("--- ledger margin rows (latest 8):");
  const led = await prisma.$queryRawUnsafe<Record<string, unknown>[]>(
    `SELECT id, refid, time, ltype, asset, amount, fee FROM kraken_my_ledger WHERE ltype='margin' ORDER BY time DESC LIMIT 8`,
  );
  for (const r of led) console.log(JSON.stringify(r));
  console.log("--- totals by ltype/asset:");
  const t = await prisma.$queryRawUnsafe<Record<string, unknown>[]>(
    `SELECT ltype, asset, count(*)::int AS n, sum(amount)::float AS amt, sum(fee)::float AS fees FROM kraken_my_ledger GROUP BY 1,2 ORDER BY 1,2`,
  );
  for (const r of t) console.log(JSON.stringify(r));
  await prisma.$disconnect();
}
main().catch((e) => { console.error("FAIL:", e?.message ?? e); process.exit(1); });
