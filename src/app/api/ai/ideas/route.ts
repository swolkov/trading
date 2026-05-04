import { prisma } from "@/lib/db";

export async function GET() {
  try {
    const ideas = await prisma.tradeIdea.findMany({
      orderBy: { createdAt: "desc" },
      take: 50,
    });
    return Response.json(ideas);
  } catch (error) {
    console.error("[/api/ai/ideas]", error);
    return Response.json(
      { error: error instanceof Error ? error.message : "Failed to fetch ideas" },
      { status: 500 }
    );
  }
}
