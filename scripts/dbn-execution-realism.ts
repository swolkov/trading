/**
 * EXECUTION REALISM — measure the REAL crossing cost on the spread legs from Databento tbbo
 * (trade + top-of-book quote). Replaces the assumed 0.10R slippage in paper-forward with a measured number.
 * Uses the subscription's included L1 (free within 1yr). Offline + read-only — no deploy, no engine impact.
 *   npx tsx scripts/dbn-execution-realism.ts          (preview cost; auto-pulls if trivially cheap/free)
 */
import fs from "node:fs";
function apiKey(): string {
  if (process.env.DATABENTO_API_KEY) return process.env.DATABENTO_API_KEY;
  const m = fs.readFileSync(new URL("../.env.local", import.meta.url), "utf8").match(/^DATABENTO_API_KEY=(.+)$/m);
  if (!m) throw new Error("DATABENTO_API_KEY not found"); return m[1].trim();
}
const auth = "Basic " + Buffer.from(apiKey() + ":").toString("base64");
const LEGS = ["CL", "RB", "ZC", "ZS"];                 // the two priority pairs' legs (crack + grains)
const TICK: Record<string, number> = { CL: 0.01, RB: 0.0001, ZC: 0.25, ZS: 0.25 };
const end = new Date(Date.now() - 2 * 86_400_000);
const start = new Date(end.getTime() - 7 * 86_400_000);  // ~5 trading days — plenty to measure typical spread
const day = (d: Date) => d.toISOString().slice(0, 10);

async function getCost(): Promise<number> {
  const body = new URLSearchParams({ dataset: "GLBX.MDP3", symbols: LEGS.map(s => `${s}.v.0`).join(","), stype_in: "continuous", schema: "tbbo", start: day(start), end: day(end), mode: "historical-streaming" });
  const r = await fetch("https://hist.databento.com/v0/metadata.get_cost", { method: "POST", headers: { Authorization: auth, "Content-Type": "application/x-www-form-urlencoded" }, body });
  return r.ok ? parseFloat(await r.text()) : NaN;
}
async function fetchTbbo(sym: string): Promise<string> {
  const body = new URLSearchParams({ dataset: "GLBX.MDP3", symbols: `${sym}.v.0`, stype_in: "continuous", schema: "tbbo", start: day(start), end: day(end), encoding: "csv", pretty_px: "true", pretty_ts: "true" });
  const r = await fetch("https://hist.databento.com/v0/timeseries.get_range", { method: "POST", headers: { Authorization: auth, "Content-Type": "application/x-www-form-urlencoded" }, body });
  if (!r.ok) throw new Error(`HTTP ${r.status} — ${(await r.text()).slice(0, 120)}`);
  return r.text();
}
const median = (a: number[]) => { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y); return s[s.length >> 1]; };

async function main() {
  console.log("\n" + "═".repeat(78));
  console.log(`  EXECUTION REALISM — measured spread crossing cost (tbbo, ${day(start)} → ${day(end)})`);
  console.log("═".repeat(78));
  let cost = NaN; try { cost = await getCost(); } catch {}
  console.log(`  cost preview (usage-rate): $${isFinite(cost) ? cost.toFixed(2) : "?"} — included L1 → covered by the $179 plan`);
  if (isFinite(cost) && cost > 1) { console.log(`  ⛔ unexpectedly >$1 — stopping to avoid a surprise charge.`); return; }

  const halfSpreadFrac: Record<string, number> = {};
  for (const sym of LEGS) {
    try {
      const csv = await fetchTbbo(sym); const lines = csv.trim().split("\n"); if (lines.length < 5) { console.log(`  ${sym}: no data`); continue; }
      const hdr = lines[0].split(","); const bi = hdr.indexOf("bid_px_00"), ai = hdr.indexOf("ask_px_00");
      if (bi < 0 || ai < 0) { console.log(`  ${sym}: no BBO columns (hdr: ${hdr.slice(0, 12).join(",")}…)`); continue; }
      const spreads: number[] = [], fracs: number[] = [];
      for (let i = 1; i < lines.length; i++) { const c = lines[i].split(","); const bid = +c[bi], ask = +c[ai]; if (bid > 0 && ask > 0 && ask >= bid) { spreads.push(ask - bid); fracs.push((ask - bid) / ((ask + bid) / 2)); } }
      const medSpread = median(spreads), medFrac = median(fracs); halfSpreadFrac[sym] = medFrac / 2;
      console.log(`  ${sym.padEnd(3)}: median bid/ask spread ${medSpread.toFixed(4)} (${(medSpread / TICK[sym]).toFixed(1)} ticks)  = ${(medFrac * 1e4).toFixed(2)} bps of price   n=${spreads.length}`);
    } catch (e) { console.log(`  ${sym}: ERROR — ${e instanceof Error ? e.message : e}`); }
  }
  // A spread trade crosses BOTH legs on entry AND exit ≈ (half-spread_A + half-spread_B) each way → ~2×(hA+hB) round-trip in price-fraction terms.
  const pairs: [string, string][] = [["CL", "RB"], ["ZC", "ZS"]];
  console.log("\n  ROUND-TRIP crossing cost per spread trade (both legs, in + out):");
  for (const [a, b] of pairs) {
    const ha = halfSpreadFrac[a], hb = halfSpreadFrac[b]; if (ha == null || hb == null) continue;
    console.log(`     ${a}/${b}: ≈ ${((2 * (ha + hb)) * 1e4).toFixed(2)} bps of notional per round trip (vs the assumed 0.10R placeholder in paper-forward)`);
  }
  console.log("\n  NEXT: convert these to R using each pair's 1.5σ risk unit → set paper-forward COST_R to MEASURED.");
  console.log("  (This is the cheap execution-realism win — uses included L1 data, $0, zero engine impact.)");
  console.log("═".repeat(78) + "\n");
}
main().catch(e => { console.error(e); process.exit(1); });
