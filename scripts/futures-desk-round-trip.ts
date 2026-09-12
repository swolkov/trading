/**
 * FUTURES DESK ROUND TRIP — proves the desk's broker path on the Tradovate DEMO with one micro.
 *
 * Steps (each printed, each asserted):
 *   1. auth + account + balance           5. the OSO bracket stop is WORKING
 *   2. pick the MES month (expiry-aware)   6. cancel the stop, liquidate, wait flat
 *   3. place 1× market entry WITH stop     7. fills for the exit order → P&L
 *   4. entry fill confirmed by /fill/deps  8. no working orders remain
 * Demo money only. Run: railway run --service futures-engine -- npx tsx scripts/futures-desk-round-trip.ts
 */
import {
  avgFill, cancelDeskOrder, contractExpiry, deskAccount, deskBalance, deskContract, deskOrders, deskPositions, fillsForOrder,
  isWorking, liquidate, orderItem, placeEntryWithStop,
} from "../src/lib/tradovate-desk";
import { cmeOpen, roundToTick, tradePnlUsd } from "../src/lib/futures-desk-rules";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let step = 0;
function ok(cond: unknown, label: string): void { step++; console.log(`${cond ? "✅" : "❌"} ${step}. ${label}`); if (!cond) { console.log("STOP — round trip failed"); process.exit(1); } }

async function main() {
  if (!cmeOpen(new Date())) { console.log("CME is closed right now — run during Globex hours."); process.exit(2); }
  const acct = await deskAccount();
  const bal = await deskBalance();
  ok(acct.accountId > 0 && bal.netLiq > 0, `auth · account ${acct.accountSpec} (#${acct.accountId}) · netLiq $${bal.netLiq.toLocaleString()}`);

  const c = await deskContract("MES");
  ok(c, `MES month: ${c?.name} (#${c?.id}) tick ${c?.tickSize} · expiry ${c ? await contractExpiry(c.id) : "?"}`);
  if (!c) return;

  // Entry price is unknown (no quote); a stop 2% below the last fill is placed after the fill is known.
  // For the OSO we need a stop price up front: use a deliberately far level from the last fill of a
  // tiny probe? No — keep it honest: ask the broker's own position price after the entry. The OSO's
  // provisional stop uses a wide guess (the demo rejects only prices on the wrong side of the market).
  const guess = Number(process.env.PROBE_PRICE || 0);
  if (!guess) { console.log("Set PROBE_PRICE=<approx MES last price> so the provisional stop can be placed 3% below it."); process.exit(2); }
  const stopPx = roundToTick(guess * 0.97, c.tickSize);
  const clOrdId = `fd-rt-${Date.now().toString(36)}`;
  const r = await placeEntryWithStop({ contractId: c.id, action: "Buy", qty: 1, stopPrice: stopPx, clOrdId });
  ok(r.orderId > 0 && !r.failure, `OSO placed: entry #${r.orderId}, bracket stop #${r.stopOrderId ?? "?"} @ ${stopPx}${r.failure ? ` — ${r.failure}` : ""}`);

  let fill = { qty: 0, price: 0 };
  for (let i = 0; i < 10 && fill.qty === 0; i++) { await sleep(1000); fill = avgFill(await fillsForOrder(r.orderId)); }
  ok(fill.qty === 1, `entry filled ${fill.qty}× @ ${fill.price} (order ${(await orderItem(r.orderId))?.ordStatus})`);

  await sleep(1500);
  const orders = await deskOrders();
  const stop = orders.find((o) => o.contractId === c.id && isWorking(o) && o.action === "Sell");
  ok(stop, `protective stop WORKING: #${stop?.id} ${stop?.ordStatus} (oso1Id ${r.stopOrderId ?? "not returned"})`);
  const pos = (await deskPositions()).find((p) => p.contractId === c.id);
  ok(pos && pos.netPos === 1, `broker position: ${pos?.netPos} @ ${pos?.netPrice}`);

  if (stop) await cancelDeskOrder(stop.id);
  await sleep(1000);
  const afterCancel = await orderItem(stop!.id);
  ok(afterCancel && !isWorking(afterCancel), `stop cancelled (${afterCancel?.ordStatus})`);

  const liq = await liquidate(c.id);
  ok(liq.orderId && !liq.failure, `liquidate sent: order #${liq.orderId}${liq.failure ? ` — ${liq.failure}` : ""}`);
  let flat = false;
  for (let i = 0; i < 10 && !flat; i++) { await sleep(1000); flat = !(await deskPositions()).some((p) => p.contractId === c.id); }
  ok(flat, "broker flat");

  const exitFill = avgFill(await fillsForOrder(liq.orderId!));
  ok(exitFill.qty === 1, `exit filled ${exitFill.qty}× @ ${exitFill.price}`);
  const pnl = tradePnlUsd("long", fill.price, exitFill.price, 1, 5);
  console.log(`   round trip P&L (modeled fees): ${pnl >= 0 ? "+" : "−"}$${Math.abs(pnl).toFixed(2)}`);
  const leftover = (await deskOrders()).filter((o) => o.contractId === c.id && isWorking(o));
  ok(leftover.length === 0, `no working orders left on ${c.name}`);
  const bal2 = await deskBalance();
  console.log(`   netLiq after: $${bal2.netLiq.toLocaleString()} (realized today ${bal2.realizedPnl})`);
  console.log(`\nROUND TRIP ${step}/${step} PASSED`);
}
main().catch((e) => { console.error("❌ error:", e); process.exit(1); });
