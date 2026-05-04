import { sendNotification } from "@/lib/notifications";

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
