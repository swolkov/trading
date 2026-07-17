// Watches the LIVE futures engine and exits 0 the moment the account is FLAT (no open positions) with a
// fresh heartbeat — the safe window to redeploy the engine. Prints the last gold (MGC) close so we know how
// the open trade resolved. Exits 2 on an 8h timeout (re-arm). Polls every 60s; does NOT restart anything.
import { prisma } from "../src/lib/db";

const SLEEP_MS = 60_000;
const MAX_MS = 8 * 3600_000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const start = Date.now();
  while (Date.now() - start < MAX_MS) {
    let pos: number | undefined, age = Infinity, session = "?";
    try {
      const hb = await prisma.agentConfig.findUnique({ where: { key: "futures_engine_heartbeat_live" } });
      const v = hb?.value ? JSON.parse(hb.value) : {};
      pos = v.positions;
      session = v.session ?? "?";
      age = v.timestamp ? (Date.now() - Date.parse(v.timestamp)) / 1000 : Infinity;
    } catch (e) {
      console.log(new Date().toISOString(), "heartbeat read error:", String(e).slice(0, 80));
    }
    console.log(new Date().toISOString(), `positions=${pos} hbAge=${age.toFixed(0)}s session=${session}`);

    // Flat = engine reports 0 positions AND its heartbeat is fresh (engine alive, not a stale zero).
    if (pos === 0 && age < 180) {
      const last = await prisma.autoTradeLog.findFirst({
        where: { symbol: "FUT:MGC", action: { startsWith: "live_" }, pnl: { not: null } },
        orderBy: { createdAt: "desc" },
      });
      console.log("=== FLAT — safe to deploy ===");
      console.log("last MGC close:", last ? `${last.createdAt.toISOString().slice(11, 16)} ${last.action} @ $${last.price} → $${last.pnl?.toFixed(2)} (${(last.reason || "").slice(0, 40)})` : "none found");
      await prisma.$disconnect();
      process.exit(0);
    }
    await sleep(SLEEP_MS);
  }
  console.log("=== TIMEOUT (8h) — still not flat, re-arm needed ===");
  await prisma.$disconnect();
  process.exit(2);
})();
