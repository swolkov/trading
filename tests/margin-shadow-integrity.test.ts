import assert from "node:assert/strict";
import test from "node:test";
import { prisma } from "../src/lib/db";
import { evaluateShadowSignals } from "../src/lib/margin-shadow";

const restores: (() => void)[] = [];
function stub(object: object, key: string, value: unknown) {
  const previous = Reflect.get(object, key);
  Reflect.set(object, key, value);
  restores.push(() => { Reflect.set(object, key, previous); });
}
function restore() { while (restores.length) restores.pop()!(); }

const row = (ageHours: number) => ({
  id: 91, time: new Date(Date.now() - ageHours * 3600_000), symbol: "ETH/USD", side: "buy",
  leverage: 5, mark_price: 100, shadow_peak: 100, shadow_stop: 96, shadow_seen_t: 0,
  conviction: "high", source: "swing-pyr", shadow_notional: 9000,
  shadow_add_px: 104, shadow_add_t: Date.now() / 1000 - 600, shadow_add_notional: 4000,
});

test("missing prices cannot fabricate an overdue pyramid exit", async () => {
  const writes: string[] = [];
  stub(prisma, "$queryRawUnsafe", async () => [row(170)]);
  stub(prisma, "$executeRawUnsafe", async (sql: string) => { writes.push(sql); return 1; });
  stub(globalThis, "fetch", async () => { throw new Error("feed unavailable"); });
  try {
    assert.deepEqual(await evaluateShadowSignals(), []);
    assert.ok(!writes.some((sql) => sql.includes("shadow_status='resolved'")));
    await assert.rejects(evaluateShadowSignals({ requiredSources: ["swing-pyr"] }), /assessment incomplete/);
  } finally { restore(); }
});

test("an existing pyramid uses frozen first-unit size even when sizing configuration is unavailable", async () => {
  const writes: unknown[][] = [];
  stub(prisma, "$queryRawUnsafe", async () => [row(0.5)]);
  stub(prisma, "$executeRawUnsafe", async (...args: unknown[]) => { writes.push(args); return 1; });
  stub(prisma.agentConfig, "findUnique", async () => { throw new Error("sizing config must not reprice old exposure"); });
  const t = Math.floor(Date.now() / 60_000) * 60;
  stub(globalThis, "fetch", async () => Response.json({ error: [], result: {
    ETHUSD: [[t, "101", "101", "101", "101", "101", "1", 1]], last: t,
  } }));
  try {
    assert.deepEqual(await evaluateShadowSignals(), []);
    const mark = writes.find((args) => String(args[0]).includes("shadow_unrealized=$3"));
    assert.ok(mark, "fresh prices mark both units");
    assert.equal(mark[8], 4000, "the add's stored notional is preserved");
    assert.ok(Number.isFinite(mark[3]));
  } finally { restore(); }
});

test("an incomplete 500-row shadow read cannot approve armed entries", async () => {
  stub(prisma, "$queryRawUnsafe", async () => Array.from({ length: 500 }, () => row(170)));
  stub(prisma, "$executeRawUnsafe", async () => 1);
  try {
    await assert.rejects(evaluateShadowSignals({ requiredSources: ["swing-pyr"] }), /open-row limit/);
  } finally { restore(); }
});

test("entry sizing cannot freeze guessed configuration as verified", async () => {
  const { snapshotShadowSizing } = await import("../src/lib/margin-shadow");
  let queried = false;
  stub(prisma.agentConfig, "findUnique", async () => { throw new Error("config offline"); });
  stub(prisma, "$queryRawUnsafe", async () => { queried = true; return []; });
  try {
    await assert.rejects(snapshotShadowSizing(91), /config offline/);
    assert.equal(queried, false, "failed config cannot be persisted as an entry snapshot");
  } finally { restore(); }
});

test("risk assessment propagates missing required config", async () => {
  const { maybeDemote } = await import("../src/lib/margin-synthesis");
  stub(prisma.agentConfig, "findUnique", async () => { throw new Error("risk config offline"); });
  try {
    await assert.rejects(maybeDemote(), /risk config offline/);
  } finally { restore(); }
});
