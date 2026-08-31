// Post-deploy check: are the margin tables populated yet, and what's in them?
import { PrismaClient } from "../src/generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }) } as never);
async function main() {
  const tables = await prisma.$queryRawUnsafe<{ table_name: string }[]>(
    `SELECT table_name FROM information_schema.tables WHERE table_name IN ('kraken_my_trades','kraken_my_ledger','tradingview_alerts')`,
  );
  console.log("tables:", tables.map((t) => t.table_name).join(", ") || "NONE YET");
  if (tables.some((t) => t.table_name === "kraken_my_trades")) {
    const [c] = await prisma.$queryRawUnsafe<{ n: bigint; margin: bigint; pairs: string | null; first: Date | null; last: Date | null }[]>(
      `SELECT count(*)::bigint AS n,
              count(*) FILTER (WHERE margin > 0 OR COALESCE(posstatus,'') <> '')::bigint AS margin,
              string_agg(DISTINCT pair, ',') AS pairs,
              min(time) AS first, max(time) AS last
       FROM kraken_my_trades`,
    );
    console.log(`fills: ${c.n} total, ${c.margin} margin-book · pairs: ${c.pairs} · ${c.first?.toISOString().slice(0,10)} → ${c.last?.toISOString().slice(0,10)}`);
    const [l] = await prisma.$queryRawUnsafe<{ roll: bigint; marg: bigint }[]>(
      `SELECT count(*) FILTER (WHERE ltype='rollover')::bigint AS roll, count(*) FILTER (WHERE ltype='margin')::bigint AS marg FROM kraken_my_ledger`,
    );
    console.log(`ledger: ${l.roll} rollover rows, ${l.marg} margin rows`);
  }
  const hb = await prisma.agentConfig.findMany({ where: { key: { in: ["margin_watch_last_run", "margin_trades_synced_at", "kraken_cron_last_run"] } } });
  for (const r of hb) console.log(`${r.key}: ${r.value}`);
  await prisma.$disconnect();
}
main().catch((e) => { console.error("FAIL:", e?.message ?? e); process.exit(1); });
