import assert from "node:assert/strict";
import test from "node:test";
import { ledgerByDay, type LedgerRow } from "../src/lib/trading-room-ledger-rules";

const row = (id: number, tradeDate: string, type: string, delta: number): LedgerRow => ({ id, ts: `${tradeDate}T14:00:00.000Z`, tradeDate, type, delta, realizedPnl: null, fillId: null, fillPairId: null });

test("ledger by day: paired trades are gross, four fee types are fees, the rest is other, running net accumulates", () => {
  const days = ledgerByDay([
    row(1, "2026-09-18", "TradePaired", 100), row(2, "2026-09-18", "TradePaired", -40), row(3, "2026-09-18", "Commission", -3), row(4, "2026-09-18", "ExchangeFee", -4),
    row(5, "2026-09-18", "NfaFee", -0.1), row(6, "2026-09-18", "ClearingFee", -1), row(7, "2026-09-18", "NewSession", 0),
    row(8, "2026-09-19", "LiquidationFee", -50), row(9, "2026-09-19", "TradePaired", 20),
  ]);
  assert.equal(days.length, 2);
  const [a, b] = days;
  assert.deepEqual([a.day, a.trades, a.wins, a.losses, a.grossUsd, a.feesUsd, a.otherUsd, a.bestUsd, a.worstUsd], ["2026-09-18", 2, 1, 1, 60, -8.1, 0, 100, -40]);
  assert.ok(Math.abs(a.netUsd - 51.9) < 1e-9);
  assert.deepEqual([b.trades, b.grossUsd, b.otherUsd, b.netUsd], [1, 20, -50, -30]);
  assert.ok(Math.abs(b.cumNetUsd - 21.9) < 1e-9);
  assert.deepEqual(ledgerByDay([]), []);
});
