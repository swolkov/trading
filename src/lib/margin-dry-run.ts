// WOULD KRAKEN ACCEPT THE NEXT ORDER? — validate-only, places NOTHING.
//
// WHY THIS EXISTS. Every other check answers a different question. The config reads back
// correctly, the gates all pass, the leverage rung is accepted, a Fable audit says the code
// path is sound — and none of that is the same as "the exact order this desk will send next
// is acceptable to the venue." Between a passing gate and a filled order sit the things only
// Kraken can rule on: lot decimals, price decimals, the pair minimum, whether a stop-loss
// conditional close is valid on a margin order at this leverage, and whether the account has
// the margin for it right now.
//
// The desk went to 1 slot at 8% per trade on 2026-09-09 and has not placed a single order
// under that configuration — the market turned down the same day and a longs-only breakout
// rule correctly has nothing to buy. So the first proof that the new sizing works would
// otherwise arrive at the worst possible moment: on a real signal, with real money.
//
// This mirrors the executor's sizing EXACTLY — same helpers, same order, same rounding — and
// sends it with validate=true, which runs every server-side check Kraken has and creates
// nothing. If it comes back ok, the next real order differs only in the price it fills at.
//
// ⚠️ Private calls share the rate/nonce budget the guardian and executor depend on. Owner
// triggered, never scheduled.
import { krakenPrivate, krakenConfigured, getKrakenPrice, getPairMeta } from "@/lib/kraken";
import { marginOrderPairFor, US_MARGIN_MAX_LEVERAGE } from "@/lib/kraken-pairs";
import { clampLiveStopFrac, leverageThatFitsStop, liveNotional, liveRiskFraction, liveContainerFor, parseLiveRiskBasePct } from "@/lib/margin-live-risk";

export interface DryRunRow {
  symbol: string; ok: boolean;
  leverage: number; stopPct: number; notional: number; volume: string;
  entryPx: number; stopPx: string; pair: string; marginUsd: number;
  krakenSays: string;
}
export interface DryRunInput {
  equity: number; freeMargin: number; baseRiskPct: number; leverageCeiling: number;
  perTradeCapUsd: number; containerStopPct: number; source: string;
}

/** The sizing half, pure and testable — the executor's own helpers in the executor's order. */
export function planOrder(symbol: string, price: number, i: DryRunInput) {
  const pairMax = US_MARGIN_MAX_LEVERAGE[symbol.split("/")[0].toUpperCase()] ?? 2;
  const asked = Math.min(i.leverageCeiling, pairMax);
  const leverage = leverageThatFitsStop(i.containerStopPct, asked);
  const stopFrac = clampLiveStopFrac(i.containerStopPct, leverage);
  // HIGH conviction: autoPlansFor refuses anything else, so the next order is always this one.
  const riskFrac = liveRiskFraction(parseLiveRiskBasePct(i.baseRiskPct), "high");
  const notional = liveNotional(i.equity, riskFrac, stopFrac, leverage, i.perTradeCapUsd, i.freeMargin);
  return { leverage, stopFrac, notional, marginUsd: leverage > 0 ? notional / leverage : 0 };
}

export async function dryRunNextOrder(symbols: string[], i: Omit<DryRunInput, "containerStopPct" | "source"> & { source: string }): Promise<{ rows: DryRunRow[]; placedOrders: 0; allOk: boolean }> {
  if (!krakenConfigured()) throw new Error("Kraken keys are not set in this environment");
  const container = liveContainerFor(i.source);
  if (!container) throw new Error(`source "${i.source}" has no live container — it cannot trade`);
  const rows: DryRunRow[] = [];
  for (const symbol of symbols) {
    const input: DryRunInput = { ...i, containerStopPct: container.stopPct };
    let price = 0;
    try { price = await getKrakenPrice(symbol); } catch { /* reported below */ }
    if (!(price > 0)) { rows.push({ symbol, ok: false, leverage: 0, stopPct: container.stopPct, notional: 0, volume: "0", entryPx: 0, stopPx: "0", pair: "", marginUsd: 0, krakenSays: "price unreadable" }); continue; }
    const { leverage, stopFrac, notional, marginUsd } = planOrder(symbol, price, input);
    const pair = marginOrderPairFor(symbol);
    const meta = await getPairMeta(pair);
    const volume = (notional / price).toFixed(meta.lotDecimals);
    const stopPx = (price * (1 - stopFrac)).toFixed(meta.priceDecimals);
    if (!(notional > 0) || parseFloat(volume) < meta.orderMin) {
      rows.push({ symbol, ok: false, leverage, stopPct: stopFrac * 100, notional, volume, entryPx: price, stopPx, pair, marginUsd, krakenSays: `size ${volume} below the pair minimum ${meta.orderMin}` });
      continue;
    }
    let krakenSays = "accepted", ok = true;
    try {
      // EXACTLY what the executor sends, minus nothing: market entry, the leverage the plan
      // carries, and the attached stop-loss conditional close. validate=true places NOTHING.
      await krakenPrivate("AddOrder", {
        pair, type: "buy", ordertype: "market", volume, leverage: String(leverage),
        "close[ordertype]": "stop-loss", "close[price]": stopPx,
        validate: "true",
      });
    } catch (e) { ok = false; krakenSays = String(e).slice(0, 160).replace(/\s+/g, " "); }
    rows.push({ symbol, ok, leverage, stopPct: stopFrac * 100, notional, volume, entryPx: price, stopPx, pair, marginUsd, krakenSays });
    await new Promise((r) => setTimeout(r, 1200));   // pace: shared nonce budget
  }
  return { rows, placedOrders: 0, allOk: rows.every((r) => r.ok) };
}
