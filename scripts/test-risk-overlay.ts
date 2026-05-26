/**
 * SANITY TEST for RiskOverlay — verifies each guard actually fires.
 *   npx tsx scripts/test-risk-overlay.ts
 */
import { RiskOverlay } from "../src/lib/strategies/risk-overlay";

let pass = 0, fail = 0;
const check = (name: string, cond: boolean) => { console.log(`  ${cond ? "✅" : "❌"} ${name}`); cond ? pass++ : fail++; };

function main() {
  const cfg = { maxConcurrent: 3, maxRiskPerTradePct: 0.02, maxPortfolioHeatPct: 0.05, dailyLossLimitPct: 0.03, maxDrawdownPct: 0.15 };
  const eq = 50000;
  console.log("\n  RISK OVERLAY — guard tests (equity $50k, 2%/trade, 3 concurrent, 5% heat, 3% daily, 15% DD)\n");

  let r = new RiskOverlay(cfg, eq); r.newDay("2026-05-26");
  check("allows a normal entry ($500 risk)", r.canEnter("CL/RB", 500, eq).ok);

  r = new RiskOverlay(cfg, eq); r.newDay("2026-05-26");
  check("rejects oversized trade ($1500 = 3% > 2% cap)", !r.canEnter("CL/RB", 1500, eq).ok);

  r = new RiskOverlay(cfg, eq); r.newDay("2026-05-26");
  r.onOpen("CL/RB", 900); r.onOpen("ZC/ZS", 900);
  check("rejects entry that breaches 5% heat cap (900+900+900 > 2500)", !r.canEnter("6E/6B", 900, eq).ok);

  r = new RiskOverlay(cfg, eq); r.newDay("2026-05-26");
  r.onOpen("CL/RB", 400); r.onOpen("ZC/ZS", 400); r.onOpen("6E/6B", 400);
  check("rejects 4th concurrent position (max 3)", !r.canEnter("CL/HO", 400, eq).ok);

  r = new RiskOverlay(cfg, eq); r.newDay("2026-05-26");
  r.onOpen("CL/RB", 500); r.onClose("CL/RB", -1600, eq - 1600);   // -3.2% day
  check("HALTS after daily loss limit (-3%)", !r.canEnter("ZC/ZS", 500, eq - 1600).ok && r.state.halted);
  r.newDay("2026-05-27");
  check("daily halt resets next day", r.canEnter("ZC/ZS", 500, eq - 1600).ok);

  r = new RiskOverlay(cfg, eq); r.newDay("2026-05-26");
  r.onOpen("CL/RB", 500); r.onClose("CL/RB", -8000, eq - 8000);   // -16% from peak
  check("KILLS at max drawdown (-15%)", !r.canEnter("ZC/ZS", 500, eq - 8000).ok && r.state.killed);
  r.newDay("2026-05-27");
  check("kill switch persists across days (no auto-reset)", !r.canEnter("ZC/ZS", 500, eq - 8000).ok);

  console.log(`\n  RESULT: ${pass} passed, ${fail} failed — ${fail === 0 ? "✅ risk engine verified" : "⚠️ FIX BEFORE DEPLOY"}\n`);
}
main();
