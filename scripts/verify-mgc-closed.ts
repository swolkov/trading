#!/usr/bin/env tsx
// @ts-nocheck
import { PrismaClient } from "../src/generated/prisma/client.js";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";
const pool = new Pool({ connectionString: process.env.DATABASE_URL! });
const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });
const LIVE = "https://live.tradovateapi.com/v1";

async function main() {
  const authRes = await fetch(`${LIVE}/auth/accesstokenrequest`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: process.env.TRADOVATE_USERNAME, password: process.env.TRADOVATE_PASSWORD,
      appId: process.env.TRADOVATE_APP_ID, appVersion: process.env.TRADOVATE_APP_VERSION || "1.0",
      deviceId: "esbueno-diag", cid: parseInt(process.env.TRADOVATE_CID || "0"), sec: process.env.TRADOVATE_SEC,
    }),
  });
  const auth = await authRes.json();
  const h = { Authorization: `Bearer ${auth.accessToken}` };

  // 1. Broker positions
  const positions = await (await fetch(`${LIVE}/position/list`, { headers: h })).json();
  const open = (Array.isArray(positions) ? positions : []).filter(p => p.netPos !== 0);
  console.log("=== BROKER POSITIONS (net != 0) ===");
  console.log(open.length === 0 ? "  ✅ FLAT — no open positions" : JSON.stringify(open));

  // 2. Broker working orders
  const orders = await (await fetch(`${LIVE}/order/list`, { headers: h })).json();
  const working = (Array.isArray(orders) ? orders : []).filter(o => o.ordStatus === "Working" || o.ordStatus === "Accepted");
  console.log("\n=== BROKER WORKING ORDERS ===");
  console.log(working.length === 0 ? "  ✅ NONE — no resting/orphaned orders" : JSON.stringify(working.map(o => ({ id: o.id, type: o.orderType, status: o.ordStatus }))));

  // 3. Cash / margin
  const accts = await (await fetch(`${LIVE}/account/list`, { headers: h })).json();
  const cash = await (await fetch(`${LIVE}/cashBalance/getcashbalancesnapshot`, {
    method: "POST", headers: { ...h, "Content-Type": "application/json" },
    body: JSON.stringify({ accountId: accts[0].id }),
  })).json();
  console.log("\n=== CASH / MARGIN ===");
  console.log(`  netLiq=$${cash.netLiq}  cash=$${cash.totalCashValue}  initMargin=$${cash.initialMargin}  maintMargin=$${cash.maintenanceMargin}  openPnL=$${cash.openPnL}`);

  // 4. Engine persisted state
  const pos = await prisma.agentConfig.findUnique({ where: { key: "futures_positions_live" } });
  console.log("\n=== ENGINE PERSISTED STATE (futures_positions_live) ===");
  if (!pos?.value || pos.value === "{}") {
    console.log("  ✅ EMPTY — engine holds no positions");
  } else {
    const parsed = JSON.parse(pos.value);
    const keys = Object.keys(parsed);
    console.log(keys.length === 0 ? "  ✅ EMPTY" : `  ⚠️ STILL HAS: ${keys.join(", ")} (engine thinks it holds these)`);
  }

  // 5. Recent trade log (close + any rejects logged)
  const trades = await prisma.autoTradeLog.findMany({ where: { symbol: "FUT:MGC" }, orderBy: { createdAt: "desc" }, take: 6 });
  console.log("\n=== RECENT FUT:MGC LOG ===");
  const now = Date.now();
  for (const t of trades) {
    const ago = Math.round((now - new Date(t.createdAt).getTime()) / 60000);
    console.log(`  ${ago}m ago | ${t.action} | ${t.qty}@${t.price} | ${String(t.reason).slice(0, 90)}`);
  }
}
main().catch(e => console.error("ERR:", e.message || e)).finally(() => process.exit(0));
