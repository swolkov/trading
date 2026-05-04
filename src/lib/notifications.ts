import { prisma } from "./db";

export async function sendNotification(message: string) {
  try {
    const webhookConfig = await prisma.agentConfig.findUnique({
      where: { key: "notification_webhook" },
    });
    if (!webhookConfig?.value) return;

    await fetch(webhookConfig.value, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: message }),
    });
  } catch {
    // notifications are best-effort
  }
}
