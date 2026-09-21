/**
 * Wire the Slack lanes for the two desks and fire one test into each.
 *
 * Webhook URLs are SECRETS — pass them as env vars, never hardcode:
 *   WEBHOOK_FUTURES=https://hooks.slack.com/services/...   (his live futures room)
 *   WEBHOOK_OPTIONS=https://hooks.slack.com/services/...   (the Robinhood live desk)
 *   WEBHOOK_FUTURES_DEMO=...                                (paper desk, optional)
 *   WEBHOOK_GENERAL=...                                     (fallback for futures + options, health/system)
 *   railway run --service futures-engine -- npx tsx scripts/wire-lanes.ts
 * Any lane not given keeps its current value. Futures and options fall back to webhook_general.
 */
import { prisma } from "../src/lib/db";
import { laneStatus, sendNotification, type NotifyChannel } from "../src/lib/notifications";
const LANES: { key: string; env: string; channel: NotifyChannel; test: string }[] = [
  { key: "webhook_futures", env: "WEBHOOK_FUTURES", channel: "futures", test: "🧭 TEST — futures lane: your Trading Room posts here (cards, level breaks, trade meter, loss line, 4:30 flatten)." },
  { key: "webhook_options", env: "WEBHOOK_OPTIONS", channel: "options", test: "📈 TEST — options lane: the Robinhood live desk posts here (arm/disarm, entries, closes, the brief)." },
  { key: "webhook_futures_demo", env: "WEBHOOK_FUTURES_DEMO", channel: "futures_demo", test: "🧪 TEST — futures DEMO lane (paper only)." },
  { key: "webhook_general", env: "WEBHOOK_GENERAL", channel: "general", test: "🔔 TEST — general lane: system/health notes, and the fallback when a desk lane has no webhook." },
];
async function main() {
  for (const l of LANES) {
    const url = process.env[l.env];
    if (!url) continue;
    // Only a real Slack webhook is ever written: a placeholder or a typo here would silently kill the lane it names.
    if (!/^https:\/\/hooks\.slack\.com\/services\/[A-Z0-9]+\/[A-Z0-9]+\/[A-Za-z0-9]+$/.test(url)) { console.log(`${l.key} NOT set — "${url.slice(0, 40)}" is not a Slack webhook URL (expected https://hooks.slack.com/services/T…/B…/…)`); continue; }
    await prisma.agentConfig.upsert({ where: { key: l.key }, update: { value: url }, create: { key: l.key, value: url } }); console.log(`${l.key} set`);
  }
  for (const s of await laneStatus()) console.log(`${s.channel.padEnd(13)} own webhook: ${s.own ? "yes" : "no "}  delivers: ${s.delivers ? "yes" : "NO"}`);
  for (const l of LANES) if (process.env[l.env] && /^https:\/\/hooks\.slack\.com\//.test(process.env[l.env]!)) await sendNotification(l.test, l.channel);
  await prisma.$disconnect();
}
main().catch((e) => { console.error(String(e).slice(0, 200)); process.exit(1); });
