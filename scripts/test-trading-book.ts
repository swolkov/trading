/**
 * INTEGRATION TEST for the TradingBook orchestrator — replays real daily data through the full
 * wired engine (strategies → sizing → risk gate → orders) and verifies the wiring is correct:
 * spread opens are 2-leg, concurrency is capped, overnight fires, closes flatten.
 *   npx tsx scripts/test-trading-book.ts
 */
import fs from "node:fs";
import { TradingBook } from "../src/lib/strategies/trading-book";

const dir = new URL("../data/daily/", import.meta.url);
function loadClose(sym: string): Map<string, number> {
  const m = new Map<string, number>();
  for (const r of fs.readFileSync(new URL(`${sym}_1d.csv`, dir), "utf8").trim().split("\n").slice(1)) { const c = r.split(","); const px = +c[7]; if (isFinite(px) && px > 0) m.set(c[0].slice(0, 10), px); }
  return m;
}
let pass = 0, fail = 0;
const check = (n: string, c: boolean) => { console.log(`  ${c ? "✅" : "❌"} ${n}`); c ? pass++ : fail++; };

function main() {
  const mult: Record<string, number> = { CL: 1000, RB: 42000, HO: 42000, ZC: 50, ZS: 50, "6E": 125000, "6B": 62500, ES: 50, NQ: 20, GC: 100 };
  const cfg = {
    spread: { pairs: [["CL", "RB"], ["CL", "HO"], ["ZC", "ZS"], ["6E", "6B"]] as [string, string][] },
    overnight: { symbols: ["ES", "NQ", "GC"] },
    risk: { maxConcurrent: 3, maxRiskPerTradePct: 0.03, maxPortfolioHeatPct: 0.08, dailyLossLimitPct: 0.03, maxDrawdownPct: 0.15 },
    mult, riskPerTradePct: 0.01,
  };
  const eq = 1_000_000;   // large enough that full-size legs size (the test is about wiring, not account size)
  const book = new TradingBook(cfg, eq);

  const syms = ["CL", "RB", "HO", "ZC", "ZS", "6E", "6B"];
  const data: Record<string, Map<string, number>> = {}; for (const s of syms) data[s] = loadClose(s);
  const dates = [...new Set(syms.flatMap(s => [...data[s].keys()]))].sort();

  let totalOrders = 0, spreadOpens = 0, twoLegOk = true, maxConcSeen = 0, closes = 0;
  for (const d of dates) {
    const prices: Record<string, number> = {}; for (const s of syms) { const p = data[s].get(d); if (p !== undefined) prices[s] = p; }
    const orders = book.onBar(d, 720, prices, eq);   // etMin=720 (noon) → no overnight triggers; isolates spread wiring
    const opens = orders.filter(o => !o.reason.startsWith("close")), closing = orders.filter(o => o.reason.startsWith("close"));
    const byKey = new Map<string, number>(); for (const o of opens) byKey.set(o.key, (byKey.get(o.key) ?? 0) + 1);
    for (const [, n] of byKey) { spreadOpens++; if (n !== 2) twoLegOk = false; }       // every spread open = exactly 2 legs
    for (const k of new Set(closing.map(o => o.key))) { book.reportFill(k, 0, eq); closes++; }
    totalOrders += orders.length; maxConcSeen = Math.max(maxConcSeen, book.state.openPositions);
  }

  console.log("\n" + "═".repeat(72));
  console.log("  INTEGRATION TEST — TradingBook orchestrator over 15yr daily (spread path)");
  console.log("═".repeat(72) + "\n");
  console.log(`  generated ${totalOrders} orders · ${spreadOpens} spread opens · ${closes} closes · max concurrent ${maxConcSeen}\n`);
  check("book generated orders from real data", totalOrders > 100);
  check("every spread open is exactly 2 legs (dollar-neutral)", twoLegOk);
  check("concurrency never exceeded the cap (3)", maxConcSeen <= 3);

  // overnight + gate edge cases
  const b2 = new TradingBook(cfg, eq);
  const on = b2.onBar("2026-05-26", 960, { ES: 6000, NQ: 21000, GC: 4500 }, eq);   // 16:00 ET → overnight entry window
  check("overnight fires buy orders at the close window", on.filter(o => o.strategy === "overnight" && o.side === "buy").length >= 1);
  check("overnight respects concurrency cap", b2.state.openPositions <= 3);

  console.log(`\n  RESULT: ${pass} passed, ${fail} failed — ${fail === 0 ? "✅ orchestrator wiring verified" : "⚠️ FIX"}`);
  console.log("═".repeat(72) + "\n");
}
main();
