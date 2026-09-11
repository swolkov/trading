// THE PROP PLUMBING TEST — one tiny real trade on the Tradeify/DXtrade account, end to end:
// open with an attached stop, see the position and its stop on the book, MOVE the stop,
// hold 25s (their 20-second minimum), close at market, confirm flat. Cents of P&L on a $100k
// account. Same discipline as the $0.08 Kraken round trip: nothing is "connected" until the
// broker has filled, protected, modified and closed an order we sent.
//
//   node --env-file=<scratch env> --import tsx scripts/prop-round-trip.ts [SYMBOL] [UNITS]
//
// Refuses to run while the prop desk is ARMED (prop_armed=true) — the guardian would manage
// the test position as a real one.
import {
  dxAccountStatus, dxCancelOrder, dxClosePosition, dxConfigured, dxInstrument, dxLogout, dxMetrics, dxModifyStop,
  dxOpenOrders, dxOpenWithStop, dxOrderHistory, dxPositions, dxAttachStop, DxError,
} from "../src/lib/dxtrade";
import { fmtQty, stopPriceFor } from "../src/lib/prop-rules";

const SYMBOL = process.argv[2] ?? "BTC/USD";
const UNITS = Number(process.argv[3] ?? 0.001);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const log = (s: string) => console.log(`${new Date().toISOString().slice(11, 19)}  ${s}`);
const checks: { name: string; ok: boolean; detail: string }[] = [];
const check = (name: string, ok: boolean, detail = "") => { checks.push({ name, ok, detail }); log(`${ok ? "✅" : "❌"} ${name}${detail ? ` — ${detail}` : ""}`); };

async function krakenLast(coin: string): Promise<number> {
  const r = await fetch(`https://api.kraken.com/0/public/Ticker?pair=${coin}USD`, { signal: AbortSignal.timeout(8000) });
  const j = await r.json() as { result?: Record<string, { c: string[] }> };
  const k = Object.keys(j.result ?? {})[0];
  const px = k ? parseFloat(j.result![k].c[0]) : NaN;
  if (!(px > 0)) throw new Error(`no Kraken price for ${coin}`);
  return px;
}

async function main() {
  if (!dxConfigured()) throw new Error("TRADEIFY_DX_* env not set");
  if (process.env.PROP_ARMED_GUARD === "true") throw new Error("refusing: prop desk armed");
  const coin = SYMBOL.split("/")[0];
  const acct = await dxAccountStatus();
  check("account status FULL_TRADING", acct.accountStatus === "FULL_TRADING", `${acct.account} ${acct.accountStatus} positionBased=${acct.positionBased}`);
  const ins = await dxInstrument(SYMBOL);
  check("instrument listed", !!ins, ins ? `tick ${ins.priceIncrement} lot ${ins.lotSize}` : "missing");
  const before = await dxMetrics();
  check("metrics readable", before.equity > 0, `equity $${before.equity} balance $${before.balance} open ${before.openPositionsCount}`);
  const pre = await dxPositions();
  check("no position on the symbol before", !pre.positions.some((p) => p.symbol === SYMBOL), `${pre.positions.length} open`);

  const px = await krakenLast(coin);
  const stop = stopPriceFor(px, 0.04, ins?.priceIncrement ?? 0.01);
  log(`Kraken ${coin} last ${px} → stop ${stop} (−4%) · units ${UNITS} ≈ $${(UNITS * px).toFixed(2)}`);

  // 1. OPEN with the stop in the same request
  let parentId: number | null = null;
  let opened;
  try {
    opened = await dxOpenWithStop({ symbol: SYMBOL, side: "BUY", quantity: fmtQty(UNITS, 0.001), stopPrice: stop, codePrefix: "rt", metadata: { desk: "prop-round-trip" } });
    parentId = opened.parent.orderId;
    check("open+stop accepted (IF-THEN)", true, `parent ${opened.parent.orderId} stop ${opened.stop?.orderId ?? "?"}`);
  } catch (e) {
    check("open+stop accepted (IF-THEN)", false, e instanceof DxError ? `${e.status} ${e.code} ${e.message} ${e.body?.slice(0, 200)}` : String(e));
    throw e;
  }
  const openedAt = Date.now();
  await sleep(3000);

  // 2. the position and its protection
  const { positions } = await dxPositions();
  const pos = positions.find((p) => p.symbol === SYMBOL);
  check("position on the book", !!pos, pos ? `code ${pos.positionCode} qty ${pos.quantity} @ ${pos.openPrice} SL ${pos.stopLossPrice ?? "none"}` : "not found");
  check("positionCode == parent orderId", !!pos && String(pos.positionCode) === String(parentId), `${pos?.positionCode} vs ${parentId}`);
  check("stop attached to the position", !!pos?.stopLossPrice && Math.abs((pos.stopLossPrice ?? 0) - stop) < (ins?.priceIncrement ?? 0.01) * 2, `SL ${pos?.stopLossPrice}`);
  const { orders, etag } = await dxOpenOrders();
  const stopOrder = orders.find((o) => o.type === "STOP" && o.instrument === SYMBOL);
  check("stop order visible in open orders", !!stopOrder, stopOrder ? `code ${stopOrder.orderCode} status ${stopOrder.status} legs ${JSON.stringify(stopOrder.legs ?? []).slice(0, 200)} etag ${etag}` : `orders: ${JSON.stringify(orders).slice(0, 300)}`);

  // 3. MOVE the stop up (the guardian's trail) — PUT with If-Match, fall back to attach+cancel
  const newStop = stopPriceFor(px, 0.035, ins?.priceIncrement ?? 0.01);
  let moved = false, how = "";
  if (stopOrder) {
    try { await dxModifyStop(stopOrder, newStop, etag); moved = true; how = "PUT If-Match"; }
    catch (e) { how = `PUT failed: ${e instanceof DxError ? `${e.status} ${e.code} ${e.body?.slice(0, 160)}` : String(e)}`; }
  }
  if (!moved && pos) {
    try {
      await dxAttachStop({ symbol: SYMBOL, positionCode: pos.positionCode, positionSide: "BUY", stopPrice: newStop, codePrefix: "rt", metadata: { desk: "prop-round-trip" } });
      const again = await dxOpenOrders();
      const old = again.orders.find((o) => o.orderCode === stopOrder?.orderCode);
      if (old) await dxCancelOrder(old.orderCode, again.etag);
      moved = true; how += " → attach new + cancel old";
    } catch (e) { how += ` · attach/cancel failed: ${e instanceof DxError ? `${e.status} ${e.code} ${e.body?.slice(0, 160)}` : String(e)}`; }
  }
  await sleep(2000);
  const after = await dxPositions();
  const pos2 = after.positions.find((p) => p.symbol === SYMBOL);
  check("stop moved", moved && !!pos2?.stopLossPrice && Math.abs((pos2.stopLossPrice ?? 0) - newStop) < (ins?.priceIncrement ?? 0.01) * 2, `${how} · SL now ${pos2?.stopLossPrice}`);
  const ords2 = await dxOpenOrders();
  check("exactly one stop resting", ords2.orders.filter((o) => o.type === "STOP" && o.instrument === SYMBOL).length === 1, `${ords2.orders.length} open orders`);

  // 4. hold past the 20-second microscalping rule, then CLOSE at market
  const wait = Math.max(0, 25_000 - (Date.now() - openedAt));
  log(`holding ${Math.round(wait / 1000)}s for the 20s rule`);
  await sleep(wait);
  if (pos) {
    try {
      const c = await dxClosePosition({ symbol: SYMBOL, positionCode: pos.positionCode, positionSide: "BUY", codePrefix: "rt", metadata: { desk: "prop-round-trip" } });
      check("close accepted", true, `order ${c.resp.orderId}`);
    } catch (e) { check("close accepted", false, e instanceof DxError ? `${e.status} ${e.code} ${e.body?.slice(0, 200)}` : String(e)); }
  }
  await sleep(3000);
  const flat = await dxPositions();
  check("flat after close", !flat.positions.some((p) => p.symbol === SYMBOL), `${flat.positions.length} open`);
  const ords3 = await dxOpenOrders();
  check("stop cancelled with the position", !ords3.orders.some((o) => o.instrument === SYMBOL), `${ords3.orders.length} open orders`);
  const m2 = await dxMetrics();
  check("balance delta is cents", Math.abs(m2.balance - before.balance) < 5, `$${before.balance} → $${m2.balance} (Δ ${(m2.balance - before.balance).toFixed(2)})`);
  try {
    const hist = await dxOrderHistory(new Date(openedAt - 60_000).toISOString(), 20);
    check("order history readable", hist.length >= 1, `${hist.length} orders · first: ${JSON.stringify(hist[0] ?? {}).slice(0, 300)}`);
  } catch (e) { check("order history readable", false, e instanceof DxError ? `${e.status} ${e.code} ${e.body?.slice(0, 160)}` : String(e)); }

  await dxLogout();
  const passed = checks.filter((c) => c.ok).length;
  console.log(`\nROUND TRIP ${passed}/${checks.length} checks passed`);
  if (passed !== checks.length) process.exitCode = 1;
}
main().catch(async (e) => { console.error("FAILED:", e); await dxLogout(); process.exitCode = 1; });
