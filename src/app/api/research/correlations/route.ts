import fs from "node:fs";
import path from "node:path";

/**
 * Cross-asset correlation matrix from local 1m CSVs aggregated to daily closes.
 * Returns pairwise Pearson correlation over the last N days.
 *
 * Why: tells you whether positions are independent or correlated. ES-NQ ≈ 0.95
 * (basically the same bet). MBT-ES ≈ 0.2-0.4 (somewhat independent). GC-ES ≈
 * -0.1 to 0.2 (uncorrelated). Risk management depends on this.
 */

interface DailyClose { date: string; close: number; }

function loadCsv1m(symbol: string, dataDir: string): { ts: number; close: number }[] | null {
  const p = path.join(dataDir, `${symbol}_1m.csv`);
  if (!fs.existsSync(p)) return null;
  const rows = fs.readFileSync(p, "utf8").trim().split("\n").slice(1);
  const out: { ts: number; close: number }[] = [];
  for (const r of rows) {
    const c = r.split(",");
    const ts = new Date(c[0]).getTime();
    const close = parseFloat(c[7]);
    if (!isNaN(ts) && !isNaN(close)) out.push({ ts, close });
  }
  return out;
}

function aggregateDaily(bars: { ts: number; close: number }[]): DailyClose[] {
  const map = new Map<string, number>();
  for (const b of bars) {
    // Use UTC date (rough; good enough for daily correlation)
    const date = new Date(b.ts).toISOString().slice(0, 10);
    map.set(date, b.close); // last close of the day wins
  }
  return [...map.entries()].map(([date, close]) => ({ date, close })).sort((a, b) => a.date.localeCompare(b.date));
}

function logReturns(series: DailyClose[]): number[] {
  const r: number[] = [];
  for (let i = 1; i < series.length; i++) {
    r.push(Math.log(series[i].close / series[i - 1].close));
  }
  return r;
}

function pearson(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  if (n < 5) return NaN;
  const xs = a.slice(-n);
  const ys = b.slice(-n);
  const mx = xs.reduce((s, v) => s + v, 0) / n;
  const my = ys.reduce((s, v) => s + v, 0) / n;
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - mx, dy = ys[i] - my;
    sxy += dx * dy; sxx += dx * dx; syy += dy * dy;
  }
  return sxx > 0 && syy > 0 ? sxy / Math.sqrt(sxx * syy) : NaN;
}

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const days = parseInt(url.searchParams.get("days") || "90", 10);
    const dataDir = path.join(process.cwd(), "data");
    const symbols = ["ES", "NQ", "GC", "MBT", "MET", "BFF"];
    const series: Record<string, DailyClose[]> = {};
    const returns: Record<string, number[]> = {};
    const meta: { symbol: string; bars: number; first: string | null; last: string | null }[] = [];

    for (const sym of symbols) {
      const m1 = loadCsv1m(sym, dataDir);
      if (!m1) { meta.push({ symbol: sym, bars: 0, first: null, last: null }); continue; }
      const daily = aggregateDaily(m1).slice(-days - 1);
      series[sym] = daily;
      returns[sym] = logReturns(daily);
      meta.push({ symbol: sym, bars: daily.length, first: daily[0]?.date ?? null, last: daily[daily.length - 1]?.date ?? null });
    }

    // Pairwise correlation matrix
    const present = symbols.filter((s) => returns[s] && returns[s].length >= 5);
    const matrix: number[][] = [];
    for (const a of present) {
      const row: number[] = [];
      for (const b of present) {
        row.push(a === b ? 1 : pearson(returns[a], returns[b]));
      }
      matrix.push(row);
    }

    return Response.json({
      windowDays: days,
      symbols: present,
      matrix, // present[i] vs present[j] → matrix[i][j]
      meta,
    });
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
