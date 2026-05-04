import { getPositions } from "@/lib/alpaca";

export async function GET() {
  try {
    const positions = await getPositions();
    return Response.json(positions);
  } catch (error) {
    console.error("[/api/positions]", error);
    return Response.json(
      { error: error instanceof Error ? error.message : "Unknown error" },
      { status: 500 }
    );
  }
}
