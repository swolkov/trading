/**
 * Wire the three margin Slack lanes into agentConfig and fire one test into each.
 *
 * Webhook URLs are SECRETS — never hardcode them (this repo is public). Pass them as
 * env vars so nothing sensitive is committed:
 *
 *   WEBHOOK_MARGIN_URGENT=https://hooks.slack.com/services/... \
 *   WEBHOOK_MARGIN_SIGNALS=https://hooks.slack.com/services/... \
 *   WEBHOOK_MARGIN_RESULTS=https://hooks.slack.com/services/... \
 *   railway run npx tsx scripts/wire-lanes.ts
 *
 * Each falls back to the main kraken channel if unset (see src/lib/notifications.ts),
 * so the lanes work even before dedicated channels exist.
 */
import { PrismaClient } from "../src/generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { sendNotification } from "../src/lib/notifications";

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }) } as never);

const LANES: { key: string; env: string; test: string; channel: "margin_urgent" | "margin_signals" | "margin_results" }[] = [
  { key: "webhook_margin_urgent", env: "WEBHOOK_MARGIN_URGENT", channel: "margin_urgent",
    test: "🚨 #margin-urgent is LIVE — liquidation, margin-level, and drawdown alerts land here. Never mute this one." },
  { key: "webhook_margin_signals", env: "WEBHOOK_MARGIN_SIGNALS", channel: "margin_signals",
    test: "🔎 #margin-signals is LIVE — scanner breakouts/RSI/volume + fast moves land here." },
  { key: "webhook_margin_results", env: "WEBHOOK_MARGIN_RESULTS", channel: "margin_results",
    test: "📊 #margin-results is LIVE — shadow would-be P&L + TradingView alert receipts land here." },
];

async function main() {
  let wired = 0;
  for (const lane of LANES) {
    const url = process.env[lane.env];
    if (!url) { console.log(`skip ${lane.key} — ${lane.env} not set`); continue; }
    await prisma.agentConfig.upsert({ where: { key: lane.key }, update: { value: url }, create: { key: lane.key, value: url } });
    console.log(`set ${lane.key}`);
    wired++;
  }
  if (wired) {
    console.log("firing a test into each configured lane...");
    for (const lane of LANES) {
      if (process.env[lane.env]) await sendNotification(lane.test, lane.channel);
    }
    console.log("done — check the channels for one message each");
  } else {
    console.log("no lane env vars set — nothing to wire");
  }
  await prisma.$disconnect();
}
main().catch((e) => { console.error(String(e).slice(0, 150)); process.exit(1); });
