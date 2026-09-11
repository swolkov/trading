import assert from "node:assert/strict";
import test from "node:test";
import { prisma } from "../src/lib/db";
import { barsStoreFreshness, barsWorklist, ensureBarsStore, getStoredBars, putBars } from "../src/lib/options-bars-store";
import { getDailyBars } from "../src/lib/rh-options-data";

// The bars inbox is the ONLY way underlying prices reach the options book (Robinhood, pushed
// by the desk session — see options-bars-store.ts). These run against the real table with a
// symbol no scanner will ever ask for, and clean up after themselves.
const SYM = "ZZTESTBARS";
const bar = (day: string, c: number, official = false) => ({ day, o: c - 1, h: c + 1, l: c - 2, c, v: 1000, official });
const wipe = async () => { await ensureBarsStore(); await prisma.$executeRawUnsafe(`DELETE FROM options_underlying_bars WHERE symbol = $1`, SYM); };

test("bars round-trip in date order with the session timestamp the scan expects", async () => {
  await wipe();
  assert.equal(await putBars(SYM, [bar("2026-09-10", 50), bar("2026-09-08", 48), bar("2026-09-09", 49)]), 3);
  const got = (await getStoredBars([SYM], 30))[SYM];
  assert.deepEqual(got.map((b) => b.t), ["2026-09-08T13:30:00.000Z", "2026-09-09T13:30:00.000Z", "2026-09-10T13:30:00.000Z"]);
  assert.equal(got.at(-1)?.c, 50);
  await wipe();
});

test("an official close overwrites a provisional bar; a provisional bar never overwrites an official one", async () => {
  await wipe();
  await putBars(SYM, [bar("2026-09-11", 60)]);
  await putBars(SYM, [bar("2026-09-11", 61, true)]);
  assert.equal((await getStoredBars([SYM], 30))[SYM].at(-1)?.c, 61, "official replaced provisional");
  await putBars(SYM, [bar("2026-09-11", 59)]);
  assert.equal((await getStoredBars([SYM], 30))[SYM].at(-1)?.c, 61, "provisional did not replace official");
  await putBars(SYM, [bar("2026-09-11", 62, true)]);
  assert.equal((await getStoredBars([SYM], 30))[SYM].at(-1)?.c, 62, "a later official close still wins");
  await wipe();
});

test("malformed bars are rejected, not guessed", async () => {
  await wipe();
  const n = await putBars(SYM, [
    { day: "2026/09/10", o: 1, h: 2, l: 0.5, c: 1.5, v: 1, official: false },   // bad date
    { day: "2026-09-10", o: 1, h: 0.5, l: 2, c: 1.5, v: 1, official: false },   // high < low
    { day: "2026-09-11", o: 1, h: 2, l: 0.5, c: 3, v: 1, official: false },     // close above high
    { day: "2026-09-12", o: 0, h: 2, l: 0.5, c: 1.5, v: 1, official: false },   // zero open
    bar("2026-09-13", 10),
  ]);
  assert.equal(n, 1);
  await wipe();
});

test("worklist asks for a full history when nothing is stored, and only the gap otherwise", async () => {
  await wipe();
  const now = new Date("2026-09-11T22:00:00Z");
  const [empty] = await barsWorklist([SYM], now);
  assert.equal(empty.newestStored, null);
  assert.ok(empty.fromDay < "2025-08-01", "a full history reaches back past the 200-day average");
  await putBars(SYM, [bar("2026-09-09", 50), bar("2026-09-10", 51, true)]);
  const [gap] = await barsWorklist([SYM], now);
  assert.equal(gap.newestStored, "2026-09-10");
  assert.equal(gap.fromDay, "2026-09-11", "newest is official → start the day after");
  await putBars(SYM, [bar("2026-09-11", 52)]);   // provisional
  const [prov] = await barsWorklist([SYM], now);
  assert.equal(prov.fromDay, "2026-09-11", "newest is provisional → re-fetch that day so the official close can replace it");
  await wipe();
});

test("freshness: a name whose newest bar is older than four days is stale, and one stale name makes the store stale", async () => {
  await wipe();
  const now = new Date("2026-09-11T22:00:00Z");
  await putBars(SYM, [bar("2026-09-05", 50)]);   // 6 days back
  const st = await barsStoreFreshness([SYM], now);
  assert.deepEqual(st.staleSymbols, [SYM]);
  assert.equal(st.stale, true);
  await putBars(SYM, [bar("2026-09-10", 51)]);
  const ok = await barsStoreFreshness([SYM], now);
  assert.equal(ok.stale, false);
  assert.equal(ok.newestDay, "2026-09-10");
  await wipe();
});

test("getDailyBars reads the inbox and drops today's bar only while the session is open", async () => {
  await wipe();
  await putBars(SYM, [bar("2026-09-10", 50), bar("2026-09-11", 51)]);
  const during = await getDailyBars([SYM], 30, new Date("2026-09-11T19:00:00Z"));   // 15:00 ET
  const after = await getDailyBars([SYM], 30, new Date("2026-09-11T21:32:00Z"));    // 17:32 ET
  assert.equal(during[SYM].at(-1)?.t.slice(0, 10), "2026-09-10");
  assert.equal(after[SYM].at(-1)?.t.slice(0, 10), "2026-09-11");
  assert.equal((await getDailyBars(["ZZNOTHINGHERE"], 30))["ZZNOTHINGHERE"], undefined, "unknown symbol is absent, not empty");
  await wipe();
});
