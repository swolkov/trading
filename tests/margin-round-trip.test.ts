import assert from "node:assert/strict";
import test from "node:test";
import { evaluateOpenChecks, evaluateCloseChecks, roundTripVerdict, validatePassOk, RT_CHECKS } from "../src/lib/margin-round-trip";
import { MARGIN_USERREF } from "../src/lib/margin-executor";

const order = (txid: string, extra: Record<string, unknown> = {}) => ({ txid, userref: MARGIN_USERREF, opentm: 1002, pair: "XBTUSD", vol: 0.0002, volExec: 0, ordertype: "stop-loss", side: "sell", price: 100000, ...extra });
const base = { entryTxid: "OENTRY", pair: "XBTUSD", sentAtSec: 1000, nowSec: 1030, marginUsedRaw: 10, closed: [{ txid: "OENTRY", opentm: 1000, volExec: 0.0002 }] };
const pos = { id: "TPOS", ordertxid: "OENTRY", pair: "XBTUSD", side: "long" as const, vol: 0.0002 };

test("open checks: everything visible → all true, stop volume compared to the fill", () => {
  const { checks, position } = evaluateOpenChecks({ ...base, positions: [pos], orders: [order("OSTOP")] });
  assert.equal(position?.id, "TPOS");
  for (const k of ["position_visible", "attached_stop_visible", "stop_trigger_readable", "stop_vol_equals_fill", "trade_balance_margin", "closed_orders_recovery"]) assert.equal(checks[k]?.ok, true, k);
});

test("open checks: pending answers stay unset until their window ends; then they fail", () => {
  const early = evaluateOpenChecks({ ...base, nowSec: 1030, positions: [], orders: [], marginUsedRaw: null, closed: [] }).checks;
  assert.equal(early.position_visible, undefined);
  assert.equal(early.attached_stop_visible, undefined);
  assert.equal(early.closed_orders_recovery, undefined);
  const late = evaluateOpenChecks({ ...base, nowSec: 1000 + 7 * 60, positions: [], orders: [], marginUsedRaw: null, closed: [] }).checks;
  assert.equal(late.position_visible?.ok, false);
  assert.equal(late.attached_stop_visible?.ok, false);
  assert.equal(late.closed_orders_recovery?.ok, false);
  assert.equal(late.trade_balance_margin?.ok, false);
});

test("open checks: an unreadable trigger and a wrong stop volume are failures, not silence", () => {
  const c = evaluateOpenChecks({ ...base, positions: [pos], orders: [order("OSTOP", { price: 0, vol: 0.001 })] }).checks;
  assert.equal(c.stop_trigger_readable?.ok, false);
  assert.equal(c.stop_vol_equals_fill?.ok, false);
});

test("open checks: another account's stop (wrong userref) or another pair does not count", () => {
  const c = evaluateOpenChecks({ ...base, nowSec: 1000 + 7 * 60, positions: [pos], orders: [order("X", { userref: 1 }), order("Y", { pair: "ETHUSD" })] }).checks;
  assert.equal(c.attached_stop_visible?.ok, false);
});

test("close checks: gone + swept → ok; a lingering order of ours fails pair_swept", () => {
  const ok = evaluateCloseChecks({ entryTxid: "OENTRY", pair: "XBTUSD", positions: [], orders: [], marginUsedRaw: 0 });
  assert.equal(ok.position_gone.ok, true); assert.equal(ok.pair_swept.ok, true);
  const bad = evaluateCloseChecks({ entryTxid: "OENTRY", pair: "XBTUSD", positions: [pos], orders: [order("OSTOP")], marginUsedRaw: 10 });
  assert.equal(bad.position_gone.ok, false); assert.equal(bad.pair_swept.ok, false);
  const degraded = evaluateCloseChecks({ entryTxid: "OENTRY", pair: "XBTUSD", positions: [], orders: [], marginUsedRaw: 10 });
  assert.equal(degraded.position_gone.ok, null, "empty positions while margin is in use is a bad read, not a close");
});

test("verdict: complete only when every measured check is answered; FIFO is documented, never required", () => {
  const all: Record<string, { ok: boolean | null; note: string; at: string }> = {};
  for (const c of RT_CHECKS) if (c.key !== "fifo_netting") all[c.key] = { ok: true, note: "", at: "" };
  assert.deepEqual(roundTripVerdict(all), { complete: true, allOk: true, failed: [] });
  all.pair_swept = { ok: false, note: "", at: "" };
  assert.deepEqual(roundTripVerdict(all).failed, ["pair_swept"]);
  delete all.ohlc_since;
  assert.equal(roundTripVerdict(all).complete, false);
});

test("only a stop opened within the 6-min window counts as the attached close[]; a later one fails the check", () => {
  const late = evaluateOpenChecks({ ...base, nowSec: 1000 + 8 * 60, positions: [pos], orders: [order("GUARDIAN", { opentm: 1000 + 7 * 60 })] }).checks;
  assert.equal(late.attached_stop_visible?.ok, false);
  assert.match(late.attached_stop_visible?.note ?? "", /guardian replacement/);
  const early = evaluateOpenChecks({ ...base, positions: [pos], orders: [order("ATTACHED", { opentm: 1003 })] }).checks;
  assert.equal(early.attached_stop_visible?.ok, true);
});

test("the validate pass only counts when the executor's note describes an order that reached Kraken", () => {
  assert.equal(validatePassOk({ validated: true, executed: false, note: "buy $20 notional (2x, market) XBTUSD, stop 3.0%, med conviction → risk≤3.0%" }), true);
  assert.equal(validatePassOk({ validated: true, executed: false, note: "entry failed before any order was sent — nothing placed: timeout" }), false);
  assert.equal(validatePassOk({ validated: true, executed: false, note: "entry refused: cooldown (3/30 min since last entry)" }), false);
  assert.equal(validatePassOk({ validated: false, executed: false, note: "tracked only (kraken_margin_auto off)" }), false);
});

test("the config snapshot is dropped ONLY after a restore that ran and was clean", async () => {
  const { dropSnapshotIfClean } = await import("../src/lib/margin-round-trip");
  const mk = (restoreFailed?: string[]) => ({ stage: "failed" as const, symbol: "BTC/USD", startedAt: "", updatedAt: "", checks: {}, log: [], savedCfg: { kraken_margin_auto: null }, restoreFailed });
  const never = mk(undefined); dropSnapshotIfClean(never);
  assert.ok(never.savedCfg, "no restore has run yet → the snapshot must survive for the finally/guardian to restore from");
  const owed = mk(["kraken_margin_auto"]); dropSnapshotIfClean(owed);
  assert.ok(owed.savedCfg, "a restore is still owed → keep the snapshot");
  const clean = mk([]); dropSnapshotIfClean(clean);
  assert.equal(clean.savedCfg, undefined, "restored cleanly → drop it so a finished run never rewrites live config");
});
