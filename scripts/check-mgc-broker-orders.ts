#!/usr/bin/env tsx
// @ts-nocheck
const LIVE = "https://live.tradovateapi.com/v1";

async function main() {
  const authRes = await fetch(`${LIVE}/auth/accesstokenrequest`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: process.env.TRADOVATE_USERNAME,
      password: process.env.TRADOVATE_PASSWORD,
      appId: process.env.TRADOVATE_APP_ID,
      appVersion: process.env.TRADOVATE_APP_VERSION || "1.0",
      deviceId: "esbueno-diag",
      cid: parseInt(process.env.TRADOVATE_CID || "0"),
      sec: process.env.TRADOVATE_SEC,
    }),
  });
  const auth = await authRes.json();
  if (!auth.accessToken) { console.log("AUTH FAIL:", JSON.stringify(auth).slice(0, 200)); return; }
  const h = { Authorization: `Bearer ${auth.accessToken}` };

  const orders = await (await fetch(`${LIVE}/order/list`, { headers: h })).json();
  const working = (Array.isArray(orders) ? orders : []).filter((o) => o.ordStatus === "Working" || o.ordStatus === "Accepted");
  console.log(`=== LIVE WORKING ORDERS (${working.length}) ===`);
  for (const o of working) {
    let stopPrice, limitPrice;
    try {
      const vers = await (await fetch(`${LIVE}/orderVersion/deps?masterid=${o.id}`, { headers: h })).json();
      const v = Array.isArray(vers) ? vers[vers.length - 1] : null;
      stopPrice = v?.stopPrice; limitPrice = v?.price;
    } catch {}
    console.log(JSON.stringify({ id: o.id, action: o.action, type: o.orderType, status: o.ordStatus, qty: o.orderQty, contractId: o.contractId, stopPrice, limitPrice }));
  }

  const positions = await (await fetch(`${LIVE}/position/list`, { headers: h })).json();
  console.log("\n=== LIVE BROKER POSITIONS (net != 0) ===");
  for (const p of (Array.isArray(positions) ? positions : []).filter((p) => p.netPos !== 0)) {
    console.log(JSON.stringify({ contractId: p.contractId, netPos: p.netPos, netPrice: p.netPrice }));
  }
}
main().catch(e => console.error("ERR:", e.message || e)).finally(() => process.exit(0));
