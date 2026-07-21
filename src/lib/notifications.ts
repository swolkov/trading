import { prisma } from "./db";

export type NotifyChannel = "futures" | "futures_demo" | "options" | "kraken" | "general";

const CHANNEL_KEYS: Record<NotifyChannel, string> = {
  futures: "webhook_futures",
  futures_demo: "webhook_futures_demo",
  options: "webhook_options",
  kraken: "webhook_kraken",
  general: "webhook_general",
};

async function getWebhook(channel: NotifyChannel): Promise<string | null> {
  // Try channel-specific webhook first, fall back to legacy notification_webhook
  const config = await prisma.agentConfig.findUnique({
    where: { key: CHANNEL_KEYS[channel] },
  });
  if (config?.value) return config.value;

  // Demo alerts NEVER fall back to the live webhook — if no demo webhook is configured they are
  // dropped. Demo 🚨 messages in the real-money channel read as emergencies and train alert fatigue.
  if (channel === "futures_demo") return null;

  // Kraken falls back to #general until its own webhook is configured, so no alert is lost
  // during setup (its prior behavior was to post to #general directly).
  if (channel === "kraken") {
    const gen = await prisma.agentConfig.findUnique({ where: { key: "webhook_general" } });
    if (gen?.value) return gen.value;
  }

  const legacy = await prisma.agentConfig.findUnique({
    where: { key: "notification_webhook" },
  });
  return legacy?.value || null;
}

export async function sendNotification(
  message: string,
  channel: NotifyChannel = "general"
) {
  try {
    const webhook = await getWebhook(channel);
    if (!webhook) return;

    await fetch(webhook, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: message }),
    });
  } catch {
    // notifications are best-effort
  }
}
