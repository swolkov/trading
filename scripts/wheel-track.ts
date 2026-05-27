/**
 * Wheel Forward Paper Tracker (manual runner) — proves the cash-secured-put / covered-call "wheel"
 * forward at $0. Thin wrapper over src/lib/wheel-tracker.ts (the shared core, also run by the Vercel
 * cron /api/cron/wheel-track). State + ledger live in the DB, so this and the cron share one book and
 * advance the wheel at most once per day. Simulated ~$30K; places NO orders; never touches the live
 * $1K stocks/crypto account.
 *
 *   npx tsx scripts/wheel-track.ts          advance the wheel on current data → bank a ledger row
 *   npx tsx scripts/wheel-track.ts --reset  start a fresh $30K book (clears DB state)
 */
import { config } from "dotenv";
config({ path: ".env.local" });
config();

async function main() {
  const reset = process.argv.includes("--reset");
  // Dynamic import AFTER dotenv (db/alpaca read env at module init).
  const { runWheelOnce } = await import("../src/lib/wheel-tracker");
  const r = await runWheelOnce({ reset });
  const s = r.state;

  const W = 100;
  console.log("\n" + "═".repeat(W));
  console.log("  WHEEL FORWARD PAPER TRACKER   (simulated ~$30K, live option data, NO live orders)");
  console.log("═".repeat(W));
  if (r.log.length) { console.log("  Actions this run:"); for (const l of r.log) console.log("   • " + l); console.log("─".repeat(W)); }
  console.log(`  Equity:        $${r.equity.toFixed(0)}  (${r.retPct >= 0 ? "+" : ""}${r.retPct.toFixed(2)}% from $${s.startCapital})`);
  console.log(`  Cash:          $${s.cash.toFixed(0)}   ·   Shares value: $${r.sharesValue.toFixed(0)}   ·   Short liability: $${r.shortLiab.toFixed(0)}`);
  console.log(`  Open:          ${s.shortPuts.length} puts · ${s.shortCalls.length} calls · ${Object.keys(s.shares).length} stock lots`);
  console.log(`  Premium total: $${s.premiumCollected.toFixed(0)}   ·   Realized P&L: $${s.realizedPnl.toFixed(0)}   ·   Assigned ${s.assignments} · Called away ${s.calledAway}`);
  console.log("─".repeat(W));
  console.log(`  Ledger: ${r.ledger.length} day(s) in DB (key wheel_ledger). Proves the VRP edge forward at $0.`);
  console.log(`  NOT going live at $1K — the wheel needs breadth (5-10 positions) to survive its tail.`);
  console.log("═".repeat(W) + "\n");
}
main().catch((e) => { console.error(e); process.exit(1); });
