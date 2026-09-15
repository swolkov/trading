#!/usr/bin/env tsx
// DERIVATIVES EDGE STUDY — pre-registered on 2026-09-15, BEFORE any stamped row existed.
//
// Reads the paper record (tradingview_alerts, the current cohort, US-tradeable pairs) with the
// deriv_* stamps the margin scan writes at entry (margin-derivatives.ts) and asks three fixed
// questions. Nothing here is a gate; a hypothesis that survives becomes a paper twin first.
//
//   H1  Longs entered while funding ≤ 0 (per 8h, relative) out-earn longs entered at funding > 0.
//       Crowded longs pay to hold; a breakout with the crowd short is the cheaper side.
//   H2  Breakouts with 24h OI RISING (deriv_oi_chg_24h > 0) out-earn breakouts with OI falling.
//       New positions behind a break = participation; a break on falling OI = short covering.
//   H3  LIQUIDATION PROXY: rows entered after an OI DROP ≥5%/24h (positions forced out) do
//       WORSE than the rest — the move is the aftermath of a cascade, not the start of one.
//       (No free liquidation feed exists; the OI drop is the stated proxy.)
//
// IS/OOS: rows ENTERED before REGISTERED_AT + 21 days are in-sample (the hypothesis was named
// before they resolved, but the code that stamps them shipped the same day); rows entered after
// OOS_FROM are the out-of-sample test. A bucket is READ only at MIN_BUCKET resolved rows; the
// script EXITS NON-ZERO when any bucket is thinner than that, so a cron or a human cannot mistake
// "gathering" for a verdict. Verdict words only at |t| ≥ 2 (Welch).
//
// Run: DATABASE_URL=... npx tsx scripts/study-derivatives-edge.ts
import { PrismaClient } from "../src/generated/prisma/client.js";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";
import { RECORD_SQL } from "../src/lib/margin-shadow";
import { OI_DROP_PROXY } from "../src/lib/margin-derivatives";
import { welchT } from "../src/lib/margin-metrics";

export const REGISTERED_AT = "2026-09-15";
export const OOS_FROM = "2026-10-06";   // REGISTERED_AT + 21 days
export const MIN_BUCKET = 30;

interface Row { id: number; time: Date; side: string; source: string | null; pnl: number; funding: number | null; oiChg: number | null; kind: string | null }

function summarise(name: string, a: number[], b: number[], labelA: string, labelB: string): { ok: boolean; line: string } {
  const mean = (xs: number[]) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : NaN);
  const t = welchT(a, b);
  const thin = a.length < MIN_BUCKET || b.length < MIN_BUCKET;
  const verdict = thin ? `gathering (${a.length}/${MIN_BUCKET} vs ${b.length}/${MIN_BUCKET})`
    : t == null ? "no verdict (degenerate variance)"
    : t >= 2 ? `SUPPORTED — ${labelA} beats ${labelB} (t=${t.toFixed(2)})`
    : t <= -2 ? `REJECTED — ${labelB} beats ${labelA} (t=${t.toFixed(2)})`
    : `no difference at this sample (t=${t.toFixed(2)})`;
  const line = `${name}: ${labelA} n=${a.length} mean $${mean(a).toFixed(0)} · ${labelB} n=${b.length} mean $${mean(b).toFixed(0)} → ${verdict}`;
  return { ok: !thin, line };
}

async function main(): Promise<number> {
  const url = process.env.DATABASE_URL;
  if (!url) { console.error("DATABASE_URL is required"); return 2; }
  const prisma = new PrismaClient({ adapter: new PrismaPg(new Pool({ connectionString: url })) });
  try {
    const rows = await prisma.$queryRawUnsafe<Row[]>(
      `SELECT id, time, side, source, shadow_pnl AS pnl, deriv_funding AS funding, deriv_oi_chg_24h AS "oiChg",
              substring(note from 'auto: [a-z0-9-]+ (breakout|breakdown)') AS kind
       FROM tradingview_alerts
       WHERE shadow_status='resolved' AND shadow_pnl IS NOT NULL AND side IN ('buy','sell') AND ${RECORD_SQL}
         AND deriv_source IS NOT NULL
       ORDER BY time`,
    );
    console.log(`Derivatives edge study — registered ${REGISTERED_AT}, OOS from ${OOS_FROM}. ${rows.length} resolved rows carry a derivatives stamp.`);
    let allOk = true;
    for (const [split, pick] of [["IN-SAMPLE", (r: Row) => r.time.toISOString() < OOS_FROM], ["OUT-OF-SAMPLE", (r: Row) => r.time.toISOString() >= OOS_FROM]] as const) {
      const set = rows.filter(pick);
      console.log(`\n== ${split} (${set.length} rows) ==`);
      const longs = set.filter((r) => r.side === "buy" && r.funding != null);
      const h1 = summarise("H1 funding≤0 longs", longs.filter((r) => r.funding! <= 0).map((r) => r.pnl), longs.filter((r) => r.funding! > 0).map((r) => r.pnl), "funding ≤ 0", "funding > 0");
      const breaks = set.filter((r) => r.kind != null && r.oiChg != null);
      const h2 = summarise("H2 breakout + OI up 24h", breaks.filter((r) => r.oiChg! > 0).map((r) => r.pnl), breaks.filter((r) => r.oiChg! <= 0).map((r) => r.pnl), "OI rising", "OI flat/falling");
      const withOi = set.filter((r) => r.oiChg != null);
      const h3 = summarise("H3 OI-drop proxy (≥5%/24h)", withOi.filter((r) => r.oiChg! > OI_DROP_PROXY).map((r) => r.pnl), withOi.filter((r) => r.oiChg! <= OI_DROP_PROXY).map((r) => r.pnl), "no cascade", "after an OI drop");
      for (const h of [h1, h2, h3]) { console.log(h.line); allOk = allOk && h.ok; }
    }
    if (!allOk) { console.log("\nAt least one bucket is under 30 resolved — GATHERING, not a verdict (exit 1)."); return 1; }
    return 0;
  } finally {
    await prisma.$disconnect();
  }
}

main().then((code) => process.exit(code)).catch((e) => { console.error(e); process.exit(2); });
