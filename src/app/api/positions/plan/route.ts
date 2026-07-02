import { getPositions } from "@/lib/alpaca";
import { prisma } from "@/lib/db";

// Returns the agent's plan for every open position:
// - Is it a spread? What kind?
// - Take profit level, stop loss level
// - DTE and expiry date
// - What the agent will do next and why

interface PositionPlan {
  symbol: string;
  type: "spread_leg" | "standalone_long" | "standalone_short" | "worthless";
  spreadGroup?: string;       // e.g., "AAPL $280/$270 put spread"
  spreadPartner?: string;     // partner symbol
  underlying: string;
  optionType: "call" | "put" | "stock";
  dte: number;
  expiryDate: string;

  // Spread metrics (only for spread legs)
  netCredit?: number;         // credit received
  maxLoss?: number;           // max possible loss
  spreadPnl?: number;         // combined P&L
  pnlPctOfMax?: number;       // P&L as % of max profit

  // Exit triggers
  takeProfitAt: string;       // human readable
  stopLossAt: string;
  expiryCloseAt: string;

  // Agent's plan
  plan: string;               // what the agent will do next
  reasoning: string;          // why
  urgency: "none" | "watch" | "action_soon" | "immediate";
}

export async function GET() {
  try {
    const positions = await getPositions("live");
    const optPositions = positions.filter((p) => p.symbol.length > 10);
    const plans: PositionPlan[] = [];

    // Detect spreads
    const spreadPairs: Map<string, string> = new Map(); // symbol -> partner symbol
    for (const pos of optPositions) {
      const match = pos.symbol.match(/^([A-Z]+)(\d{6})([CP])(\d{8})$/);
      if (!match) continue;
      const [, underlying, expDate, optType] = match;
      const qty = parseInt(pos.qty);

      const partner = optPositions.find((p) => {
        if (p.symbol === pos.symbol) return false;
        const m = p.symbol.match(/^([A-Z]+)(\d{6})([CP])(\d{8})$/);
        if (!m) return false;
        const pQty = parseInt(p.qty);
        return m[1] === underlying && m[2] === expDate && m[3] === optType &&
          ((qty > 0 && pQty < 0) || (qty < 0 && pQty > 0));
      });

      if (partner) {
        spreadPairs.set(pos.symbol, partner.symbol);
        spreadPairs.set(partner.symbol, pos.symbol);
      }
    }

    const processed = new Set<string>();

    for (const pos of positions) {
      if (pos.symbol.length <= 10) continue; // skip stocks
      if (processed.has(pos.symbol)) continue;

      const match = pos.symbol.match(/^([A-Z]+)(\d{6})([CP])(\d{8})$/);
      if (!match) continue;
      const [, underlying, expDate, optType] = match;
      const qty = parseInt(pos.qty);
      const strike = parseInt(match[4]) / 1000;

      // Parse DTE
      const year = 2000 + parseInt(expDate.slice(0, 2));
      const month = parseInt(expDate.slice(2, 4)) - 1;
      const day = parseInt(expDate.slice(4, 6));
      const expiryDate = new Date(year, month, day);
      const dte = Math.floor((expiryDate.getTime() - Date.now()) / (1000 * 60 * 60 * 24));
      const expiryStr = expiryDate.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });

      const marketValue = Math.abs(parseFloat(pos.market_value));
      const isWorthless = marketValue < 1;

      // WORTHLESS
      if (isWorthless) {
        plans.push({
          symbol: pos.symbol, type: "worthless", underlying,
          optionType: optType === "C" ? "call" : "put",
          dte, expiryDate: expiryStr,
          takeProfitAt: "N/A", stopLossAt: "N/A",
          expiryCloseAt: expiryStr,
          plan: "Position is worthless ($0). Will expire or be cleaned up.",
          reasoning: "Market value is $0. No action needed — will expire worthless.",
          urgency: "none",
        });
        processed.add(pos.symbol);
        continue;
      }

      // SPREAD
      const partnerSymbol = spreadPairs.get(pos.symbol);
      if (partnerSymbol) {
        processed.add(pos.symbol);
        processed.add(partnerSymbol);

        const partner = positions.find((p) => p.symbol === partnerSymbol)!;
        const longLeg = qty > 0 ? pos : partner;
        const shortLeg = qty < 0 ? pos : partner;
        const longStrike = parseInt(longLeg.symbol.match(/(\d{8})$/)?.[1] || "0") / 1000;
        const shortStrike = parseInt(shortLeg.symbol.match(/(\d{8})$/)?.[1] || "0") / 1000;

        const spreadPnl = parseFloat(pos.unrealized_pl) + parseFloat(partner.unrealized_pl);
        const shortEntry = parseFloat(shortLeg.avg_entry_price);
        const longEntry = parseFloat(longLeg.avg_entry_price);
        const netCredit = (shortEntry - longEntry) * Math.abs(parseInt(shortLeg.qty)) * 100;
        const spreadWidth = Math.abs(shortStrike - longStrike);
        const maxLoss = (spreadWidth - (shortEntry - longEntry)) * Math.abs(parseInt(shortLeg.qty)) * 100;
        const pnlPctOfMax = netCredit > 0 ? spreadPnl / netCredit : 0;

        const spreadDesc = `${underlying} $${shortStrike}/$${longStrike} ${optType === "P" ? "put" : "call"} spread`;
        const takeProfitLevel = netCredit * 0.50;
        const stopLossLevel = maxLoss * 0.90;

        let plan: string;
        let reasoning: string;
        let urgency: PositionPlan["urgency"] = "none";

        if (pnlPctOfMax >= 0.40) {
          plan = `Approaching take profit. Will close both legs when P&L reaches $${takeProfitLevel.toFixed(0)} (50% of $${netCredit.toFixed(0)} credit).`;
          reasoning = `Currently at ${(pnlPctOfMax * 100).toFixed(0)}% of max profit. Close to 50% target.`;
          urgency = "watch";
        } else if (spreadPnl <= -stopLossLevel * 0.7) {
          plan = `Approaching stop loss. Will close both legs if loss reaches $${stopLossLevel.toFixed(0)} (90% of max risk $${maxLoss.toFixed(0)}).`;
          reasoning = `Currently losing $${Math.abs(spreadPnl).toFixed(0)}. Stop at $${stopLossLevel.toFixed(0)}.`;
          urgency = spreadPnl <= -stopLossLevel * 0.9 ? "immediate" : "action_soon";
        } else if (dte <= 7) {
          plan = `Approaching expiry. Will close both legs at 5 DTE (${new Date(year, month, day - 5).toLocaleDateString("en-US", { month: "short", day: "numeric" })}) to avoid assignment.`;
          reasoning = `${dte} DTE remaining. Auto-close triggers at 5 DTE.`;
          urgency = dte <= 5 ? "immediate" : "watch";
        } else {
          plan = `Holding. Take profit at $${takeProfitLevel.toFixed(0)} (+${(0.50 * 100).toFixed(0)}% of credit). Stop at -$${stopLossLevel.toFixed(0)}. Expiry close at 5 DTE.`;
          reasoning = `P&L is ${(pnlPctOfMax * 100).toFixed(0)}% of max profit. Within normal range. ${dte} DTE remaining.`;
          urgency = "none";
        }

        // Add both legs as one plan
        const basePlan: Omit<PositionPlan, "symbol"> = {
          type: "spread_leg", spreadGroup: spreadDesc, underlying,
          optionType: optType === "C" ? "call" : "put",
          dte, expiryDate: expiryStr,
          netCredit, maxLoss, spreadPnl, pnlPctOfMax,
          takeProfitAt: `+$${takeProfitLevel.toFixed(0)} (50% of credit)`,
          stopLossAt: `-$${stopLossLevel.toFixed(0)} (90% of max risk)`,
          expiryCloseAt: `${dte <= 5 ? "NOW" : `At 5 DTE (${new Date(year, month, day - 5).toLocaleDateString("en-US", { month: "short", day: "numeric" })})`}`,
          plan, reasoning, urgency,
        };

        plans.push({ ...basePlan, symbol: pos.symbol, spreadPartner: partnerSymbol });
        plans.push({ ...basePlan, symbol: partnerSymbol, spreadPartner: pos.symbol });
        continue;
      }

      // STANDALONE
      const pnlPct = parseFloat(pos.unrealized_plpc);
      const isShort = qty < 0;

      let plan: string;
      let reasoning: string;
      let urgency: PositionPlan["urgency"] = "none";

      if (isShort) {
        // Naked short — premium defense
        plan = `Premium defense active. Will roll if strike is tested (<2% away), close if loss > 2x entry credit, close if near max profit (>90%).`;
        reasoning = `Naked short ${optType === "P" ? "put" : "call"} at $${strike}. Monitored every 15 min for defense.`;
        urgency = Math.abs(pnlPct) > 0.3 ? "watch" : "none";
      } else {
        // Long option
        const canPartial = Math.abs(qty) >= 2;
        if (pnlPct >= 0.35 && canPartial) {
          plan = `Approaching partial take profit at +40%. Will sell half and set breakeven stop on remainder.`;
          urgency = "watch";
        } else if (pnlPct >= 0.60) {
          plan = `Approaching full take profit at +75%. Will close entire position.`;
          urgency = "watch";
        } else if (pnlPct <= -0.20) {
          plan = `Approaching stop loss at -25%. Will close entire position.`;
          urgency = pnlPct <= -0.23 ? "immediate" : "action_soon";
        } else {
          plan = canPartial
            ? `Holding. Partial at +40% (sell half). Full profit at +75%. Stop at -25%. Close at 7 DTE.`
            : `Holding. Full profit at +75%. Stop at -25%. Close at 7 DTE. (1 contract — no partial possible)`;
        }
        reasoning = `Currently ${(pnlPct * 100).toFixed(1)}%. ${dte} DTE remaining.${!canPartial ? " Single contract — exits are all-or-nothing." : ""}`;
      }

      plans.push({
        symbol: pos.symbol,
        type: isShort ? "standalone_short" : "standalone_long",
        underlying,
        optionType: optType === "C" ? "call" : "put",
        dte, expiryDate: expiryStr,
        takeProfitAt: isShort ? "90% of credit collected" : (Math.abs(qty) >= 2 ? "+75% (full), +40% (partial half)" : "+75% (full, single contract)"),
        stopLossAt: isShort ? "2x entry credit" : "-25%",
        expiryCloseAt: `At 5 DTE`,
        plan, reasoning, urgency,
      });
      processed.add(pos.symbol);
    }

    return Response.json(plans);
  } catch (error) {
    return Response.json({ error: String(error) }, { status: 500 });
  }
}
