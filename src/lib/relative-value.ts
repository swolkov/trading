import { getHistoricalBars } from "./yahoo";

// ============ RELATIVE VALUE / PAIRS TRADING ============
// Citadel's bread and butter: find stocks lagging their peers
// If AAPL drops 3% but MSFT/GOOGL/META are flat, AAPL is mispriced
// Buy calls on the laggard — high win-rate reversion trade

const PEER_GROUPS: Record<string, string[]> = {
  // Big Tech
  AAPL: ["MSFT", "GOOGL", "META", "AMZN"],
  MSFT: ["AAPL", "GOOGL", "META", "CRM"],
  GOOGL: ["META", "MSFT", "AMZN", "AAPL"],
  META: ["GOOGL", "SNAP", "PINS", "MSFT"],
  AMZN: ["GOOGL", "MSFT", "SHOP", "WMT"],
  // Semis
  NVDA: ["AMD", "AVGO", "QCOM", "MU"],
  AMD: ["NVDA", "INTC", "QCOM", "AVGO"],
  AVGO: ["QCOM", "NVDA", "AMD", "MRVL"],
  // Payments
  V: ["MA", "PYPL", "SQ", "GPN"],
  MA: ["V", "PYPL", "SQ", "GPN"],
  PYPL: ["SQ", "V", "MA", "AFRM"],
  // EV/Auto
  TSLA: ["RIVN", "LCID", "F", "GM"],
  // Finance
  JPM: ["GS", "BAC", "MS", "WFC"],
  GS: ["JPM", "MS", "BAC", "SCHW"],
  // Healthcare
  LLY: ["NVO", "UNH", "ABBV", "MRK"],
  UNH: ["LLY", "JNJ", "ABBV", "CI"],
  // Energy
  XOM: ["CVX", "COP", "SLB", "EOG"],
  CVX: ["XOM", "COP", "SLB", "EOG"],
  // Consumer
  WMT: ["COST", "TGT", "AMZN", "DG"],
  DIS: ["NFLX", "CMCSA", "WBD", "PARA"],
  NKE: ["LULU", "DECK", "UAA", "CROX"],
  // Growth
  PLTR: ["SNOW", "DDOG", "NET", "CRWD"],
  COIN: ["HOOD", "MARA", "SQ", "SOFI"],
  SHOP: ["SQ", "AMZN", "PYPL", "BIGC"],
  CRM: ["NOW", "WDAY", "HUBS", "ZS"],
  CRWD: ["PANW", "ZS", "FTNT", "S"],
};

export interface RelativeValueSignal {
  symbol: string;
  peers: string[];
  symbolReturn5d: number;
  avgPeerReturn5d: number;
  divergence: number; // how much the stock lags/leads peers (%)
  signal: "laggard_buy" | "leader_sell" | "in_line";
  strength: "weak" | "moderate" | "strong";
  reasoning: string;
}

export async function scanRelativeValue(symbols: string[]): Promise<RelativeValueSignal[]> {
  const signals: RelativeValueSignal[] = [];

  for (const symbol of symbols) {
    const peers = PEER_GROUPS[symbol];
    if (!peers || peers.length === 0) continue;

    try {
      // Get 5-day returns for symbol and peers
      const [symbolBars, ...peerBarsArr] = await Promise.all([
        getHistoricalBars(symbol, 10),
        ...peers.slice(0, 3).map((p) => getHistoricalBars(p, 10).catch(() => [])),
      ]);

      if (symbolBars.length < 5) continue;

      const symbolReturn = (symbolBars[symbolBars.length - 1].c - symbolBars[symbolBars.length - 5].c) / symbolBars[symbolBars.length - 5].c * 100;

      const peerReturns: number[] = [];
      for (const peerBars of peerBarsArr) {
        if (peerBars.length >= 5) {
          peerReturns.push((peerBars[peerBars.length - 1].c - peerBars[peerBars.length - 5].c) / peerBars[peerBars.length - 5].c * 100);
        }
      }

      if (peerReturns.length === 0) continue;

      const avgPeerReturn = peerReturns.reduce((a, b) => a + b, 0) / peerReturns.length;
      const divergence = symbolReturn - avgPeerReturn;

      let signal: RelativeValueSignal["signal"] = "in_line";
      let strength: RelativeValueSignal["strength"] = "weak";
      let reasoning = "";

      if (divergence < -3) {
        signal = "laggard_buy";
        strength = divergence < -6 ? "strong" : "moderate";
        reasoning = `${symbol} lagging peers by ${Math.abs(divergence).toFixed(1)}%. Peers avg +${avgPeerReturn.toFixed(1)}%, ${symbol} at ${symbolReturn >= 0 ? "+" : ""}${symbolReturn.toFixed(1)}%. Mean reversion trade: BUY CALLS on ${symbol} — expect catch-up.`;
      } else if (divergence > 3) {
        signal = "leader_sell";
        strength = divergence > 6 ? "strong" : "moderate";
        reasoning = `${symbol} leading peers by ${divergence.toFixed(1)}%. May be overextended. Consider taking profits or buying puts as hedge.`;
      }

      if (signal !== "in_line") {
        signals.push({
          symbol,
          peers: peers.slice(0, 3),
          symbolReturn5d: symbolReturn,
          avgPeerReturn5d: avgPeerReturn,
          divergence,
          signal,
          strength,
          reasoning,
        });
      }
    } catch {
      continue;
    }
  }

  // Sort by strongest divergence
  signals.sort((a, b) => Math.abs(b.divergence) - Math.abs(a.divergence));
  return signals;
}
