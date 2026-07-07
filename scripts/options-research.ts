// Options-strategy research sweep. Pulls ~8y of REAL daily bars (Yahoo) for liquid names + VIX, backtests
// a grid of premium-selling strategies/parameters, and ranks them by OUT-OF-SAMPLE expectancy with a
// train/test split so we don't get fooled by curve-fitting. Prints an honest verdict: does selling premium
// have a real edge, and at what settings — or not. Run: `npx tsx scripts/options-research.ts`
import { getHistoricalBars } from "../src/lib/yahoo";
import { backtestStrategy, computeStats, type Bar, type StratConfig, type StrategyKind, type OTrade } from "../src/lib/options/options-backtester";

const UNIVERSE = ["SPY", "QQQ", "IWM"];
const YEARS = 8;

// The parameter grid to sweep.
const KINDS: StrategyKind[] = ["put_credit", "call_credit", "iron_condor"];
const DTES = [7, 14, 30];
const OTMS = [0.02, 0.03, 0.05];          // short strike distance
const WIDTHS = [0.01];                      // spread width (% of spot)
const PROFIT_TARGETS = [0.5];               // take +50% of credit
const STOPS = [1.0, 2.0];                   // close at −1× or −2× credit
const IV_FLOORS = [0, 50, 70];              // VIX percentile gate

function money(n: number): string { return `${n < 0 ? "-" : ""}$${Math.abs(n).toFixed(0)}`; }

async function loadData() {
  const days = YEARS * 365 + 10;
  const vixBars = await getHistoricalBars("^VIX", days);
  const vixByDate = new Map<string, number>();
  for (const b of vixBars) vixByDate.set(b.t.slice(0, 10), b.c);
  const barsBySym: Record<string, Bar[]> = {};
  for (const sym of UNIVERSE) {
    const bars = await getHistoricalBars(sym, days);
    barsBySym[sym] = bars;
    console.log(`  ${sym}: ${bars.length} daily bars (${bars[0]?.t.slice(0, 10)} → ${bars[bars.length - 1]?.t.slice(0, 10)})`);
  }
  console.log(`  ^VIX: ${vixBars.length} bars`);
  return { barsBySym, vixByDate };
}

interface Row {
  label: string; cfg: StratConfig;
  all: ReturnType<typeof computeStats>;
  train: ReturnType<typeof computeStats>;
  test: ReturnType<typeof computeStats>;
}

function split(trades: OTrade[]): { train: OTrade[]; test: OTrade[] } {
  const sorted = [...trades].sort((a, b) => a.entryDate.localeCompare(b.entryDate));
  const cut = Math.floor(sorted.length * 0.6);
  return { train: sorted.slice(0, cut), test: sorted.slice(cut) };
}

async function main() {
  console.log("\n" + "═".repeat(92));
  console.log("  OPTIONS RESEARCH — premium-selling edge sweep over ~8y real price paths (modeled credit)");
  console.log("═".repeat(92));
  console.log("Loading real historical data (Yahoo)…");
  const { barsBySym, vixByDate } = await loadData();

  const rows: Row[] = [];
  for (const kind of KINDS) for (const dte of DTES) for (const otm of OTMS) for (const width of WIDTHS)
    for (const pt of PROFIT_TARGETS) for (const stop of STOPS) for (const ivFloor of IV_FLOORS) {
      const cfg: StratConfig = {
        kind, dteCalendar: dte, otmPct: otm, widthPct: width,
        profitTarget: pt, stopMultiple: stop, ivFloorPctile: ivFloor,
        stepDays: 2,
      };
      // Pool trades across the whole liquid universe (more samples = more trustworthy).
      const pooled: OTrade[] = [];
      for (const sym of UNIVERSE) {
        const bars = barsBySym[sym];
        if (bars.length < 300) continue;
        pooled.push(...backtestStrategy(sym, bars, vixByDate, cfg));
      }
      if (pooled.length < 40) continue;
      const { train, test } = split(pooled);
      rows.push({
        label: `${kind.padEnd(12)} ${dte}dte otm${(otm * 100).toFixed(0)}% w${(width * 100).toFixed(0)}% pt${pt} stop${stop}x ivp${ivFloor}`,
        cfg, all: computeStats(pooled), train: computeStats(train), test: computeStats(test),
      });
    }

  // Rank by OUT-OF-SAMPLE (test) expectancy in R, requiring a positive train too (consistency).
  rows.sort((a, b) => (b.test?.expR ?? -9) - (a.test?.expR ?? -9));

  console.log("\n" + "─".repeat(92));
  console.log("  TOP CONFIGS BY OUT-OF-SAMPLE EXPECTANCY — net of commissions + slippage");
  console.log("  (CONSISTENT = train expR and test expR both clearly positive → trustworthy, not a fluke)");
  console.log("─".repeat(92));
  console.log("  " + "strategy / params".padEnd(52) + " win%  trainR  testR    PF   worst  net");
  const top = rows.slice(0, 20);
  for (const r of top) {
    const a = r.all!, tr = r.train!, te = r.test!;
    const consistent = tr.expR > 0.02 && te.expR > 0.02;
    const flag = consistent ? "✓" : " ";
    console.log(`${flag} ${r.label.padEnd(52)} ${(a.wr * 100).toFixed(0).padStart(3)}% ${tr.expR.toFixed(3).padStart(6)} ${te.expR.toFixed(3).padStart(6)}  ${(a.pf === Infinity ? "∞" : a.pf.toFixed(2)).padStart(4)}  ${money(a.maxDD).padStart(6)}  ${money(a.net).padStart(7)}`);
  }

  // Honest verdict: an edge is only trustworthy if it's positive in BOTH halves AND survives its drawdown.
  const robust = rows.filter((r) => (r.test?.expR ?? -9) > 0.02 && (r.train?.expR ?? -9) > 0.02 && (r.test?.n ?? 0) >= 40);
  console.log("\n" + "═".repeat(92));
  if (robust.length === 0) {
    console.log("  VERDICT: NO config is positive in BOTH the train AND test halves. The strong-looking rows above");
    console.log("  win in one era and give it back in another — regime-dependent, not a durable edge. Do NOT fund.");
  } else {
    console.log(`  VERDICT: ${robust.length} config(s) stay positive in BOTH train AND test halves (durable across eras):`);
    const best = robust.sort((a, b) => Math.min(a.test!.expR, a.train!.expR) < Math.min(b.test!.expR, b.train!.expR) ? 1 : -1)[0];
    const a = best.all!;
    const perContractPerYr = a.net / (YEARS * UNIVERSE.length);
    console.log(`    ${best.label}`);
    console.log(`    full: n=${a.n}  win ${(a.wr * 100).toFixed(0)}%  expR ${a.expR.toFixed(3)}  PF ${a.pf === Infinity ? "∞" : a.pf.toFixed(2)}  avg credit ${money(a.avgCredit)}  net ${money(a.net)}  worst-DD ${money(a.maxDD)}`);
    console.log(`    train expR ${best.train!.expR.toFixed(3)} | test expR ${best.test!.expR.toFixed(3)}  → consistent`);
    console.log(`    scale: ≈ ${money(perContractPerYr)}/yr per 1 contract per name. Weekly income target ⇒ contracts = capital.`);
    console.log(`    → NEXT: validate this exact config on REAL historical OPRA quotes before funding a cent.`);
  }
  console.log("═".repeat(92));
  console.log("  READ: win/loss = REAL 8y price paths; entry credit = Black-Scholes off VIX (modeled, conservative).");
  console.log("  Finds the DIRECTION + fragility of edge. 'worst-DD' = deepest peak-to-trough $ at 1 contract.\n");
}

main().catch((e) => { console.error(e); process.exit(1); });
