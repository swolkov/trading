import { prisma } from "@/lib/db";

export async function GET() {
  try {
    const messages = await prisma.chatMessage.findMany({
      orderBy: { createdAt: "asc" },
      take: 100,
    });
    return Response.json(messages);
  } catch (error) {
    console.error("[/api/ai/history]", error);
    return Response.json(
      { error: error instanceof Error ? error.message : "Failed to fetch history" },
      { status: 500 }
    );
  }
}

export async function DELETE() {
  try {
    await prisma.chatMessage.deleteMany();
    return Response.json({ success: true });
  } catch (error) {
    console.error("[/api/ai/history DELETE]", error);
    return Response.json(
      { error: error instanceof Error ? error.message : "Failed to clear history" },
      { status: 500 }
    );
  }
}
