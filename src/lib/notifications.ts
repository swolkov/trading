import { prisma } from "./db";

// Three margin lanes keep the must-not-miss alerts from drowning in scanner noise:
//   margin_urgent  — margin level, liquidation distance, drawdown breaker (never mute this)
//   margin_signals — scanner output + fast-move/event heads-ups (browse when you want)
//   margin_results — shadow P&L outcomes + TradingView alert receipts (the scoreboard feed)
// Each falls back to the single kraken channel → general, so everything still lands today
// in one place until Spencer creates the separate Slack channels + webhooks.
// stocks — the stock paper book (Sep 2026): scanner signals + paper outcomes. Falls back
// to general (NOT kraken — a stock signal in the crypto channel would read as a crypto one).
export type NotifyChannel =
  | "futures" | "futures_demo" | "kraken" | "general"
  | "margin_urgent" | "margin_signals" | "margin_results" | "stocks";

const CHANNEL_KEYS: Record<NotifyChannel, string> = {
  futures: "webhook_futures",
  futures_demo: "webhook_futures_demo",
  kraken: "webhook_kraken",
  general: "webhook_general",
  margin_urgent: "webhook_margin_urgent",
  margin_signals: "webhook_margin_signals",
  margin_results: "webhook_margin_results",
  stocks: "webhook_stocks",
};

// The margin lanes fall back to the main kraken channel if their own webhook isn't set.
const FALLS_BACK_TO_KRAKEN: NotifyChannel[] = ["margin_urgent", "margin_signals", "margin_results"];

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
    await fetch(webhook, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: message }),
      signal: AbortSignal.timeout(5000),
    });
  } catch {
    // notifications are best-effort
  }
}
