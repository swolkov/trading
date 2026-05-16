import { getPositions, getMarketClock, placeOrder } from "@/lib/alpaca";
import { manageOptionsPositions } from "@/lib/options-trader";
import { defendPremiumPosition } from "@/lib/premium-seller";
import { getAccount } from "@/lib/alpaca";
import { sendNotification } from "@/lib/notifications";
import { prisma } from "@/lib/db";

export const maxDuration = 60;

// ============ POSITION MONITOR ============
// Runs every 15 min. Watches positions for stops, profits, premium defense.
// Spread-aware: paired legs are skipped (managed by full agent as units).

export async function GET(request: Request) {
  const authHeader = request.headers.get("authorization");
  if (
    !process.env.CRON_SECRET ||
    authHeader !== `Bearer ${process.env.CRON_SECRET}`
  ) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const startTime = Date.now();

  try {
    const clock = await getMarketClock();
    if (!clock.is_open) {
      return Response.json({ status: "market_closed", actions: 0 });
    }

    const positions = await getPositions();
    if (positions.length === 0) {
      return Response.json({ status: "no_positions", actions: 0 });
    }

    const account = await getAccount();
    const equity = parseFloat(account.equity);
    let actions = 0;
    const details: string[] = [];

    // Detect spread legs — skip them (full agent manages spreads as units)
    const spreadLegs = new Set<string>();
    const optPositions = positions.filter((p) => p.symbol.length > 10);
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
        spreadLegs.add(pos.symbol);
        spreadLegs.add(partner.symbol);
      }
    }

    // === CHECK SPREADS for stop loss and take profit ===
    const processedSpreads = new Set<string>();
    for (const pos of optPositions) {
      if (!spreadLegs.has(pos.symbol)) continue;
      if (processedSpreads.has(pos.symbol)) continue;

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

      if (!partner) continue;
      processedSpreads.add(pos.symbol);
      processedSpreads.add(partner.symbol);

      const longLeg = qty > 0 ? pos : partner;
      const shortLeg = qty < 0 ? pos : partner;
      const shortStrike = shortLeg.symbol.match(/(\d{8})$/)?.[1] || "0";
      const longStrike = longLeg.symbol.match(/(\d{8})$/)?.[1] || "0";

      const spreadPnl = parseFloat(pos.unrealized_pl) + parseFloat(partner.unrealized_pl);
      const shortEntry = parseFloat(shortLeg.avg_entry_price);
      const longEntry = parseFloat(longLeg.avg_entry_price);
      const netCredit = (shortEntry - longEntry) * Math.abs(parseInt(shortLeg.qty)) * 100;
      const spreadWidth = Math.abs(parseInt(shortStrike) - parseInt(longStrike)) / 1000;
      const maxLoss = (spreadWidth - (shortEntry - longEntry)) * Math.abs(parseInt(shortLeg.qty)) * 100;
      const pnlPctOfMaxProfit = netCredit > 0 ? spreadPnl / netCredit : 0;

      const year = 2000 + parseInt(expDate.slice(0, 2));
      const month = parseInt(expDate.slice(2, 4)) - 1;
      const day = parseInt(expDate.slice(4, 6));
      const dte = Math.floor((new Date(year, month, day).getTime() - Date.now()) / (1000 * 60 * 60 * 24));
      const spreadDesc = `${underlying} $${parseInt(shortStrike) / 1000}/$${parseInt(longStrike) / 1000} ${optType === "P" ? "put" : "call"} spread`;

      // TAKE PROFIT: 50% of max credit
      if (pnlPctOfMaxProfit >= 0.50) {
        details.push(`SPREAD TAKE PROFIT: ${spreadDesc} at ${(pnlPctOfMaxProfit * 100).toFixed(0)}% of max profit`);
        try {
          await placeOrder({ symbol: longLeg.symbol, qty: String(Math.abs(parseInt(longLeg.qty))), side: "sell", type: "market", time_in_force: "day" });
          await placeOrder({ symbol: shortLeg.symbol, qty: String(Math.abs(parseInt(shortLeg.qty))), side: "buy", type: "market", time_in_force: "day" });
          actions += 2;
        } catch (err) { details.push(`Failed: ${err}`); }
        continue;
      }

      // STOP LOSS: 90% of max risk
      if (maxLoss > 0 && spreadPnl <= -maxLoss * 0.90) {
        details.push(`SPREAD STOP: ${spreadDesc} loss $${Math.abs(spreadPnl).toFixed(0)} near max risk $${maxLoss.toFixed(0)}`);
        try {
          await placeOrder({ symbol: longLeg.symbol, qty: String(Math.abs(parseInt(longLeg.qty))), side: "sell", type: "market", time_in_force: "day" });
          await placeOrder({ symbol: shortLeg.symbol, qty: String(Math.abs(parseInt(shortLeg.qty))), side: "buy", type: "market", time_in_force: "day" });
          actions += 2;
        } catch (err) { details.push(`Failed: ${err}`); }
        continue;
      }

      // EXPIRY: < 5 DTE
      if (dte <= 5) {
        details.push(`SPREAD EXPIRY: ${spreadDesc} ${dte} DTE — closing`);
        try {
          await placeOrder({ symbol: longLeg.symbol, qty: String(Math.abs(parseInt(longLeg.qty))), side: "sell", type: "market", time_in_force: "day" });
          await placeOrder({ symbol: shortLeg.symbol, qty: String(Math.abs(parseInt(shortLeg.qty))), side: "buy", type: "market", time_in_force: "day" });
          actions += 2;
        } catch (err) { details.push(`Failed: ${err}`); }
        continue;
      }
    }

    // === CHECK STANDALONE positions (not part of a spread) ===
    for (const pos of positions) {
      const isOptions = pos.symbol.length > 10;
      if (!isOptions) continue;
      if (spreadLegs.has(pos.symbol)) continue;

      const qty = parseInt(pos.qty);
      const isShort = qty < 0;

      if (isShort) {
        try {
          const defense = await defendPremiumPosition(pos, equity);
          if (defense.action !== "hold") {
            actions++;
            details.push(`${pos.symbol}: ${defense.action} — ${defense.details}`);
          }
        } catch { /* ignore */ }
      } else {
        const optActions = await manageOptionsPositions([pos]);
        for (const act of optActions) {
          if (act.action !== "hold") {
            actions++;
            details.push(`${act.symbol}: ${act.action} — ${act.reason}`);
          }
        }
      }
    }

    if (actions > 0) {
      await sendNotification(`Position Monitor: ${actions} action(s) taken\n${details.join("\n")}`, "options");
    }

    // Log every run so it shows in activity feed
    await prisma.agentRun.create({
      data: {
        runType: "monitor",
        stocksScanned: 0,
        tradesPlaced: actions,
        positionsManaged: positions.length - spreadLegs.size, // standalone only
        errors: 0,
        summary: `Monitor: ${positions.length} positions (${spreadLegs.size / 2} spreads skipped), ${actions} actions${actions > 0 ? ": " + details.join(", ") : ""}`,
        durationMs: Date.now() - startTime,
      },
    });

    await prisma.agentConfig.upsert({ where: { key: "monitor_last_run" }, update: { value: new Date().toISOString() }, create: { key: "monitor_last_run", value: new Date().toISOString() } }).catch(() => {});

    return Response.json({ status: "ok", positions: positions.length, spreadsSkipped: spreadLegs.size / 2, actions, details });
  } catch (error) {
    console.error("[/api/cron/monitor]", error);
    try { await sendNotification(`🚨 MONITOR CRON CRASH: ${error instanceof Error ? error.message : "Unknown"}`, "general"); } catch {}
    return Response.json({ error: String(error) }, { status: 500 });
  }
}
