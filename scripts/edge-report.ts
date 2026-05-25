/**
 * EDGE REPORT — honest performance/edge measurement for the futures engines.
 *
 * Design principles (so the number can't lie to you):
 *  - TRUTH = balance-delta. Net account P&L from start-of-day/EOD balance snapshots,
 *    which already includes commissions + slippage. This is the bottom line.
 *  - Per-trade EDGE uses ONLY reconciled real fills (reconciledAt set). Estimated/
 *    unconfirmed trades are counted but flagged and excluded from the verdict.
 *  - Pre-2026-05-24 futures trades were PHANTOM (never filled) — excluded from edge.
 *  - No verdict on a small sample. <20 reconciled round-trips ⇒ "INSUFFICIENT DATA".
 *
 * Run:  npx tsx scripts/edge-report.ts
 */
import fs from "node:fs";
import pg from "pg";

const QUARANTINE = "2026-05-24";        // futures data before this was phantom/unfilled
const MIN_SAMPLE = 20;                  // reconciled round-trips needed for a verdict
const EST_COMMISSION_RT = 3.0;          // est. round-turn commission/contract ($) for a fees-adjusted view

function dbUrl(): string {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  const env = fs.readFileSync(new URL("../.env.vercel", import.meta.url), "utf8");
  const m = env.match(/^DATABASE_URL="?([^"\n]+)"?/m);
  if (!m) throw new Error("DATABASE_URL not found");
  return m[1];
}
const money = (n: number) => `${n < 0 ? "-" : ""}$${Math.abs(n).toFixed(2)}`;
const pct = (n: number) => `${(n * 100).toFixed(1)}%`;

interface RT { mode: "demo" | "live"; symbol: string; setup: string; risk: number | null; pnl: number; reconciled: boolean; date: Date; }

function parseSetup(reason: string): string {
  const r = reason.toLowerCase();
  if (r.includes("or breakout") || r.includes("opening range")) return "OR breakout";
  if (r.includes("rsi") && (r.includes("bounce") || r.includes("oversold") || r.includes("overbought"))) return "RSI reversion";
  if (r.includes("gap fill")) return "gap fill";
  if (r.includes("ib ext") || r.includes("initial balance")) return "IB extension";
  if (r.includes("range bounce") || r.includes("range")) return "range bounce";
  if (r.includes("trend") || r.includes("continuation")) return "trend continuation";
  if (r.includes("momentum") || r.includes("breakout")) return "momentum";
  if (r.includes("mean reversion") || r.includes("vwap")) return "mean reversion";
  return "other";
}
function parseRisk(reason: string): number | null {
  const m = reason.match(/Risk:\s*\$?([\d,.]+)/i);
  return m ? parseFloat(m[1].replace(/,/g, "")) : null;
}

function metrics(trips: RT[]) {
  const n = trips.length;
  if (n === 0) return null;
  const wins = trips.filter((t) => t.pnl > 0);
  const losses = trips.filter((t) => t.pnl < 0);
  const gross = trips.reduce((s, t) => s + t.pnl, 0);
  const grossWin = wins.reduce((s, t) => s + t.pnl, 0);
  const grossLoss = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));
  const avgWin = wins.length ? grossWin / wins.length : 0;
  const avgLoss = losses.length ? grossLoss / losses.length : 0;
  const expectancy = gross / n;
  const feesAdj = (gross - n * EST_COMMISSION_RT) / n; // subtract est round-turn commission/trade
  const rTrips = trips.filter((t) => t.risk && t.risk > 0);
  const expR = rTrips.length ? rTrips.reduce((s, t) => s + t.pnl / (t.risk as number), 0) / rTrips.length : null;
  // max drawdown over the equity curve of these trips (chronological)
  let peak = 0, cum = 0, maxDD = 0;
  for (const t of [...trips].sort((a, b) => a.date.getTime() - b.date.getTime())) {
    cum += t.pnl; peak = Math.max(peak, cum); maxDD = Math.min(maxDD, cum - peak);
  }
  return {
    n, winRate: wins.length / n, avgWin, avgLoss,
    winLossRatio: avgLoss ? avgWin / avgLoss : 0,
    expectancy, expectancyNetFees: feesAdj, expR,
    profitFactor: grossLoss ? grossWin / grossLoss : (grossWin > 0 ? Infinity : 0),
    netPnl: gross, maxDD,
  };
}

async function main() {
  const c = new pg.Client({ connectionString: dbUrl(), ssl: { rejectUnauthorized: false } });
  await c.connect();
  console.log("\n" + "═".repeat(64));
  console.log(`  EDGE REPORT — ${new Date().toISOString().replace("T", " ").slice(0, 19)} UTC`);
  console.log("═".repeat(64));

  // ── 1. TRUTH: balance-delta per mode ──────────────────────────────
  const bal = await c.query(
    `SELECT key, value FROM "AgentConfig" WHERE key ~ '^(live_)?(daily|eod)_balance_\\d{4}-\\d{2}-\\d{2}$'`);
  const series: Record<"demo" | "live", { date: string; bal: number }[]> = { demo: [], live: [] };
  for (const r of bal.rows) {
    const mode: "demo" | "live" = r.key.startsWith("live_") ? "live" : "demo";
    const date = r.key.slice(-10);
    const v = parseFloat(r.value);
    if (!isNaN(v)) series[mode].push({ date, bal: v });
  }
  console.log("\n── BOTTOM LINE: account balance-delta (net of ALL fees + slippage — the truth) ──");
  for (const mode of ["demo", "live"] as const) {
    const raw = [...new Map(series[mode].map((x) => [x.date, x])).values()].sort((a, b) => a.date.localeCompare(b.date));
    if (raw.length < 1) { console.log(`  ${mode.toUpperCase()}: no balance snapshots`); continue; }
    // Drop implausible snapshots (the old demo→live key leak once wrote $50K into a live key).
    const med = [...raw].map((x) => x.bal).sort((a, b) => a - b)[Math.floor(raw.length / 2)];
    const s = raw.filter((x) => x.bal >= med / 3 && x.bal <= med * 3);
    const dropped = raw.length - s.length;
    if (s.length < 1) { console.log(`  ${mode.toUpperCase()}: no plausible snapshots`); continue; }
    const start = s[0].bal, end = s[s.length - 1].bal;
    let peak = s[0].bal, maxDD = 0;
    for (const p of s) { peak = Math.max(peak, p.bal); maxDD = Math.min(maxDD, p.bal - peak); }
    const movedDays = s.filter((p, i) => i > 0 && p.bal !== s[i - 1].bal).length;
    console.log(`  ${mode.toUpperCase().padEnd(4)}: ${money(start)} → ${money(end)}  net ${money(end - start)} (${pct((end - start) / start)})  | maxDD ${money(maxDD)} | ${s.length} snapshots, ${movedDays} days w/ movement${dropped ? ` (dropped ${dropped} corrupt)` : ""}`);
  }

  // ── 2. PER-TRADE EDGE: reconciled round-trips ─────────────────────
  const tr = await c.query(
    `SELECT "createdAt", symbol, action, qty, pnl, "fillPrice", "reconciledAt", reason
     FROM "AutoTradeLog"
     WHERE (action LIKE 'futures_%' OR action LIKE 'live_%') AND "createdAt" >= $1
     ORDER BY "createdAt"`, [QUARANTINE]);

  const open: Record<string, { setup: string; risk: number | null }[]> = {};
  const trips: RT[] = [];
  for (const r of tr.rows) {
    const mode: "demo" | "live" = r.action.startsWith("live_") ? "live" : "demo";
    const key = `${mode}:${r.symbol}`;
    const isEntry = /_(long|short)$/.test(r.action);
    if (isEntry) {
      (open[key] ||= []).push({ setup: parseSetup(r.reason || ""), risk: parseRisk(r.reason || "") });
    } else if (r.pnl != null) {
      const e = (open[key] ||= []).shift();
      trips.push({
        mode, symbol: r.symbol, setup: e?.setup || "unknown", risk: e?.risk ?? null,
        pnl: Number(r.pnl), reconciled: r.reconciledAt != null, date: new Date(r.createdAt),
      });
    }
  }

  const reconciled = trips.filter((t) => t.reconciled);
  const estimated = trips.filter((t) => !t.reconciled);
  console.log(`\n── PER-TRADE EDGE (since ${QUARANTINE}; reconciled real fills only) ──`);
  console.log(`  round-trips: ${trips.length} total → ${reconciled.length} reconciled (real), ${estimated.length} estimated/unconfirmed (excluded from verdict)`);

  for (const mode of ["demo", "live"] as const) {
    const m = metrics(reconciled.filter((t) => t.mode === mode));
    if (!m) { console.log(`\n  ${mode.toUpperCase()}: 0 reconciled round-trips`); continue; }
    console.log(`\n  ${mode.toUpperCase()} (n=${m.n}):`);
    console.log(`    win rate ${pct(m.winRate)} | avg win ${money(m.avgWin)} | avg loss ${money(m.avgLoss)} | W/L ${m.winLossRatio.toFixed(2)}`);
    console.log(`    expectancy ${money(m.expectancy)}/trade (${money(m.expectancyNetFees)} after est fees) ${m.expR != null ? `| ${m.expR.toFixed(2)}R` : ""}`);
    console.log(`    profit factor ${m.profitFactor === Infinity ? "∞" : m.profitFactor.toFixed(2)} | net ${money(m.netPnl)} | maxDD ${money(m.maxDD)}`);
    // by setup
    const bySetup = [...new Set(reconciled.filter((t) => t.mode === mode).map((t) => t.setup))];
    for (const s of bySetup) {
      const sm = metrics(reconciled.filter((t) => t.mode === mode && t.setup === s));
      if (sm) console.log(`      • ${s.padEnd(18)} n=${String(sm.n).padStart(3)}  win ${pct(sm.winRate).padStart(6)}  exp ${money(sm.expectancy).padStart(9)}  net ${money(sm.netPnl)}`);
    }
  }

  // ── 3. VERDICT ────────────────────────────────────────────────────
  console.log("\n── VERDICT ──");
  const realN = reconciled.length;
  if (realN < MIN_SAMPLE) {
    console.log(`  ⏳ INSUFFICIENT DATA — ${realN}/${MIN_SAMPLE} reconciled round-trips. No edge conclusion possible yet.`);
    console.log(`     The instrument is ready; it populates as real, reconciled trades accumulate.`);
    console.log(`     (Reminder: balance-delta above is the real account truth regardless of trade count.)`);
  } else {
    const dm = metrics(reconciled.filter((t) => t.mode === "demo"));
    const lm = metrics(reconciled.filter((t) => t.mode === "live"));
    for (const [label, m] of [["DEMO", dm], ["LIVE", lm]] as const) {
      if (!m) continue;
      const edge = m.expectancyNetFees > 0 && m.profitFactor > 1.1;
      console.log(`  ${label}: ${edge ? "✅ POSITIVE expectancy (net of est fees)" : "❌ NO edge — flat/negative after costs"} — exp ${money(m.expectancyNetFees)}/trade, PF ${m.profitFactor.toFixed(2)}, n=${m.n}`);
    }
    console.log(`     Note: ${realN} trades is a start; trust grows with sample. Watch for stability across regimes + out-of-sample.`);
  }

  // crypto/stocks footnote
  const cs = await c.query(
    `SELECT count(*) FILTER (WHERE symbol LIKE 'CRY:%') crypto, count(*) FILTER (WHERE symbol LIKE 'STK:%') stocks
     FROM "AutoTradeLog" WHERE "createdAt" >= $1`, [QUARANTINE]);
  console.log(`\n  (Alpaca since ${QUARANTINE}: ${cs.rows[0].crypto} crypto rows, ${cs.rows[0].stocks} stock rows — paper)`);
  console.log("═".repeat(64) + "\n");
  await c.end();
}
main().catch((e) => { console.error("edge-report failed:", e); process.exit(1); });
