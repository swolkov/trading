// Read-only autopsy of the ONLY paying sleeve. Do not write.
import { PrismaClient } from "../src/generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";

function money(n: number): string {
  return `${n < 0 ? "-" : "+"}$${Math.abs(Math.round(n)).toLocaleString()}`;
}

async function main() {
  const url = process.env.DATABASE_URL || process.env.POSTGRES_URL;
  if (!url) { console.error("no db"); process.exit(2); }
  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: url }) } as never);

  const rows = await prisma.$queryRawUnsafe<{
    id: number; symbol: string; side: string; note: string | null;
    conviction: string | null; conviction_score: number | null;
    shadow_status: string | null; shadow_pnl: number | null;
    shadow_reason: string | null; time: Date; source: string;
  }[]>(
    `SELECT id, symbol, side, note, conviction, conviction_score,
            shadow_status, shadow_pnl, shadow_reason, time, source
     FROM tradingview_alerts
     WHERE sim_version='v2' AND source='selective'
     ORDER BY time ASC`,
  );

  const tfOf = (note: string | null) => {
    const m = note?.match(/\b(5m|15m|1h|4h|1d)\b/);
    return m?.[1] ?? "?";
  };
  const factorsOf = (note: string | null) => {
    const m = note?.match(/\[high(?: — ([^\]]+))?\]/);
    return m?.[1] ?? "";
  };

  const resolved = rows.filter((r) => r.shadow_status === "resolved");
  const open = rows.filter((r) => r.shadow_status !== "resolved");
  console.log(`selective v2: ${rows.length} total, ${resolved.length} resolved, ${open.length} open`);

  const bucket = (keyFn: (r: typeof rows[0]) => string) => {
    const map = new Map<string, { n: number; w: number; pnl: number }>();
    for (const r of resolved) {
      const k = keyFn(r);
      const b = map.get(k) ?? { n: 0, w: 0, pnl: 0 };
      b.n++;
      if ((r.shadow_pnl ?? 0) > 0) b.w++;
      b.pnl += r.shadow_pnl ?? 0;
      map.set(k, b);
    }
    return [...map.entries()].sort((a, b) => b[1].pnl - a[1].pnl);
  };

  const print = (title: string, items: [string, { n: number; w: number; pnl: number }][]) => {
    console.log(`\n${title}`);
    for (const [k, b] of items) {
      const wr = b.n ? `${Math.round((b.w / b.n) * 100)}%` : "—";
      const avg = b.n ? b.pnl / b.n : 0;
      console.log(`  ${k.padEnd(28)} n=${String(b.n).padStart(3)}  hit ${wr.padStart(4)}  ${money(b.pnl).padStart(8)}  avg ${money(avg)}`);
    }
  };

  print("BY TIMEFRAME (from note)", bucket((r) => tfOf(r.note)));
  print("BY SIDE", bucket((r) => r.side));
  print("BY SCORE", bucket((r) => String(r.conviction_score ?? "?")));
  print("BY REASON", bucket((r) => r.shadow_reason ?? "?"));
  print("BY COIN", bucket((r) => r.symbol));
  print("HAS STRETCHED IN NOTE", bucket((r) => factorsOf(r.note).includes("stretched") ? "stretched" : "not stretched"));
  print("MULTI-TF IN NOTE", bucket((r) => /\d+ timeframes/.test(factorsOf(r.note)) ? "multi-tf" : "single-tf"));
  print("VOLUME CONFIRMS", bucket((r) => factorsOf(r.note).includes("volume") ? "volume" : "no volume"));

  print("LONG + HIGH QUALITY CUTS", bucket((r) => {
    if (r.side !== "buy") return "short (excluded)";
    const f = factorsOf(r.note);
    const stretched = f.includes("stretched");
    const vol = f.includes("volume");
    if (stretched) return "long stretched";
    if (!vol) return "long no-volume";
    return "long + vol + not stretched";
  }));

  const recent = await prisma.$queryRawUnsafe<{ source: string; n: bigint; newest: Date }[]>(
    `SELECT source, count(*)::bigint AS n, max(time) AS newest
     FROM tradingview_alerts
     WHERE sim_version='v2' AND time > now() - interval '3 hours'
     GROUP BY source ORDER BY max(time) DESC`,
  );
  console.log("\nOPENS LAST 3h (any source)");
  for (const r of recent) {
    console.log(`  ${(r.source ?? "?").padEnd(20)} n=${r.n}  newest ${r.newest.toISOString()}`);
  }

  const lastSel = await prisma.$queryRawUnsafe<{ time: Date; note: string | null; symbol: string; source: string }[]>(
    `SELECT time, note, symbol, source FROM tradingview_alerts
     WHERE sim_version='v2' AND source IN ('selective','scanner','selective-swing','swing-lev','swing-spot')
     ORDER BY time DESC LIMIT 15`,
  );
  console.log("\nLAST 15 AUTO ROWS");
  for (const r of lastSel) {
    console.log(`  ${r.time.toISOString()}  ${(r.source ?? "").padEnd(16)} ${r.symbol.padEnd(12)} ${r.note}`);
  }

  await prisma.$disconnect();
}

main().catch((e) => { console.error(String(e).slice(0, 400)); process.exit(1); });
