import { prisma } from "@/lib/db";

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const symbol = searchParams.get("symbol");
    const limit = parseInt(searchParams.get("limit") || "20");

    const where = symbol ? { symbol: symbol.toUpperCase() } : {};

    const reports = await prisma.researchReport.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take: limit,
    });

    return Response.json(reports);
  } catch (error) {
    console.error("[/api/ai/reports]", error);
    return Response.json(
      { error: error instanceof Error ? error.message : "Failed to fetch reports" },
      { status: 500 }
    );
  }
}
