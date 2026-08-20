export interface FillLike {
  id: number;
  orderId: number;
  contractId: number;
  timestamp: string;
  action: string;
  qty: number;
  price: number;
}

export interface MatchedRoundTrip<TFill extends FillLike = FillLike> {
  symbol: string;
  direction: "long" | "short";
  entryFill: TFill;
  exitFill: TFill;
  entryPrice: number;
  exitPrice: number;
  qty: number;
  pnl: number;
  entryTime: string;
  exitTime: string;
}

const MULTIPLIER: Record<string, number> = {
  ES: 50, NQ: 20, GC: 100, YM: 5, RTY: 50,
  MES: 5, MNQ: 2, MGC: 10, MYM: 0.5, M2K: 5,
  MBT: 0.1, MET: 0.1, BFF: 0.01, MXR: 2500, MSL: 25,
};

const ESTIMATED_ROUND_TURN_COST: Record<string, number> = {
  MES: 2.02, MNQ: 2.02, MGC: 2.02, MYM: 2.02, M2K: 2.02,
  ES: 4, NQ: 4, GC: 4, YM: 4, RTY: 4,
};

export function matchFillsToRoundTrips<TFill extends FillLike>(
  fills: TFill[],
  contractMap: Record<number, string>,
): MatchedRoundTrip<TFill>[] {
  const roundTrips: MatchedRoundTrip<TFill>[] = [];
  const byContract: Record<number, TFill[]> = {};
  for (const fill of fills) (byContract[fill.contractId] ??= []).push(fill);

  for (const [contractIdText, contractFills] of Object.entries(byContract)) {
    const symbol = contractMap[Number(contractIdText)] || "UNKNOWN";
    const multiplier = MULTIPLIER[symbol] ?? 5;
    const sorted = [...contractFills].sort(
      (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
    );
    let position = 0;
    let entryFills: TFill[] = [];
    let exitFills: TFill[] = [];

    const emitPosition = () => {
      if (!entryFills.length || !exitFills.length) return;
      const direction: "long" | "short" = entryFills[0].action === "Buy" ? "long" : "short";
      const entryQty = entryFills.reduce((sum, fill) => sum + Math.abs(fill.qty), 0);
      const exitQty = exitFills.reduce((sum, fill) => sum + Math.abs(fill.qty), 0);
      const quantity = Math.min(entryQty, exitQty);
      if (quantity <= 0) return;
      const entryPrice = entryFills.reduce((sum, fill) => sum + fill.price * Math.abs(fill.qty), 0) / entryQty;
      const exitPrice = exitFills.reduce((sum, fill) => sum + fill.price * Math.abs(fill.qty), 0) / exitQty;
      const priceDiff = direction === "long" ? exitPrice - entryPrice : entryPrice - exitPrice;
      const grossPnl = priceDiff * multiplier * quantity;
      const fees = (ESTIMATED_ROUND_TURN_COST[symbol] ?? 4) * quantity;
      roundTrips.push({
        symbol,
        direction,
        entryFill: entryFills[0],
        exitFill: exitFills.at(-1)!,
        entryPrice,
        exitPrice,
        qty: quantity,
        pnl: grossPnl - fees,
        entryTime: entryFills[0].timestamp,
        exitTime: exitFills.at(-1)!.timestamp,
      });
    };

    for (const fill of sorted) {
      const signedQty = fill.action === "Buy" ? fill.qty : -fill.qty;
      if (position === 0) {
        position = signedQty;
        entryFills = [fill];
        exitFills = [];
        continue;
      }
      if (Math.sign(position) === Math.sign(signedQty)) {
        position += signedQty;
        entryFills.push(fill);
        continue;
      }

      const closeQty = Math.min(Math.abs(position), Math.abs(signedQty));
      exitFills.push({ ...fill, qty: closeQty });
      position += Math.sign(signedQty) * closeQty;
      const remainder = Math.abs(signedQty) - closeQty;
      if (position === 0) {
        emitPosition();
        entryFills = [];
        exitFills = [];
        if (remainder > 0) {
          position = Math.sign(signedQty) * remainder;
          entryFills = [{ ...fill, qty: remainder }];
        }
      }
    }
  }
  return roundTrips;
}
