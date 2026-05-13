import { prisma } from "./db";

export type NotifyChannel = "futures" | "options" | "general";

const CHANNEL_KEYS: Record<NotifyChannel, string> = {
  futures: "webhook_futures",
  options: "webhook_options",
  general: "webhook_general",
};

async function getWebhook(channel: NotifyChannel): Promise<string | null> {
  // Try channel-specific webhook first, fall back to legacy notification_webhook
  const config = await prisma.agentConfig.findUnique({
    where: { key: CHANNEL_KEYS[channel] },
  });
  if (config?.value) return config.value;

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
