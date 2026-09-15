// ADVERSE EXCURSION (Sep 15 2026) — the paper record's MAE, the mirror of the MFE it has always
// kept. shadow_peak is the best price a trade reached; shadow_trough is the worst. Together with
// 1R they answer the two post-trade questions the operating spec asks of every trade: how far
// did it go our way before the exit (MFE, give-back), and how close did it come to the stop
// before it worked (MAE — a winner that touched −0.9R is a different trade from one that never
// looked back, and a stop that is never approached by winners is a stop that could be tighter,
// which this account has ALREADY measured as a loser; the number is for the journal, not a knob).
//
// Pure: no I/O. The evaluator (margin-shadow.ts) walks completed 1-min bars oldest-first and
// updates the trough BEFORE each bar's stop test, so a stop-out's fatal bar counts as adverse
// excursion; the guardian mirrors it on the live book (margin-watch managed[book].trough).
export interface ExcursionBar { h: number; l: number }

/** The worse of the trough so far and this bar's adverse extreme: a long's low, a short's high. */
export function troughUpdate(dir: 1 | -1, trough: number, bar: ExcursionBar): number {
  if (dir > 0) return Number.isFinite(bar.l) ? Math.min(trough, bar.l) : trough;
  return Number.isFinite(bar.h) ? Math.max(trough, bar.h) : trough;
}

/**
 * MAE in R: how far the trade went AGAINST the entry, as a positive number of R (0 = never
 * traded below/above the entry). dir × (entry − trough) ÷ 1R, floored at 0 — a trough on the
 * favourable side of the entry (a trade that only ever went our way) is 0, never negative.
 * Note margin-metrics's maeR is the SIGNED form (≤ 0) computed from the trough itself; this
 * column is the magnitude the journal prints.
 */
export function maeR(dir: 1 | -1, entry: number, trough: number, oneR: number): number | null {
  if (!(entry > 0) || !(oneR > 0) || !Number.isFinite(trough)) return null;
  return Math.max(0, (dir * (entry - trough)) / oneR);
}

/** MFE in R, the same way round: how far the trade went FOR the entry (≥ 0). */
export function mfeR(dir: 1 | -1, entry: number, peak: number, oneR: number): number | null {
  if (!(entry > 0) || !(oneR > 0) || !Number.isFinite(peak)) return null;
  return Math.max(0, (dir * (peak - entry)) / oneR);
}
