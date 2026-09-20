import assert from "node:assert/strict";
import test from "node:test";
import { ledgerByDay, ledgerTrades, type LedgerRow } from "../src/lib/trading-room-ledger-rules";

const row = (id: number, tradeDate: string, type: string, delta: number): LedgerRow => ({ id, ts: `${tradeDate}T14:00:00.000Z`, tradeDate, type, delta, realizedPnl: null, fillId: null, fillPairId: null });

test("ledger by day: paired trades are gross, four fee types are fees, the rest is other, running net accumulates", () => {
  const days = ledgerByDay([
    row(1, "2026-09-18", "TradePaired", 100), row(2, "2026-09-18", "TradePaired", -40), row(3, "2026-09-18", "Commission", -3), row(4, "2026-09-18", "ExchangeFee", -4),
    row(5, "2026-09-18", "NfaFee", -0.1), row(6, "2026-09-18", "ClearingFee", -1), row(7, "2026-09-18", "NewSession", 0),
    row(8, "2026-09-19", "LiquidationFee", -50), row(9, "2026-09-19", "TradePaired", 20),
    row(10, "2026-09-20", "NewSession", 0),   // a session marker alone is not a trading day
  ]);
  assert.equal(days.length, 2);
  const [a, b] = days;
  assert.deepEqual([a.day, a.trades, a.wins, a.losses, a.grossUsd, a.winUsd, a.lossUsd, a.feesUsd, a.otherUsd, a.bestUsd, a.worstUsd], ["2026-09-18", 2, 1, 1, 60, 100, -40, -8.1, 0, 100, -40]);
  assert.ok(Math.abs(a.netUsd - 51.9) < 1e-9);
  assert.deepEqual([b.trades, b.grossUsd, b.otherUsd, b.netUsd], [1, 20, -50, -30]);
  assert.ok(Math.abs(b.cumNetUsd - 21.9) < 1e-9);
  assert.deepEqual(ledgerByDay([]), []);
});

test("every trade: paired rows within 90s of each other are one trade, with a running gross", () => {
  const t = (id: number, iso: string, delta: number, type = "TradePaired"): LedgerRow => ({ id, ts: iso, tradeDate: "2026-09-18", type, delta, realizedPnl: null, fillId: null, fillPairId: null });
  const trades = ledgerTrades([
    t(1, "2026-09-18T18:54:39.000Z", 506.25), t(2, "2026-09-18T18:54:39.100Z", 56.25), t(3, "2026-09-18T18:54:39.200Z", 562.5),
    t(4, "2026-09-18T19:07:21.000Z", -125), t(5, "2026-09-18T19:07:21.000Z", -3, "Commission"),
    t(6, "2026-09-18T19:49:07.000Z", -275), t(7, "2026-09-18T19:50:03.000Z", -275),
  ]);
  assert.deepEqual(trades.map((x) => [x.pairs, x.grossUsd, x.runningGrossUsd, x.bestPairUsd, x.worstPairUsd]), [[3, 1125, 1125, 562.5, 56.25], [1, -125, 1000, -125, -125], [2, -550, 450, -275, -275]]);
  assert.equal(trades[0].id, 1);
});
