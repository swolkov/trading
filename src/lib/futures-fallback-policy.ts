export function futuresActionPrefix(tradingMode: string): "live" | "futures" {
  return tradingMode === "live" ? "live" : "futures";
}
