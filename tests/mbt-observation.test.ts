import assert from "node:assert/strict";
import test from "node:test";
import { mbtNr4Daily } from "../src/lib/strategies/mbt-nr4-daily";
import { runStrategy } from "../src/lib/strategy-runner";

test("corrected MBT research evidence is observation-only", () => {
  assert.equal(mbtNr4Daily.executionEligibility, "observation");
  assert.equal(mbtNr4Daily.backtest?.trades, 216);
  assert.equal(mbtNr4Daily.backtest?.pf, 1.23);
  assert.equal(mbtNr4Daily.backtest?.tStat, 1.13);
  assert.deepEqual(mbtNr4Daily.backtest?.pfCi95, [0.85, 1.78]);
});

test("observation-only MBT cannot emit an executable dispatcher signal", async () => {
  const signal = await runStrategy(
    mbtNr4Daily,
    { t: Date.now(), o: 80_000, h: 81_000, l: 79_000, c: 80_500, v: 1 },
    "MBT",
    Date.now(),
  );
  assert.equal(signal, null);
});
