/** Verifies the edge filter confirms proven edges and vetoes proven losers. npx tsx scripts/test-edge-filter.ts */
import { edgeFilter } from "../src/lib/strategies/edge-filter";

let pass = 0, fail = 0;
const t = (name: string, c: boolean) => { console.log(`  ${c ? "✅" : "❌"} ${name}`); c ? pass++ : fail++; };

console.log("\n  EDGE FILTER — research-armed confirmation (what to take / veto)\n");
t("VETO: NQ RSI-bounce scalp (lost every year)", !edgeFilter({ instrument: "MNQ", setup: "RSI bounce", dir: "long" }).confirm);
t("VETO: ES trend-continuation", !edgeFilter({ instrument: "MES", setup: "trend continuation", dir: "long" }).confirm);
t("VETO: opening-drive (coin flip)", !edgeFilter({ instrument: "MES", setup: "opening drive", dir: "long" }).confirm);
t("CONFIRM: spread (Sharpe ~1)", edgeFilter({ instrument: "CL", setup: "spread", dir: "short" }).confirm);
t("CONFIRM: overnight drift", edgeFilter({ instrument: "MGC", setup: "overnight", dir: "long" }).confirm);
t("CONFIRM: gold RSI-bounce (the one intraday edge)", edgeFilter({ instrument: "MGC", setup: "RSI bounce", dir: "long", rsi: 18 }).confirm);
t("gold deep-extreme gets higher conviction", edgeFilter({ instrument: "MGC", setup: "RSI bounce", dir: "long", rsi: 18 }).conviction > edgeFilter({ instrument: "MGC", setup: "RSI bounce", dir: "long", rsi: 30 }).conviction);

console.log(`\n  RESULT: ${pass} passed, ${fail} failed — ${fail === 0 ? "✅ research-armed filter verified" : "⚠️ FIX"}`);
console.log("\n  KEY POINT: this filter VETOES the scalping trades a $1K micro account can take —");
console.log("  so arming the AI score makes it MORE selective, not a $1K rescuer.\n");
