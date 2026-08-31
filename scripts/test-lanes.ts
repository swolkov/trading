import { sendNotification } from "../src/lib/notifications";
async function main() {
  console.log("firing one test message through each lane (falls back to your main channel)...");
  await sendNotification("🚨 TEST — margin_urgent lane. Liquidation/margin/drawdown alerts route here. (fallback: main channel until #margin-urgent webhook is set)", "margin_urgent");
  await sendNotification("🔎 TEST — margin_signals lane. Scanner + fast-move alerts route here. (fallback: main channel until #margin-signals webhook is set)", "margin_signals");
  await sendNotification("📊 TEST — margin_results lane. Shadow would-be P&L + TradingView receipts route here. (fallback: main channel until #margin-results webhook is set)", "margin_results");
  console.log("sent 3 test messages. Check Slack — if all 3 arrived, the routing works and is ready to split.");
}
main().catch(e => { console.error(String(e).slice(0,120)); process.exit(1); });
