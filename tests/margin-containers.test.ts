import assert from "node:assert/strict";
import test from "node:test";
import { LIVE_CONTAINERS, bookMaxHoldH, liveContainerFor } from "../src/lib/margin-live-risk";
import { exitParams } from "../src/lib/margin-shadow";
import { RETIRED_AUTO_SOURCES } from "../src/lib/margin-auto-plans";

// Live must reproduce the container each paper sleeve was scored with. This pins every
// live container to paper's exitParams so the two tables cannot drift apart silently.

test("every live container equals its paper container (stop % and hold hours)", () => {
  for (const [source, c] of Object.entries(LIVE_CONTAINERS)) {
    const paper = exitParams(source === "roundtrip" ? "selective" : source, 2, 100);
    assert.equal(c.stopPct, paper.oneR, `${source}: stop`);
    assert.equal(c.maxHoldH, paper.maxHoldH, `${source}: hold`);
  }
});

test("sleeves whose paper EXIT the guardian does not mirror have no live container and cannot be armed", () => {
  for (const s of ["selective-tight", "selective-launch", "selective-x5", "swing-spot", "swing-wide", "scanner", "fast-tight", "sweep-fade", "selective-swing", "nonsense", "constructor", "__proto__", "toString"]) assert.equal(liveContainerFor(s), null, s);
  for (const s of RETIRED_AUTO_SOURCES) assert.equal(liveContainerFor(s), null, `retired ${s}`);
  assert.equal(liveContainerFor(null), null);
  assert.equal(liveContainerFor(""), null);
});

test("the fast family shares one container with market entries; the slow sleeves have their own", () => {
  const fast = liveContainerFor("selective")!;
  assert.deepEqual(fast, { stopPct: 3, maxHoldH: 48, makerEntries: false });
  for (const s of ["selective-btc", "selective-majors", "selective-short", "tv:esbueno", "roundtrip"]) assert.deepEqual(liveContainerFor(s), fast, s);
  assert.equal(liveContainerFor("manual"), null, "raw webhook alerts are scored in a container the guardian does not mirror");
  assert.deepEqual(liveContainerFor("swing-lev"), { stopPct: 4, maxHoldH: 96, makerEntries: null });
  assert.deepEqual(liveContainerFor("tsmom"), { stopPct: 8, maxHoldH: 336, makerEntries: null });
});

test("a book's time stop is the shortest hold of its tranches; a tranche with no ledgered hold counts as the global", () => {
  assert.equal(bookMaxHoldH([96, null, 48], 48), 48);
  assert.equal(bookMaxHoldH([96], 48), 96);
  assert.equal(bookMaxHoldH([null, undefined], 48), 48, "pre-container ledger entries keep today's behaviour");
  assert.equal(bookMaxHoldH([null, 96], 48), 48, "a legacy 48h position stacked with a new 96h one keeps its 48h (Codex R1)");
  assert.equal(bookMaxHoldH([], 72), 72);
  assert.equal(bookMaxHoldH([0, -5, NaN, 336], 48), 48, "junk counts as the global, never as a longer hold");
  assert.equal(bookMaxHoldH([336], 48), 336);
});
