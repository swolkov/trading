/**
 * Spread Forward Track Record — banks the ONE validated edge's forward performance, daily.
 *
 * The relative-value spread book is the only strategy that survived the full falsification battery
 * (paper-forward PASS, +0.43R/trade net of MEASURED cost). It needs ~$100k to *trade*, but *proving*
 * it forward costs $0: re-pull the latest spread-leg bars (included in the Databento plan), re-run the
 * forward eval, append the result to a permanent ledger. A few months of this growing, honest record —
 * not a $1K directional grind the backtest already rejected — is what raises the fund.
 *
 *   npx tsx scripts/spread-track.ts             eval on current data → append a ledger row
 *   npx tsx scripts/spread-track.ts --refresh   pull the latest Databento bars first, then eval
 */
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const REPORTS = `${ROOT}reports`;
const LEDGER = `${REPORTS}/spread-track-record.csv`;
const CAPITAL = 100_000;      // illustrative deployment capital (the edge needs ~$100k to trade)
const RISK_PER_TRADE = 0.01;  // 1% of capital per R — the professional sizing ceiling
const refresh = process.argv.includes("--refresh");

// Shell-free: fixed binary + arg array (no injection surface).
function run(bin: string, args: string[]) {
  console.log(`\n$ ${bin} ${args.join(" ")}`);
  execFileSync(bin, args, { cwd: ROOT, stdio: "inherit" });
}

function newestReport(): string {
  const files = fs.readdirSync(REPORTS)
    .filter(f => /^paper-forward-.*\.json$/.test(f))
    .map(f => ({ f, t: fs.statSync(`${REPORTS}/${f}`).mtimeMs }))
    .sort((a, b) => b.t - a.t);
  if (!files.length) throw new Error("no paper-forward report found — run scripts/paper-forward.ts first");
  return `${REPORTS}/${files[0].f}`;
}

async function main() {
  if (refresh) {
    // paper-forward reads data/daily/ — refresh THAT (daily OHLCV ≈ cents/run), not intraday-1m.
    try { run("npx", ["tsx", "scripts/dbn-fetch-daily.ts"]); }
    catch (e) { console.log(`  [refresh] data pull failed — continuing on existing data: ${e instanceof Error ? e.message : e}`); }
  }
  run("npx", ["tsx", "scripts/paper-forward.ts"]);   // writes reports/paper-forward-<lastData>.json (forward sample grows as data appends)

  const report = JSON.parse(fs.readFileSync(newestReport(), "utf8"));
  const f = report.portfolio.forward as { n: number; exp: number; sharpe: number; maxDD: number; win: number };
  const pairs = report.pairs as Record<string, { forward: { exp: number } }>;
  const total = Object.keys(pairs).length;
  const active = Object.values(pairs).filter(p => p.forward.exp > 0).length;
  const cumR = f.exp * f.n;                          // cumulative forward R, net of measured cost
  const estUsd = cumR * RISK_PER_TRADE * CAPITAL;    // illustrative $ at deployment scale

  const row: Record<string, string | number> = {
    run_date: new Date().toISOString().slice(0, 10),
    data_through: report.lastData,
    forward_start: report.forwardStart,
    n_trades: f.n,
    exp_R: f.exp.toFixed(3),
    sharpe: f.sharpe.toFixed(2),
    maxDD_R: f.maxDD.toFixed(1),
    win_pct: (f.win * 100).toFixed(0),
    active_pairs: `${active}/${total}`,
    cum_R: cumR.toFixed(1),
    verdict: String(report.overall).replace(/[^A-Za-z]/g, ""),
  };
  const cols = Object.keys(row);
  const newLine = cols.map(c => row[c]).join(",");
  const sig = (l: string) => l.split(",").slice(1).join(",");   // compare everything except run_date (col 0)
  const prev = fs.existsSync(LEDGER) ? fs.readFileSync(LEDGER, "utf8").trim().split("\n") : [];
  if (!prev.length) fs.writeFileSync(LEDGER, cols.join(",") + "\n" + newLine + "\n");
  else if (sig(prev[prev.length - 1]) !== sig(newLine)) fs.appendFileSync(LEDGER, newLine + "\n");
  // else: result unchanged since last run → skip (no duplicate row)

  const W = 98;
  console.log("\n" + "═".repeat(W));
  console.log("  SPREAD FORWARD TRACK RECORD   →  reports/spread-track-record.csv");
  console.log("═".repeat(W));
  const lines = fs.readFileSync(LEDGER, "utf8").trim().split("\n");
  for (const l of lines) console.log("  " + l);
  console.log("─".repeat(W));
  console.log(`  Latest: ${active}/${total} pairs working · forward +${f.exp.toFixed(2)}R/trade · Sharpe ${f.sharpe.toFixed(2)} · ${f.n} trades · ${report.overall}`);
  console.log(`  Illustrative P&L: +${cumR.toFixed(0)}R net of cost → at $${CAPITAL / 1000}k & ${RISK_PER_TRADE * 100}%/trade ≈ $${estUsd.toLocaleString(undefined, { maximumFractionDigits: 0 })}  (${report.forwardStart} → ${report.lastData})`);
  console.log(`  NOTE: illustrative only — the edge needs ~$100k to TRADE. This ledger PROVES it forward at $0 so you can fund it.`);
  console.log("═".repeat(W) + "\n");
}
main().catch(e => { console.error(e); process.exit(1); });
