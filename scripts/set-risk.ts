import { PrismaClient } from "../src/generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
const p = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }) } as never);
async function main() {
  await p.agentConfig.upsert({ where: { key: "kraken_margin_max_risk_pct" }, update: { value: "3" }, create: { key: "kraken_margin_max_risk_pct", value: "3" } });
  const row = await p.agentConfig.findUnique({ where: { key: "kraken_margin_max_risk_pct" } });
  const auto = await p.agentConfig.findUnique({ where: { key: "kraken_margin_auto" } });
  const val = await p.agentConfig.findUnique({ where: { key: "kraken_margin_validate_only" } });
  console.log(`max_risk_pct = ${row?.value}%`);
  console.log(`auto-trade = ${auto?.value === "true" ? "ARMED" : "OFF (tracked)"} · validate-only = ${val?.value !== "false" ? "yes" : "NO"}`);
  await p.$disconnect();
}
main().catch(e => { console.error(String(e).slice(0,120)); process.exit(1); });
