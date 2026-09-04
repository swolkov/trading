// Read-only paper desk dump. Same verdicts as /margin/paper, no writes.
// Needs DATABASE_URL (or POSTGRES_URL) — the production Postgres URL from Vercel.
import { PrismaClient } from "../src/generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { RETIRED_AUTO_SOURCES } from "../src/lib/margin-auto-plans";

const SIM_VERSION = "v2";
const LABELS: Record<string, string> = {
  scanner: "Fast — wide 6% stop — RETIRED Sep 4",
  "fast-tight": "Fast — tight 2% stop — RETIRED",
  "swing-lev": "Leveraged swing — PAUSED Sep 4",
  "swing-spot": "Spot swing — PAUSED Sep 4",
  "sweep-fade": "Liquidity-sweep fade — RETIRED",
  selective: "Selective — HC 5m/15m longs, 3%/48h",
  "selective-swing": "Selective SWING — RETIRED Sep 4",
  manual: "Manual alerts",
};

const RETIRED = RETIRED_AUTO_SOURCES;

function verdict(source: string, resolved: number, net: number, tStat: number | null, days: number): string {
  if (RETIRED.has(source)) return net <= 0 ? "retired — not paying" : "retired — no new entries";
  if (resolved < 30) return `gathering (${resolved}/30)`;
  if (net <= 0) return "not paying";
  if (tStat != null && tStat >= 2) {
    if (days < 7) return `promising — needs ${7 - days} more day(s)`;
    return "REAL EDGE — significant";
  }
  return "promising (could be luck)";
}

function money(n: number): string {
  return `${n < 0 ? "-" : ""}$${Math.abs(Math.round(n)).toLocaleString()}`;
}

async function main() {
  const url = process.env.DATABASE_URL || process.env.POSTGRES_URL;
  if (!url) {
    console.error("No DATABASE_URL / POSTGRES_URL. Add the production Postgres URL from Vercel as a Cursor Runtime Secret.");
    process.exit(2);
  }
  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: url }) } as never);

  const keys = [
    "kraken_margin_auto",
    "kraken_margin_validate_only",
    "kraken_margin_live_max_risk_pct",
    "kraken_margin_max_risk_pct",
    "kraken_margin_max_leverage",
    "kraken_shadow_ref_equity",
    "margin_scan_last_run",
    "margin_watch_last_run",
    "margin_trades_synced_at",
    "tradingview_last_alert",
  ];
  const rows = await prisma.agentConfig.findMany({ where: { key: { in: keys } } });
  const cfg: Record<string, string> = {};
  for (const r of rows) cfg[r.key] = r.value;

  const ago = (v?: string) => {
    if (!v) return "never";
    const m = (Date.now() - Date.parse(v)) / 60000;
    return Number.isFinite(m) ? `${m.toFixed(0)}m ago` : v;
  };

  console.log("SWITCHES");
  console.log(`  auto-trade:    ${cfg.kraken_margin_auto === "true" ? "ARMED" : "OFF (tracked)"}`);
  console.log(`  validate-only: ${cfg.kraken_margin_validate_only !== "false" ? "ON (safe)" : "OFF — LIVE ENTRIES"}`);
  console.log(`  live risk %:   ${cfg.kraken_margin_live_max_risk_pct ?? "unset (code default 3)"}`);
  console.log(`  paper risk %:  ${cfg.kraken_margin_max_risk_pct ?? "unset (code default 3)"}`);
  console.log(`  max leverage:  ${cfg.kraken_margin_max_leverage ?? "unset (code default 5; ladder holds $5k at 2x)"}`);
  console.log("HEARTBEATS");
  console.log(`  scanner:    ${ago(cfg.margin_scan_last_run)}`);
  console.log(`  guardian:   ${ago(cfg.margin_watch_last_run)}`);
  console.log(`  trade sync: ${ago(cfg.margin_trades_synced_at)}`);
  console.log(`  last TV:    ${ago(cfg.tradingview_last_alert)}`);

  const liveBase = Number.parseFloat(cfg.kraken_margin_live_max_risk_pct ?? "");
  const paperBase = Number.parseFloat(cfg.kraken_margin_max_risk_pct ?? "");
  const livePct = Number.isFinite(liveBase) && liveBase > 0 ? Math.min(6, Math.max(0.1, liveBase)) : 3;
  const paperPct = Number.isFinite(paperBase) && paperBase > 0 ? paperBase : 3;

  type Strat = {
    source: string; resolved: bigint; wins: bigint; total: number | null; open: bigint;
    fees: number | null; days: bigint; livenet: number | null; livemean: number | null; livestd: number | null;
  };
  const strategies = await prisma.$queryRawUnsafe<Strat[]>(
    `SELECT COALESCE(source,'manual') AS source,
       count(*) FILTER (WHERE shadow_status='resolved')::bigint AS resolved,
       count(*) FILTER (WHERE shadow_status='resolved' AND shadow_pnl > 0)::bigint AS wins,
       count(*) FILTER (WHERE side IN ('buy','sell') AND COALESCE(shadow_status,'open')='open')::bigint AS open,
       count(DISTINCT date_trunc('day', shadow_resolved_at)) FILTER (WHERE shadow_status='resolved')::bigint AS days,
       COALESCE(sum(shadow_pnl) FILTER (WHERE shadow_status='resolved'),0)::float AS total,
       COALESCE(sum(shadow_fees) FILTER (WHERE shadow_status='resolved'),0)::float AS fees,
       COALESCE(sum(shadow_pnl * (LEAST(6.0, $1::float * CASE conviction WHEN 'high' THEN 2.0 WHEN 'low' THEN 0.5 ELSE 1.0 END)
         / LEAST(6.0, $2::float * CASE conviction WHEN 'high' THEN 2.0 WHEN 'low' THEN 0.5 ELSE 1.0 END)))
         FILTER (WHERE shadow_status='resolved'),0)::float AS livenet,
       avg(shadow_pnl * (LEAST(6.0, $1::float * CASE conviction WHEN 'high' THEN 2.0 WHEN 'low' THEN 0.5 ELSE 1.0 END)
         / LEAST(6.0, $2::float * CASE conviction WHEN 'high' THEN 2.0 WHEN 'low' THEN 0.5 ELSE 1.0 END)))
         FILTER (WHERE shadow_status='resolved') AS livemean,
       stddev_samp(shadow_pnl * (LEAST(6.0, $1::float * CASE conviction WHEN 'high' THEN 2.0 WHEN 'low' THEN 0.5 ELSE 1.0 END)
         / LEAST(6.0, $2::float * CASE conviction WHEN 'high' THEN 2.0 WHEN 'low' THEN 0.5 ELSE 1.0 END)))
         FILTER (WHERE shadow_status='resolved') AS livestd
     FROM tradingview_alerts
     WHERE sim_version='${SIM_VERSION}'
     GROUP BY COALESCE(source,'manual')
     ORDER BY COALESCE(sum(shadow_pnl) FILTER (WHERE shadow_status='resolved'),0) DESC`,
    livePct, paperPct,
  );

  console.log("\nPAPER STRATEGIES (v2, judged at live sizing)");
  console.log("  strategy                         res  open  net(paper)  live-size  days  t     verdict");
  for (const r of strategies) {
    const resolved = Number(r.resolved);
    const liveNet = r.livenet || 0;
    const tStat = resolved > 1 && r.livemean != null && r.livestd != null && r.livestd > 0
      ? (r.livemean * Math.sqrt(resolved)) / r.livestd
      : null;
    const label = (LABELS[r.source] ?? r.source).slice(0, 32).padEnd(32);
    const t = tStat == null ? "  —  " : tStat.toFixed(1).padStart(5);
    console.log(
      `  ${label} ${String(resolved).padStart(4)} ${String(Number(r.open)).padStart(5)}  ${money(r.total || 0).padStart(10)} ${money(liveNet).padStart(10)} ${String(Number(r.days)).padStart(5)} ${t}  ${verdict(r.source, resolved, liveNet, tStat, Number(r.days))}`,
    );
  }

  const tiers = await prisma.$queryRawUnsafe<{ tier: string; resolved: bigint; wins: bigint; total: number | null }[]>(
    `SELECT COALESCE(conviction,'untagged') AS tier,
       count(*)::bigint AS resolved,
       count(*) FILTER (WHERE shadow_pnl > 0)::bigint AS wins,
       COALESCE(sum(shadow_pnl),0)::float AS total
     FROM tradingview_alerts WHERE shadow_status='resolved' AND sim_version='${SIM_VERSION}'
     GROUP BY COALESCE(conviction,'untagged')`,
  );
  console.log("\nCONVICTION (resolved v2, all sleeves — includes retired losers)");
  for (const t of tiers.sort((a, b) => Number(b.total) - Number(a.total))) {
    const n = Number(t.resolved);
    const wr = n ? `${((Number(t.wins) / n) * 100).toFixed(0)}%` : "—";
    console.log(`  ${t.tier.padEnd(8)} n=${String(n).padStart(4)}  hit ${wr.padStart(4)}  ${money(t.total || 0)}`);
  }

  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(String(e).slice(0, 300));
  process.exit(1);
});
