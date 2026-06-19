/**
 * Snapshots the latest spread-book paper-account + forward-report + monthly equity curve
 * into src/data/fund-snapshot.json so the public /fund page renders on Vercel (where /tmp
 * and reports/ don't exist).
 *
 * Run after every spread-track-daily.sh fire to keep the public page fresh.
 *   npx tsx scripts/snapshot-fund-data.ts && git add src/data/fund-snapshot.json && git commit && git push
 */
import fs from "node:fs";
import path from "node:path";

const ROOT = path.dirname(new URL(import.meta.url).pathname).replace(/\/scripts$/, "");
const REPORTS = path.join(ROOT, "reports");
const OUT = path.join(ROOT, "src/data/fund-snapshot.json");

function newestPaperForward(): { path: string; data: unknown } {
  const files = fs.readdirSync(REPORTS)
    .filter((f) => /^paper-forward-.*\.json$/.test(f))
    .map((f) => ({ f, t: fs.statSync(path.join(REPORTS, f)).mtimeMs }))
    .sort((a, b) => b.t - a.t);
  if (!files.length) throw new Error("no paper-forward-*.json in reports/");
  const p = path.join(REPORTS, files[0].f);
  return { path: p, data: JSON.parse(fs.readFileSync(p, "utf8")) };
}

function loadAccount() {
  const p = path.join(REPORTS, "spread-paper-account.json");
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

function loadEquityCurve(account: { curve?: { date: string; equity: number }[] } | null): { month: string; equity: number }[] {
  // Authoritative source: the daily equity `curve` written by scripts/spread-paper-trade.ts into
  // reports/spread-paper-account.json. We down-sample to one point per calendar month (last value
  // wins) for the public chart. (Previously this scraped /tmp/spread-track.log, which is fragile —
  // that file doesn't exist on CI/Vercel and its format changed, so a refresh silently produced an
  // empty curve. Read the JSON the account already persists instead.)
  if (!account?.curve?.length) return [];
  const seen = new Map<string, number>();
  for (const p of account.curve) {
    if (!p?.date || typeof p.equity !== "number") continue;
    seen.set(p.date.slice(0, 7), Math.round(p.equity));
  }
  return [...seen.entries()].map(([month, equity]) => ({ month, equity }));
}

const report = newestPaperForward();
const account = loadAccount();
const equity = loadEquityCurve(account);

const snapshot = {
  generatedAt: new Date().toISOString(),
  sourceReport: path.basename(report.path),
  report: report.data,
  account,
  equityCurve: equity,
};

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(snapshot, null, 2));
console.log(`Snapshot → ${path.relative(ROOT, OUT)}`);
console.log(`  Report: ${path.basename(report.path)}`);
console.log(`  Account equity: $${account?.equity?.toFixed(0) ?? "?"}`);
console.log(`  Equity curve points: ${equity.length}`);
