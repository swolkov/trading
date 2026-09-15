import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import {
  SHOCK_HOLD_MIN, SHOCK_MOVE_PCT, SHOCK_RANGE_ATR, altEntryVetoed, btcShock, btcStateStamp, btcVetoEnabled, carryShock, fastMoveVetoSuffix,
} from "../src/lib/margin-btc-shock";
import type { KrakenBar } from "../src/lib/kraken-margin";

const NOW = Date.parse("2026-09-15T13:32:00Z");
const bar = (t: number, c: number, range = 0.002): KrakenBar => ({ t, o: c, h: c * (1 + range / 2), l: c * (1 - range / 2), c, v: 1 });
/** n 5-minute bars ending at NOW, flat at `px`, with the LAST close moved by `movePct` vs 12 bars back. */
const m5Series = (px: number, movePct: number, n = 40): KrakenBar[] => {
  const out: KrakenBar[] = [];
  for (let i = 0; i < n; i++) out.push(bar(NOW / 1000 - (n - 1 - i) * 300, px));
  out[n - 1] = bar(out[n - 1].t, px * (1 + movePct));
  return out;
};
/** n hourly bars, quiet (0.2% ranges), with the COMPLETED bar (index n−2) optionally widened. */
const h1Series = (px: number, completedRange = 0.002, completedUp = true, n = 40): KrakenBar[] => {
  const out: KrakenBar[] = [];
  for (let i = 0; i < n; i++) out.push(bar(NOW / 1000 - (n - 1 - i) * 3600, px));
  const c = out[n - 2];
  const o = completedUp ? px * (1 - completedRange / 2) : px * (1 + completedRange / 2);
  const cl = completedUp ? px * (1 + completedRange / 2) : px * (1 - completedRange / 2);
  out[n - 2] = { ...c, o, c: cl, h: Math.max(o, cl), l: Math.min(o, cl) };
  return out;
};

test("constants: the move threshold is the guardian's fast-move 3%, range 2.5× ATR, hold 60 min", () => {
  assert.equal(SHOCK_MOVE_PCT, 0.03);
  assert.equal(SHOCK_RANGE_ATR, 2.5);
  assert.equal(SHOCK_HOLD_MIN, 60);
  // The guardian's own threshold, read from source, so the two cannot drift.
  const watch = readFileSync(new URL("../src/app/api/cron/margin-watch/route.ts", import.meta.url), "utf8");
  assert.ok(/Math\.abs\(move\) >= 0\.03/.test(watch), "the guardian's fast-move alert fires at 3%");
});

test("a −3.4% hour is a shock down with until = now + 60 min; a +3% hour is a shock up; 2.9% is calm", () => {
  const down = btcShock(m5Series(76_000, -0.034), h1Series(76_000), NOW);
  assert.equal(down.barsOk, true);
  assert.equal(down.shock, "down");
  assert.ok(Math.abs((down.move1hPct ?? 0) + 0.034) < 1e-9);
  assert.equal(down.until, new Date(NOW + 60 * 60_000).toISOString());
  const up = btcShock(m5Series(76_000, 0.03), h1Series(76_000), NOW);
  assert.equal(up.shock, "up");
  const calm = btcShock(m5Series(76_000, 0.029), h1Series(76_000), NOW);
  assert.equal(calm.shock, null);
  assert.equal(calm.until, null);
  assert.equal(btcStateStamp(calm), "calm");
  assert.equal(btcStateStamp(down), "shock-down");
  assert.equal(btcStateStamp(up), "shock-up");
});

test("a completed hourly bar ≥2.5× the prior ATR is a shock in the bar's direction, even with a small 1h net move", () => {
  // Quiet 0.2% bars → ATR ≈ 0.2% of price; a 1.5% range bar is 7.5× that.
  const wideDown = btcShock(m5Series(76_000, 0.001), h1Series(76_000, 0.015, false), NOW);
  assert.ok((wideDown.rangeAtrMult ?? 0) >= SHOCK_RANGE_ATR, `range mult ${wideDown.rangeAtrMult}`);
  assert.equal(wideDown.shock, "down");
  const wideUp = btcShock(m5Series(76_000, 0.001), h1Series(76_000, 0.015, true), NOW);
  assert.equal(wideUp.shock, "up");
  // The 1h move wins over the bar when both fire and disagree.
  const both = btcShock(m5Series(76_000, 0.035), h1Series(76_000, 0.015, false), NOW);
  assert.equal(both.shock, "up");
});

test("missing or short BTC bars → no veto, stamp 'unknown'; a short 1h series still reads the 5m move", () => {
  const none = btcShock([], [], NOW);
  assert.equal(none.barsOk, false);
  assert.equal(none.shock, null);
  assert.equal(btcStateStamp(none), "unknown");
  assert.deepEqual(altEntryVetoed(none, "buy", "ETH", NOW), { vetoed: false, note: null });
  const shortH1 = btcShock(m5Series(76_000, -0.04), h1Series(76_000).slice(-5), NOW);
  assert.equal(shortH1.barsOk, true);
  assert.equal(shortH1.shock, "down");
  assert.equal(shortH1.rangeAtrMult, null);
  const shortM5 = btcShock(m5Series(76_000, -0.04).slice(-5), h1Series(76_000), NOW);
  assert.equal(shortM5.move1hPct, null);
  assert.equal(shortM5.shock, null);
});

test("altEntryVetoed: long vetoed on shock down, short on shock up, BTC itself never, expired never; the note names the move and the clock", () => {
  const down = btcShock(m5Series(76_000, -0.034), h1Series(76_000), NOW);
  const v = altEntryVetoed(down, "buy", "ETH", NOW + 5 * 60_000);
  assert.equal(v.vetoed, true);
  assert.equal(v.note, "BTC shock down −3.4%/1h — alt longs vetoed until 14:32Z");
  assert.equal(altEntryVetoed(down, "sell", "ETH", NOW).vetoed, false, "a short WITH the shock is not vetoed");
  assert.equal(altEntryVetoed(down, "buy", "BTC", NOW).vetoed, false, "BTC is never vetoed");
  assert.equal(altEntryVetoed(down, "buy", "ETH", NOW + 61 * 60_000).vetoed, false, "expired");
  assert.equal(altEntryVetoed(down, "buy", "ETH", NOW + 60 * 60_000).vetoed, false, "exactly at `until` is expired");
  const up = btcShock(m5Series(76_000, 0.031), h1Series(76_000), NOW);
  const vs = altEntryVetoed(up, "sell", "SOL", NOW);
  assert.equal(vs.vetoed, true);
  assert.match(vs.note!, /^BTC shock up \+3\.1%\/1h — alt shorts vetoed until 14:32Z$/);
  assert.equal(altEntryVetoed(up, "buy", "SOL", NOW).vetoed, false);
  // A range-triggered shock says so.
  const wide = btcShock(m5Series(76_000, 0.001), h1Series(76_000, 0.015, false), NOW);
  assert.match(altEntryVetoed(wide, "buy", "ETH", NOW).note!, /^BTC shock down [\d.]+× ATR hourly range — alt longs vetoed until 14:32Z$/);
});

test("carryShock: a prior veto stands until its clock runs out; a fresh shock restarts it; expired clears", () => {
  const calm = btcShock(m5Series(76_000, 0.001), h1Series(76_000), NOW + 20 * 60_000);
  const prior = { shock: "down" as const, until: new Date(NOW + 60 * 60_000).toISOString() };
  const carried = carryShock(calm, prior, NOW + 20 * 60_000);
  assert.equal(carried.shock, "down");
  assert.equal(carried.until, prior.until);
  assert.equal(altEntryVetoed(carried, "buy", "ETH", NOW + 20 * 60_000).vetoed, true);
  const expired = carryShock(calm, prior, NOW + 61 * 60_000);
  assert.equal(expired.shock, null);
  assert.equal(expired.until, null);
  const fresh = btcShock(m5Series(76_000, 0.032), h1Series(76_000), NOW + 30 * 60_000);
  const restarted = carryShock(fresh, prior, NOW + 30 * 60_000);
  assert.equal(restarted.shock, "up");
  assert.equal(restarted.until, new Date(NOW + 90 * 60_000).toISOString());
  assert.equal(carryShock(calm, null, NOW).shock, null);
  assert.equal(carryShock(calm, { shock: "down", until: "garbage" }, NOW).shock, null, "an unparseable clock is no veto");
});

test("the off switch: only the literal 'false' disables; missing/garbage/unreadable read as ON (fail closed for entries)", () => {
  assert.equal(btcVetoEnabled("false"), false);
  assert.equal(btcVetoEnabled("true"), true);
  assert.equal(btcVetoEnabled(null), true);
  assert.equal(btcVetoEnabled(undefined), true);
  assert.equal(btcVetoEnabled("off"), true);
  assert.equal(fastMoveVetoSuffix("down", NOW), "alt longs vetoed until 14:32Z");
  assert.equal(fastMoveVetoSuffix("up", NOW), "alt shorts vetoed until 14:32Z");
});

test("source: the scan route computes the shock once from btcBars, carries it in state, and only withholds the LIVE hand-off", () => {
  const scan = readFileSync(new URL("../src/app/api/cron/margin-scan/route.ts", import.meta.url), "utf8");
  assert.ok(/carryShock\(btcShock\(scan\.btcBars\.m5, scan\.btcBars\.h1\), state\.btcShock/.test(scan));
  assert.ok(/state\.btcShock = \{ shock: btcState\.shock, until: btcState\.until \}/.test(scan));
  assert.ok(/\.catch\(\(\) => true\)/.test(scan.split("BTC_VETO_KEY } })")[1] ?? ""), "an unreadable off switch reads as ON");
  // The veto branch comes AFTER the paper INSERT (row still opens) and BEFORE executeAlert.
  const insertAt = scan.indexOf("INSERT INTO tradingview_alerts");
  const vetoAt = scan.indexOf("altEntryVetoed(btcState, side, s.coin)");
  const execAt = scan.indexOf("await executeAlert({");
  assert.ok(insertAt > 0 && insertAt < vetoAt && vetoAt < execAt);
  assert.ok(/gatherIntel\(scan, eventStamp, \{ state: btcStateStamp\(btcState\) \}/.test(scan), "btc_state is stamped on every paper row");
  // The guardian's fast-move line carries the veto clock for BTC.
  const watch = readFileSync(new URL("../src/app/api/cron/margin-watch/route.ts", import.meta.url), "utf8");
  assert.ok(/fastMoveVetoSuffix\(dir\)/.test(watch));
  // The executor never imports the veto: it is the scan's decision, not a sizing input.
  const exec = readFileSync(new URL("../src/lib/margin-executor.ts", import.meta.url), "utf8");
  assert.ok(!/margin-btc-shock/.test(exec));
});
