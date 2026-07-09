// Watches for the NEXT live-engine futures entry (MGC/MNQ/MES) and prints a verdict on whether
// the gold edge-gate held: extreme RSI bounce = GATE HOLDING; trend pullback/continuation = GATE FAILED.
// Exits 0 when a new entry is found, 2 on timeout (so it can be re-armed).
import { prisma } from "../src/lib/db";

const ENTRY_ACTIONS = ["live_long", "live_short", "futures_long", "futures_short"];
const LIVE_SYMS = ["FUT:MGC", "FUT:MNQ", "FUT:MES"];
const POLL_MS = 300_000;      // 5 min
const MAX_ITERS = 130;        // ~10.8h per arm, then exit(2) to re-arm (spans a full session)

function verdict(reason: string): string {
  const r = reason.toLowerCase();
  if (/rsi.?bounce|extreme_rsi|oversold|overbought.?short/.test(r)) return "✅ GATE HOLDING — validated RSI-bounce/overbought edge";
  if (/trend.?pullback|trend.?continuation|pullback long/.test(r))   return "❌ GATE FAILED — losing trend-pullback setup slipped through";
  return "⚠️ UNKNOWN setup — inspect the reason manually";
}

// Retry wrapper — Neon drops idle connections (P1001); a transient blip must NOT kill the watcher.
async function withRetry<T>(fn: () => Promise<T>, tries = 5): Promise<T> {
  let last: unknown;
  for (let a = 0; a < tries; a++) {
    try { return await fn(); }
    catch (e) { last = e; await new Promise((r) => setTimeout(r, 5_000 * (a + 1))); }
  }
  throw last;
}

async function main() {
  const baseline = await withRetry(() => prisma.autoTradeLog.findFirst({
    where: { symbol: { in: LIVE_SYMS }, action: { in: ENTRY_ACTIONS } },
    orderBy: { createdAt: "desc" },
  }));
  const since = baseline?.createdAt ?? new Date(0);
  console.error(`[watch] baseline entry: ${baseline ? baseline.createdAt.toISOString() + " " + baseline.symbol : "none"} — watching for newer…`);

  for (let i = 0; i < MAX_ITERS; i++) {
    let hit;
    try {
      hit = await withRetry(() => prisma.autoTradeLog.findFirst({
        where: { symbol: { in: LIVE_SYMS }, action: { in: ENTRY_ACTIONS }, createdAt: { gt: since } },
        orderBy: { createdAt: "asc" },
      }));
    } catch (e) {
      console.error(`[watch] poll ${i} DB unreachable after retries — will retry next cycle:`, String(e).slice(0, 80));
      await new Promise((r) => setTimeout(r, POLL_MS));
      continue;
    }
    if (hit) {
      console.log("=== NEW LIVE FUTURES TRADE ===");
      console.log(`time:   ${hit.createdAt.toISOString()}`);
      console.log(`symbol: ${hit.symbol}   action: ${hit.action}   price: ${hit.price}`);
      console.log(`reason: ${hit.reason ?? ""}`);
      console.log(`VERDICT: ${verdict(hit.reason ?? "")}`);
      await prisma.$disconnect();
      process.exit(0);
    }
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
  console.error("[watch] no live trade within window — re-arm to keep watching.");
  await prisma.$disconnect();
  process.exit(2);
}
main().catch(async (e) => { console.error("[watch] error:", e); await prisma.$disconnect(); process.exit(3); });
