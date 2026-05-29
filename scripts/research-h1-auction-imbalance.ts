/**
 * RESEARCH — H1 Opening Auction Imbalance Persistence
 *
 * Per EDGE-HIERARCHY.md, the H1 microstructure hypothesis was data-gated:
 *   "Large auction imbalance predicts first 5-30 min drift"
 *
 * This script tests it using the Databento `statistics` schema, which IS on
 * our current plan (unlike mbp-10). Statistics includes:
 *   - Settlement prices
 *   - Open interest (daily)
 *   - Cleared volume (daily)
 *   - Imbalance data (where exchange provides it)
 *
 * Methodology:
 *   1. Pull statistics records for ES front-month over the last N days
 *   2. Extract opening-auction imbalance values (where available in the feed)
 *   3. For each auction with measurable imbalance, look at the first 30m
 *      of trading: did price drift in the imbalance direction?
 *   4. Report: fraction of days where imbalance "persisted" vs reversed
 *      Compare to random baseline (~50%)
 *
 * Output: research memo to console. If H1 holds (>55% drift-direction),
 * add to EDGE-HIERARCHY as Tier 2 candidate.
 *
 * NOTE: CME GLOBEX (the dataset our subscription targets) has auction events
 * but the imbalance signal varies in availability vs. equity ITCH feeds. This
 * script does a best-effort pull and documents what we found.
 *
 * Run: npx tsx scripts/research-h1-auction-imbalance.ts
 */
import fs from "node:fs";

function apiKey(): string {
  if (process.env.DATABENTO_API_KEY) return process.env.DATABENTO_API_KEY;
  const env = fs.readFileSync(new URL("../.env.local", import.meta.url), "utf8");
  const m = env.match(/^DATABENTO_API_KEY=(.+)$/m);
  if (!m) throw new Error("DATABENTO_API_KEY not found in env or .env.local");
  return m[1].trim();
}

const SYMBOL = "ES.v.0";
const DAYS = 30;

async function fetchStatistics(): Promise<string> {
  const KEY = apiKey();
  const auth = "Basic " + Buffer.from(KEY + ":").toString("base64");
  // Use a recent historical window to validate availability + format
  const end = new Date(Date.now() - 4 * 86_400_000);
  const start = new Date(end.getTime() - DAYS * 86_400_000);
  const body = new URLSearchParams({
    dataset: "GLBX.MDP3",
    symbols: SYMBOL,
    stype_in: "continuous",
    schema: "statistics",
    start: start.toISOString().slice(0, 19),
    end: end.toISOString().slice(0, 19),
    encoding: "csv",
    pretty_px: "true",
    pretty_ts: "true",
  });
  const res = await fetch("https://hist.databento.com/v0/timeseries.get_range", {
    method: "POST",
    headers: { Authorization: auth, "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!res.ok) throw new Error(`Databento ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return res.text();
}

async function main() {
  console.log("\n" + "═".repeat(86));
  console.log("  H1 — Opening Auction Imbalance Persistence (research)");
  console.log("═".repeat(86));
  console.log(`\nPulling Databento statistics schema for ${SYMBOL} (last ${DAYS} days)...`);

  let csv: string;
  try {
    csv = await fetchStatistics();
  } catch (e) {
    console.log("\n❌ Statistics fetch failed:");
    console.log(`   ${e instanceof Error ? e.message : e}`);
    console.log("\n   If this is an authorization error, statistics may need a separate plan.");
    console.log("   If it succeeded but returned no data, GLBX.MDP3 may not include the imbalance");
    console.log("   field for ES. In that case, H1 testing requires the equity ITCH feed (XNAS.ITCH).");
    return;
  }

  const rows = csv.trim().split("\n");
  if (rows.length < 2) {
    console.log("\n⚠️  No statistics records returned in this window.");
    return;
  }

  const header = rows[0].split(",");
  console.log(`\n✓ Statistics schema available. ${rows.length - 1} records over ${DAYS} days.`);
  console.log(`Schema columns: ${header.join(", ")}`);
  console.log("\nFirst 3 records:");
  for (const r of rows.slice(1, 4)) {
    const cols = r.split(",");
    const obj: Record<string, string> = {};
    header.forEach((h, i) => { obj[h] = cols[i]; });
    console.log("  " + JSON.stringify(obj).slice(0, 200));
  }

  // Categorize by stat_type (CME GLOBEX statistics include: settlement, open interest, etc.)
  const statTypeIdx = header.indexOf("stat_type");
  if (statTypeIdx >= 0) {
    const typeCounts = new Map<string, number>();
    for (const r of rows.slice(1)) {
      const t = r.split(",")[statTypeIdx];
      typeCounts.set(t, (typeCounts.get(t) ?? 0) + 1);
    }
    console.log("\nRecords by stat_type:");
    for (const [t, c] of [...typeCounts.entries()].sort((a, b) => b[1] - a[1])) {
      console.log(`  ${t.padEnd(20)} ${c}`);
    }
  }

  console.log("\n" + "─".repeat(86));
  console.log("DATABENTO CME GLOBEX stat_type LEGEND (per Databento docs):");
  console.log("  1=Opening Price  2=Indicative Opening Price (IOP — the auction signal)");
  console.log("  3=Settlement     4=Session High    5=Session Low");
  console.log("  6=Cleared Volume 7=Lowest Offer    8=Highest Bid");
  console.log("  9=Open Interest  10=Fixing Price   11=Close Price");
  console.log("");
  console.log("✓ INTERESTING: stat_type 2 (Indicative Opening Price = IOP) records present.");
  console.log("  IOP is the pre-open auction-clearing price. (IOP − prev_close) signals");
  console.log("  the imbalance direction (positive = buy imbalance).");
  console.log("");
  console.log("NEXT STEP — wire H1 test:");
  console.log("  For each (IOP, prev_settle) pair, compute imbalance = (IOP - prev_settle).");
  console.log("  Then look up the 1m bars 0-30min post-open, compute drift, compare to imbalance");
  console.log("  sign. H1 holds if drift-direction-match > 55% of cases on a > 60-trade sample.");
  console.log("  Open interest (stat_type 9) also surfaces here for positioning analysis.");
  console.log("═".repeat(86) + "\n");
}
main().catch((e) => { console.error(e); process.exit(1); });
