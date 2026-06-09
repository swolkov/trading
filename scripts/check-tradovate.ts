import { checkTradovateAuth, getTradovateAccountSummary } from "@/lib/tradovate";

async function main() {
  console.log("Checking live auth...");
  const liveAuth = await checkTradovateAuth("live");
  console.log("Live auth:", JSON.stringify(liveAuth));
  
  if (liveAuth.authenticated) {
    const s = await getTradovateAccountSummary("live");
    console.log("Live summary:", JSON.stringify(s));
  }
  
  console.log("\nChecking demo auth...");
  const demoAuth = await checkTradovateAuth("paper");
  console.log("Demo auth:", JSON.stringify(demoAuth));
  
  if (demoAuth.authenticated) {
    const s = await getTradovateAccountSummary("paper");
    console.log("Demo summary:", JSON.stringify(s));
  }
}
main().catch(e => console.error("Error:", e.message));
