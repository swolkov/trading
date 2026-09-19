// Small pure statistics shared across desks. Lived in the retired margin desk's
// `margin-metrics.ts` until Sep 19 2026; the options score ledger still needs Welch's t.

export const mean = (a: number[]) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : NaN);

export const sampleSd = (a: number[]) => {
  if (a.length < 2) return NaN;
  const m = mean(a);
  return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1));
};

/** Welch's t between two samples (unequal variances); null when either side is too small or degenerate. */
export function welchT(a: number[], b: number[]): number | null {
  if (a.length < 2 || b.length < 2) return null;
  const va = sampleSd(a) ** 2, vb = sampleSd(b) ** 2;
  const se = Math.sqrt(va / a.length + vb / b.length);
  if (!(se > 0) || !Number.isFinite(se)) return null;
  return (mean(a) - mean(b)) / se;
}
