import { prisma } from "@/lib/db";

export async function GET() {
  try {
    const items = await prisma.watchlistItem.findMany({
      orderBy: { sortOrder: "asc" },
    });
    return Response.json(items);
  } catch (error) {
    console.error("[/api/watchlist GET]", error);
    return Response.json(
      { error: error instanceof Error ? error.message : "Unknown error" },
      { status: 500 }
    );
  }
}

export async function POST(request: Request) {
  try {
    const { symbol } = await request.json();
    const item = await prisma.watchlistItem.upsert({
      where: { symbol: symbol.toUpperCase() },
      update: {},
      create: { symbol: symbol.toUpperCase() },
    });
    return Response.json(item);
  } catch (error) {
    console.error("[/api/watchlist POST]", error);
    return Response.json(
      { error: error instanceof Error ? error.message : "Unknown error" },
      { status: 500 }
    );
  }
}

export async function DELETE(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const symbol = searchParams.get("symbol");
    if (!symbol) {
      return Response.json({ error: "symbol required" }, { status: 400 });
    }
    await prisma.watchlistItem.delete({
      where: { symbol: symbol.toUpperCase() },
    });
    return Response.json({ success: true });
  } catch (error) {
    console.error("[/api/watchlist DELETE]", error);
    return Response.json(
      { error: error instanceof Error ? error.message : "Unknown error" },
      { status: 500 }
    );
  }
}
