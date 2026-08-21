export function futuresActionPrefix(tradingMode: string): "live" | "futures" {
  return tradingMode === "live" ? "live" : "futures";
}

export function legacyAgentCanScanNewTrades(args: {
  managementOnly: boolean;
  tradingMode: string;
  timeQualityAllowsEntry: boolean;
  isFirstOrLast15Minutes: boolean;
}): boolean {
  if (args.managementOnly) return false;
  if (args.tradingMode === "paper") return true;
  return args.timeQualityAllowsEntry && !args.isFirstOrLast15Minutes;
}
