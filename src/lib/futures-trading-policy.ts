export const FULL_SIZE_FUTURES = ["GC", "NQ", "ES"] as const;
export const MICRO_FUTURES = ["MGC", "MNQ", "MES"] as const;

const METALS = new Set(["GC", "MGC"]);

export function isEngineLeaseValid(ownsLease: boolean, validUntil: number, now = Date.now()): boolean {
  return ownsLease && Number.isFinite(validUntil) && validUntil > now;
}

export function isBrokerAccountClear(
  positions: readonly { netPos: number }[],
  orders: readonly { ordStatus: string }[],
): boolean {
  return positions.every((position) => position.netPos === 0)
    && orders.every((order) => order.ordStatus !== "Working" && order.ordStatus !== "Accepted");
}

export interface SymbolSelectionInput {
  mode: "demo" | "live";
  accountEquity: number;
  liveMirrorEquity: number;
  demoLiveClone: boolean;
  fullSizeThreshold: number;
  whitelist?: readonly string[] | null;
}

/** Selects contract size from account equity while keeping the same three market roots. */
export function selectFuturesSymbols(input: SymbolSelectionInput): string[] {
  const selected = input.mode === "demo" && !input.demoLiveClone
    ? [...FULL_SIZE_FUTURES]
    : (input.mode === "demo" ? input.liveMirrorEquity : input.accountEquity) >= input.fullSizeThreshold
      ? [...FULL_SIZE_FUTURES]
      : [...MICRO_FUTURES];

  if (!input.whitelist?.length) return selected;
  const allowed = new Set(input.whitelist);
  return selected.filter((symbol) => allowed.has(symbol));
}

/**
 * Session sizing for real money and the live-clone demo.
 *
 * Index futures are deliberately RTH-only. Gold may also trade the validated London/evening
 * windows once equity can support overnight margin. Edge-level switches still decide which setup
 * and direction may trade inside an eligible session.
 */
export function livePolicySessionMultiplier(
  symbol: string | undefined,
  session: string,
  equity: number,
  goldOvernightMinEquity: number,
): number {
  if (session === "halt") return 0;
  if (session === "morning" || session === "afternoon") return 1;
  if (session === "midday") return 0.5;
  if (
    symbol
    && METALS.has(symbol)
    && equity >= goldOvernightMinEquity
    && (session === "eth_evening" || session === "eth_europe")
  ) return 1;
  return 0;
}

/** Fails closed when either equity or the contract's overnight margin is unknown. */
export function overnightMarginContractCap(
  equity: number,
  perContractMargin: number | undefined,
  utilisationCap: number,
): number {
  if (
    !Number.isFinite(equity)
    || equity <= 0
    || !Number.isFinite(perContractMargin)
    || !perContractMargin
    || perContractMargin <= 0
    || !Number.isFinite(utilisationCap)
    || utilisationCap <= 0
    || utilisationCap > 1
  ) return 0;
  return Math.floor((equity * utilisationCap) / perContractMargin);
}
