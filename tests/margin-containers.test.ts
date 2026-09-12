import assert from "node:assert/strict";
import test from "node:test";
import { LIVE_CONTAINERS, armableSources, bookMaxHoldH, bookTrailR, liveContainerFor } from "../src/lib/margin-live-risk";
import { exitParams } from "../src/lib/margin-shadow";
import { RETIRED_AUTO_SOURCES } from "../src/lib/margin-auto-plans";

// Live must reproduce the container each paper sleeve was scored with. This pins every
// live container to paper's exitParams so the two tables cannot drift apart silently.

test("every live container equals its paper container (stop %, hold hours, trail width)", () => {
  for (const [source, c] of Object.entries(LIVE_CONTAINERS)) {
    const paper = exitParams(source === "roundtrip" ? "selective" : source, 2, 100);
    assert.equal(c.stopPct, paper.oneR, `${source}: stop`);
    assert.equal(c.maxHoldH, paper.maxHoldH, `${source}: hold`);
    assert.equal(c.trailR, paper.trailR ?? 1, `${source}: trail`);
    // The guardian mirrors a BASE trail only. A paper profile that tightens after +NR or
    // closes a failure-to-launch is an exit live does not run — such a sleeve must not be here.
    assert.equal(paper.tightAfterR, undefined, `${source}: the guardian does not mirror a tightening trail`);
    assert.equal(paper.launchH, undefined, `${source}: the guardian does not mirror a launch stop`);
  }
});

test("sleeves whose paper EXIT the guardian does not mirror have no live container and cannot be armed", () => {
  for (const s of ["selective-tight", "selective-launch", "selective-x5", "swing-spot", "swing-lock", "scanner", "fast-tight", "sweep-fade", "selective-swing", "nonsense", "constructor", "__proto__", "toString"]) assert.equal(liveContainerFor(s), null, s);
  for (const s of RETIRED_AUTO_SOURCES) assert.equal(liveContainerFor(s), null, `retired ${s}`);
  assert.equal(liveContainerFor(null), null);
  assert.equal(liveContainerFor(""), null);
});

test("the fast family shares one container with market entries; the slow sleeves have their own", () => {
  const fast = liveContainerFor("selective")!;
  assert.deepEqual(fast, { stopPct: 3, maxHoldH: 48, makerEntries: false, trailR: 1 });
  for (const s of ["selective-btc", "selective-majors", "selective-short", "tv:esbueno", "roundtrip"]) assert.deepEqual(liveContainerFor(s), fast, s);
  assert.equal(liveContainerFor("manual"), null, "raw webhook alerts are scored in a container the guardian does not mirror");
  assert.deepEqual(liveContainerFor("swing-lev"), { stopPct: 4, maxHoldH: 96, makerEntries: null, trailR: 1 });
  assert.deepEqual(liveContainerFor("swing-wide"), { stopPct: 4, maxHoldH: 168, makerEntries: null, trailR: 2 }, "swing-lev's stop, the 2R trail, the 7-day hold");
  assert.deepEqual(liveContainerFor("tsmom"), { stopPct: 8, maxHoldH: 336, makerEntries: null, trailR: 1 });
});

test("the arm switch offers every live container that is a real sleeve — and nothing else", () => {
  const a = armableSources();
  assert.ok(a.includes("swing-lev") && a.includes("swing-wide"), "both swing sleeves can be armed");
  assert.ok(!a.includes("roundtrip"), "the plumbing test's label is not a sleeve");
  for (const s of a) { assert.ok(liveContainerFor(s), s); assert.ok(!RETIRED_AUTO_SOURCES.has(s), s); assert.match(s, /^[a-z0-9_-]{1,32}$/); }
  assert.ok(!a.includes("swing-lock") && !a.includes("selective-tight"), "no container, not armable");
  assert.ok(!a.includes("tsmom") && !a.includes("tsmom-short"), "the scanner never hands tsmom to the executor — arming it live places nothing");
});

test("a book's trail is the trail its tranches were opened under; unknown or mixed = the record's 1R", () => {
  assert.equal(bookTrailR([{ trailR: 2, source: "swing-wide" }]), 2, "ledgered trail wins");
  assert.equal(bookTrailR([{ trailR: null, source: "swing-wide" }]), 2, "a pre-trailR ledger entry reads its source's container");
  assert.equal(bookTrailR([{ trailR: 2, source: "swing-lev" }]), 2, "the ledger beats the table — a position keeps what it was opened under");
  assert.equal(bookTrailR([{ trailR: null, source: "swing-lev" }]), 1);
  assert.equal(bookTrailR([{ trailR: null, source: null }]), 1, "legacy entries (no source) stay on the record's rule");
  assert.equal(bookTrailR([{ trailR: null, source: "selective-tight" }]), 1, "a source without a container is managed on 1R");
  assert.equal(bookTrailR([{ trailR: 2, source: "swing-wide" }, { trailR: null, source: "swing-lev" }]), 1, "tranches that disagree fall to 1R, never the widest");
  assert.equal(bookTrailR([{ trailR: 0, source: "swing-wide" }]), 2, "junk trailR is ignored, not read as 0");
  assert.equal(bookTrailR([{ trailR: NaN, source: null }]), 1);
  assert.equal(bookTrailR([]), 1);
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
