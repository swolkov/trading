import { prisma } from "./db";

// Three margin lanes keep the must-not-miss alerts from drowning in scanner noise:
//   margin_urgent  — margin level, liquidation distance, drawdown breaker (never mute this)
//   margin_signals — scanner output + fast-move/event heads-ups (browse when you want)
//   margin_results — PAPER outcomes: shadow P&L resolutions, scoreboard milestones, synthesis
//   margin_live    — REAL-MONEY events: arm/disarm, live entries and closes, guardian stop
//                    moves, the round trip. Falls back to margin_urgent (never lost).
// Each falls back to the single kraken channel → general, so everything still lands today
// in one place until Spencer creates the separate Slack channels + webhooks.
// stocks — the stock paper book (Sep 2026): scanner signals + paper outcomes. Falls back
// to general (NOT kraken — a stock signal in the crypto channel would read as a crypto one).
// options — the options paper book (Sep 2026): trend entries + paper outcomes. Also falls
// back to general, never to kraken: its whole purpose is to be a record SEPARATE from the
// crypto desk, and putting its alerts in the crypto lane would undo that at a glance.
export type NotifyChannel =
  | "futures" | "futures_demo" | "kraken" | "general"
  | "margin_urgent" | "margin_signals" | "margin_results" | "margin_live" | "stocks" | "options";

const CHANNEL_KEYS: Record<NotifyChannel, string> = {
  futures: "webhook_futures",
  futures_demo: "webhook_futures_demo",
  kraken: "webhook_kraken",
  general: "webhook_general",
  margin_urgent: "webhook_margin_urgent",
  margin_signals: "webhook_margin_signals",
  margin_results: "webhook_margin_results",
  margin_live: "webhook_margin_live",
  stocks: "webhook_stocks",
  options: "webhook_options",
};

// The margin lanes fall back to the main kraken channel if their own webhook isn't set.
const FALLS_BACK_TO_KRAKEN: NotifyChannel[] = ["margin_urgent", "margin_signals", "margin_results", "margin_live"];

async function webhookFor(key: string): Promise<string | null> {
  const row = await prisma.agentConfig.findUnique({ where: { key } });
  return row?.value || null;
}

async function getWebhook(channel: NotifyChannel): Promise<string | null> {
  const own = await webhookFor(CHANNEL_KEYS[channel]);
  if (own) return own;

  // Demo alerts NEVER fall back to the live webhook — a 🚨 in the real-money channel reads
  // as an emergency and trains alert fatigue.
  if (channel === "futures_demo") return null;

  // Real-money events must never be lost: without their own channel they go to the urgent lane.
  if (channel === "margin_live") {
    const urg = await webhookFor("webhook_margin_urgent");
    if (urg) return urg;
  }

  // Margin lanes and the kraken channel fall back to the kraken webhook, then general, so
  // no alert is lost before the dedicated channels are configured.
  if (channel === "kraken" || FALLS_BACK_TO_KRAKEN.includes(channel)) {
    const krk = await webhookFor("webhook_kraken");
    if (krk) return krk;
    const gen = await webhookFor("webhook_general");
    if (gen) return gen;
  }
  if (channel === "stocks") {
    const gen = await webhookFor("webhook_general");
    if (gen) return gen;
  }

  return webhookFor("notification_webhook");
}

export async function sendNotification(
  message: string,
  channel: NotifyChannel = "general"
) {
  try {
    const webhook = await getWebhook(channel);
    if (!webhook) return;

    // 5s timeout: every Kraken call has one, this did not. A hung Slack webhook on a
    // trading path would otherwise stall the request until the function is killed — and on
    // the margin close path that turns a Slack outage into a CLOSE outage.
    const res = await fetch(webhook, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: message }),
      signal: AbortSignal.timeout(5000),
    });
    // A REVOKED WEBHOOK IS A SUCCESSFUL FETCH. Slack answers 404 "no_service" and this used to
    // ignore the response entirely, so a dead lane went on swallowing every alert with no
    // error anywhere — including the drawdown-breaker page, which is the one alert the desk
    // cannot afford to lose. At 8% risk two consecutive losers trip that breaker, it does not
    // self-clear, and an unnoticed trip costs far more than any single trade: replayed, a
    // permanently latched breaker leaves the desk halted 93 of 118 days.
    if (!res.ok) await recordNotifyFailure(channel, `HTTP ${res.status}`);
    else await clearNotifyFailure(channel);
  } catch (e) {
    // Still best-effort — a Slack outage must never break a trading path, so this cannot
    // throw. It can, however, leave a mark.
    await recordNotifyFailure(channel, String(e).slice(0, 120));
  }
}

/**
 * Notification delivery is best-effort BY DESIGN, so failure has to be recorded rather than
 * raised. Both helpers swallow their own errors for the same reason: a failing Slack lane must
 * not become a failing close. The stamp is what makes a silently dead webhook findable.
 */
const NOTIFY_FAIL_KEY = "notify_last_failure";
async function recordNotifyFailure(channel: NotifyChannel, why: string): Promise<void> {
  console.error(`[notify] ${channel} delivery FAILED: ${why}`);
  try {
    const { prisma } = await import("@/lib/db");
    const value = JSON.stringify({ at: new Date().toISOString(), channel, why });
    await prisma.agentConfig.upsert({ where: { key: NOTIFY_FAIL_KEY }, update: { value }, create: { key: NOTIFY_FAIL_KEY, value } });
  } catch { /* recording a failure may not cause one */ }
}
async function clearNotifyFailure(channel: NotifyChannel): Promise<void> {
  // Only the urgent lane clears the stamp: a working #results webhook says nothing about a
  // broken #urgent one, and the urgent lane is the one that carries the breaker.
  if (channel !== "margin_urgent") return;
  try {
    const { prisma } = await import("@/lib/db");
    await prisma.agentConfig.deleteMany({ where: { key: NOTIFY_FAIL_KEY } });
  } catch { /* best effort */ }
}
