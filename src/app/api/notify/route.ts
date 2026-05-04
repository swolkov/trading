import { prisma } from "@/lib/db";

// Send notification via webhook (Slack, Discord, etc.)
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

// API route to test notifications
export async function POST(request: Request) {
  try {
    const { message } = await request.json();
    await sendNotification(message || "Test notification from Trading Platform");
    return Response.json({ success: true });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "Failed" },
      { status: 500 }
    );
  }
}
