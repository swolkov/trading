import {
  getOptionsChain,
  getOptionsExpirations,
  getOptionsSnapshots,
} from "@/lib/alpaca";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ symbol: string }> }
) {
  try {
    const { symbol } = await params;
    const upper = symbol.toUpperCase();
    const { searchParams } = new URL(request.url);
    const expiration = searchParams.get("expiration") || undefined;
    const type = (searchParams.get("type") as "call" | "put") || undefined;

    // If requesting expirations list
    if (searchParams.get("expirations") === "true") {
      const expirations = await getOptionsExpirations(upper);
      return Response.json({ expirations });
    }

    // Get contracts for the given expiration/type
    const contracts = await getOptionsChain(upper, expiration, type);

    // Get snapshots (greeks, prices) for the first 50 contracts
    let snapshots: Record<string, unknown> = {};
    if (contracts.length > 0) {
      const contractSymbols = contracts.slice(0, 50).map((c) => c.symbol);
      try {
        snapshots = await getOptionsSnapshots(contractSymbols);
      } catch {
        // Snapshots may not be available for all contracts
      }
    }

    return Response.json({ contracts, snapshots });
  } catch (error) {
    console.error("[/api/options]", error);
    return Response.json(
      { error: error instanceof Error ? error.message : "Unknown error" },
      { status: 500 }
    );
  }
}
