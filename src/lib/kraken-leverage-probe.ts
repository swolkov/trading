// ASK KRAKEN WHAT LEVERAGE IT WILL ACTUALLY ACCEPT — validate-only, places nothing.
//
// WHY THIS EXISTS. src/lib/kraken-pairs.ts hardcodes a US-retail leverage table, and there
// is no public source that can confirm it. Kraken's PUBLIC AssetPairs endpoint describes the
// INTERNATIONAL product and genuinely disagrees: it advertises BTC at 10× where Spencer's own
// fills ran 20× on the US venue. So the public feed cannot be trusted upward OR downward, and
// four coins currently differ from it:
//
//   XLM    table 2×   public 5×
//   ALGO   table 2×   public 5×
//   NEAR   table 3×   public 5×
//   RENDER table 3×   public 5×
//
// This is not bookkeeping. Margin is notional ÷ leverage, so a 2× cap makes an XLM position
// cost ~4.5× what an ETH position costs for identical risk — enough that the 150% entry floor
// REFUSES it outright at live size. An understated cap silently deletes a coin from the book.
//
// A validate=true AddOrder is Kraken's own answer to "would you accept this?": it runs every
// server-side check and places NOTHING. Orders go to the US retail venue pair (":BTNL") —
// the plain pair validates fine and then fails for real with EOrder:Reduce only:Non-ECP.
//
// ⚠️ These are PRIVATE calls and share the rate/nonce budget the guardian and executor depend
// on (the collisions behind PR #95). Calls are paced, the probe list is short, and it is
// owner-triggered rather than scheduled — never put this on a cron.
import { krakenPrivate, krakenConfigured, getKrakenPrice } from "@/lib/kraken";
import { marginOrderPairFor, US_MARGIN_MAX_LEVERAGE } from "@/lib/kraken-pairs";

/** Only where the two sources disagree, plus controls we already believe. */
export const PROBE_PLAN: Record<string, number[]> = {
  XLM: [2, 3, 4, 5], ALGO: [2, 3, 4, 5], NEAR: [3, 4, 5], RENDER: [3, 4, 5],
  BTC: [10, 20],   // control: real fills prove 20×. If this fails, the probe is wrong, not the table.
  ETH: [5, 10],    // control: table and public agree at 10×
};

export interface ProbeRow {
  coin: string; table: number; accepted: number[]; maxAccepted: number;
  verdict: "matches" | "table is LOW" | "table is HIGH" | "nothing accepted" | "skipped";
  detail: string;
}

const PACE_MS = 1200;

export async function probeLeverage(plan: Record<string, number[]> = PROBE_PLAN): Promise<{ rows: ProbeRow[]; drift: boolean; note: string }> {
  if (!krakenConfigured()) throw new Error("Kraken keys are not set in this environment");
  const rows: ProbeRow[] = [];
  for (const [coin, levels] of Object.entries(plan)) {
    const table = US_MARGIN_MAX_LEVERAGE[coin] ?? 0;
    const symbol = `${coin}/USD`;
    let px = 0;
    try { px = await getKrakenPrice(symbol); } catch { /* handled below */ }
    if (!(px > 0)) { rows.push({ coin, table, accepted: [], maxAccepted: 0, verdict: "skipped", detail: "price unreadable" }); continue; }
    const pair = marginOrderPairFor(symbol);
    // Deliberately tiny: this is a permission question, not a sizing one.
    const volume = (60 / px).toPrecision(8);
    const accepted: number[] = [];
    const errors: string[] = [];
    for (const lev of levels) {
      try {
        await krakenPrivate("AddOrder", { pair, type: "buy", ordertype: "market", volume, leverage: String(lev), validate: "true" });
        accepted.push(lev);
      } catch (e) {
        errors.push(`${lev}×: ${String(e).slice(0, 60).replace(/\s+/g, " ")}`);
      }
      await new Promise((r) => setTimeout(r, PACE_MS));
    }
    const maxAccepted = accepted.length ? Math.max(...accepted) : 0;
    const verdict: ProbeRow["verdict"] =
      maxAccepted === 0 ? "nothing accepted"
        : maxAccepted === table ? "matches"
          : maxAccepted > table ? "table is LOW"
            : "table is HIGH";
    rows.push({
      coin, table, accepted, maxAccepted, verdict,
      detail: maxAccepted === 0 ? (errors[0] ?? "all rejected")
        : maxAccepted > table ? `raise US_MARGIN_MAX_LEVERAGE.${coin} ${table} → ${maxAccepted}`
          : maxAccepted < table ? `LOWER US_MARGIN_MAX_LEVERAGE.${coin} ${table} → ${maxAccepted}; live orders at ${table}× would be rejected`
            : "no change",
    });
  }
  // "nothing accepted" is never treated as drift: it means the probe could not get an answer
  // (venue closed to the pair, price stale, key scope), and acting on it would DELETE a coin.
  const drift = rows.some((r) => r.verdict === "table is LOW" || r.verdict === "table is HIGH");
  return {
    rows, drift,
    note: drift
      ? "US_MARGIN_MAX_LEVERAGE needs updating — see each row's detail."
      : "The hardcoded table matches what Kraken accepts. No change needed.",
  };
}
