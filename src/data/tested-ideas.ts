// EVERY IDEA WE HAVE TESTED, WITH THE VERDICT (Sep 24 2026). The record behind the rule "an idea without a positive,
// out-of-sample test stays untraded". Numbers are copied from the studies as run; edit an entry only when a new test
// replaces it. Rendered read-only at /research/tested.

export type TestedVerdict = "No edge" | "Inconclusive" | "Useful, not directional" | "Holds in sample — caution";

export interface TestedIdea {
  idea: string;
  /** YYYY-MM-DD, or null when the date was not recorded. */
  tested: string | null;
  markets: string;
  sample: string;
  result: string;
  verdict: TestedVerdict;
  note?: string;
}

export const TESTED_IDEAS: TestedIdea[] = [
  {
    idea: "ICT Setups (liquidity sweep → displacement → MSS → iFVG → retest)",
    tested: "2026-09-24",
    markets: "MES/MNQ/MGC",
    sample: "15 yrs 1m (2011–2026)",
    result: "Full rule −0.10R / −0.20R / −0.08R per trade after fees (MES/MNQ/MGC); negative at every ablation step; TP2/thirds exits did not fix it; 1m precision fires 0–5 times in 15 yrs",
    verdict: "No edge",
    note: "Kept as a chart-reading indicator on TradingView only",
  },
  {
    idea: "Smart Money Concepts pieces (FVG, liquidity sweep, order block)",
    tested: "2026-08-24",
    markets: "ES/NQ/GC",
    sample: "1.4M trades, 15 yrs",
    result: "All nine cells negative; ~33% win at 2R = coin flip minus costs",
    verdict: "No edge",
  },
  {
    idea: "Opening-range breakout",
    tested: "2026-09-19",
    markets: "ES/NQ/GC",
    sample: "15 yrs",
    result: "0 of 192 variants survive",
    verdict: "No edge",
  },
  {
    idea: "4H direction forecasts (trend, breakout, RSI, last bar)",
    tested: "2026-09-23",
    markets: "ES/NQ/GC",
    sample: "15 yrs",
    result: "47–51% right = coin flip. 4H RANGE is forecastable (ATR × time of day)",
    verdict: "Useful, not directional",
    note: "Basis of the Honest Cone indicator (stop sizing, not direction)",
  },
  {
    idea: "Spencer's entry rule, mechanised (paper bot)",
    tested: "2026-09-23",
    markets: "Futures",
    sample: "15 yrs",
    result: "−$280k; 14 of 16 years red",
    verdict: "No edge",
    note: "Paper bot must never go live",
  },
  {
    idea: "2R bracket exit on Spencer's own entries",
    tested: "2026-09-22",
    markets: "—",
    sample: "His 71 live entries",
    result: "+$12.2k vs +$0.3k by hand, but rests on 3 trades (t 0.75 without them)",
    verdict: "Inconclusive",
  },
  {
    idea: "Futures carry",
    tested: "2026-08-23",
    markets: "Futures",
    sample: "15 yrs",
    result: "t = 0.09",
    verdict: "No edge",
  },
  {
    idea: "Trend following (Donchian 100/50, 60m)",
    tested: "2026-08-23",
    markets: "Futures",
    sample: "—",
    result: "t = 2.93, but buy-and-hold beat it 76% of the time",
    verdict: "Holds in sample — caution",
    note: "Risk-managed beta, not alpha",
  },
  {
    idea: "Crypto cross-sectional factors",
    tested: "2026-08-23",
    markets: "Crypto",
    sample: "370 coins",
    result: "All 12 factors negative out of sample",
    verdict: "No edge",
    note: "Crypto desk retired Sep 19",
  },
  {
    idea: "Daily gold oversold-long",
    tested: null,
    markets: "GC",
    sample: "26 yrs daily",
    result: "PF 1.58 in every 5-year block — no-stop variant only",
    verdict: "Holds in sample — caution",
  },
];
