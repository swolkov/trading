// Spencer retired options simulation on September 12, 2026. Historical rows stay archived.
export const OPTIONS_PAPER_RETIRED = true;
export const OPTIONS_MAX_LOSS_KEY = "options_live_max_loss_usd";

export function parseOptionsMaxLoss(raw: string | null | undefined): number | null {
  if (!raw?.trim()) return null;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : null;
}
