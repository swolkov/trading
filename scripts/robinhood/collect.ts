import { createHash } from "node:crypto";
import { RobinhoodReadClient, withCredentialLock } from "./client";
import { prisma } from "../../src/lib/db";
import { collectRobinhoodAccount, inspectRobinhoodCapabilities, OPTIONS_DIRECT_STATUS_KEY } from "../../src/lib/options-direct-collector";

async function run() {
  return withCredentialLock(async () => {
    const client = new RobinhoodReadClient();
    await client.connect();
    const catalog = await client.listTools();
    const capabilities = {...inspectRobinhoodCapabilities(catalog), schemaHash: createHash("sha256").update(JSON.stringify(catalog)).digest("hex")};
    const snapshot = await collectRobinhoodAccount(client);
    const status = {at: snapshot.account.at, ok: true, capabilities};
    // All snapshots and status advance together, only after every broker page succeeds.
    await prisma.$transaction([
      ...Object.entries({options_account_snapshot: snapshot.account, options_live_snapshot: snapshot.live, [OPTIONS_DIRECT_STATUS_KEY]: status}).map(([key, payload]) => {
        const value = JSON.stringify(payload);
        return prisma.agentConfig.upsert({where: {key}, create: {key, value}, update: {value}});
      }),
    ]);
    console.log(JSON.stringify({at: status.at, account: "••••8705", accountValue: snapshot.account.totalValue, buyingPower: snapshot.account.buyingPower,
      optionLevel: snapshot.account.optionLevel, positions: snapshot.live.positions.length, orders: snapshot.live.orders.length, capabilities, canPlaceOrders: false}));
  });
}
run().catch(async () => {
  // Do not log broker responses, account details or credentials from thrown errors.
  console.error("Direct Robinhood collection failed; prior account snapshots retained.");
  const value = JSON.stringify({at: new Date().toISOString(), ok: false, error: "Direct collection failed; inspect connection or response schema"});
  await prisma.agentConfig.upsert({where: {key: OPTIONS_DIRECT_STATUS_KEY}, create: {key: OPTIONS_DIRECT_STATUS_KEY, value}, update: {value}}).catch(() => {});
  process.exitCode = 1;
}).finally(() => prisma.$disconnect());
