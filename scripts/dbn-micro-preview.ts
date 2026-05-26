/**
 * MICROSTRUCTURE PREVIEW — confirm cost/access for the order-book data that tests the new-edge frontier
 * (H1 opening-auction imbalance, H4 failed-auction continuation — see EDGE-HIERARCHY Tier 3).
 * Standard plan INCLUDES ~1 month of L2/L3 at $0 marginal cost. This previews cost only — NO download.
 *   npx tsx scripts/dbn-micro-preview.ts
 */
import fs from "node:fs";

function apiKey(): string {
  if (process.env.DATABENTO_API_KEY) return process.env.DATABENTO_API_KEY;
  const m = fs.readFileSync(new URL("../.env.local", import.meta.url), "utf8").match(/^DATABENTO_API_KEY=(.+)$/m);
  if (!m) throw new Error("DATABENTO_API_KEY not found");
  return m[1].trim();
}
const auth = "Basic " + Buffer.from(apiKey() + ":").toString("base64");
const day = (d: Date) => d.toISOString().slice(0, 10);
const end = new Date(Date.now() - 2 * 86_400_000);
const start = new Date(end.getTime() - 14 * 86_400_000);   // last ~2 weeks, inside the included L2/L3 month

async function probe(schema: string, symbols: string): Promise<{ cost: number; size: number }> {
  const body = new URLSearchParams({ dataset: "GLBX.MDP3", symbols, stype_in: "continuous", schema, start: day(start), end: day(end), mode: "historical-streaming" });
  const opt = { method: "POST", headers: { Authorization: auth, "Content-Type": "application/x-www-form-urlencoded" }, body };
  const cr = await fetch("https://hist.databento.com/v0/metadata.get_cost", opt);
  const cost = cr.ok ? parseFloat(await cr.text()) : NaN;
  const sr = await fetch("https://hist.databento.com/v0/metadata.get_record_count", opt).catch(() => null);
  const size = sr && sr.ok ? parseFloat(await sr.text()) : NaN;
  return { cost, size };
}

async function main() {
  console.log("\n" + "═".repeat(78));
  console.log(`  MICROSTRUCTURE PREVIEW — GLBX.MDP3, ${day(start)} → ${day(end)}  (NO download)`);
  console.log("  Tests the Tier-3 frontier: H1 opening-auction imbalance, H4 failed-auction continuation.");
  console.log("═".repeat(78));
  const probes: [string, string, string][] = [
    ["mbp-1", "ES.v.0", "L1 top-of-book (bid/ask/size) — cheapest book data"],
    ["mbp-10", "ES.v.0", "L2 10-level depth — needed for imbalance/absorption (H1/H4)"],
    ["mbp-10", "ES.v.0,NQ.v.0,CL.v.0", "L2 for 3 liquid markets — a real H1/H4 test slice"],
  ];
  for (const [schema, syms, desc] of probes) {
    try {
      const { cost, size } = await probe(schema, syms);
      const recs = isFinite(size) ? (size >= 1e6 ? `${(size / 1e6).toFixed(1)}M recs` : `${size.toFixed(0)} recs`) : "? recs";
      console.log(`\n  ${schema.padEnd(7)} ${syms.padEnd(24)} ${recs.padStart(11)}   usage-rate $${isFinite(cost) ? cost.toFixed(2) : "?"}`);
      console.log(`           ${desc}`);
    } catch (e) { console.log(`  ${schema} ${syms}: error — ${e instanceof Error ? e.message : e}`); }
  }
  console.log("\n  → 'usage-rate $' is the metered price; within the included 1-month L2 window the $179 plan should cover it.");
  console.log("  Next: pull the slice (a fetch like dbn-fetch-intraday but schema=mbp-10) → build the H1/H4 imbalance test.");
  console.log("═".repeat(78) + "\n");
}
main().catch(e => { console.error(e); process.exit(1); });
