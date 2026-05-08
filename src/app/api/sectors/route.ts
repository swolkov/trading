import { scanSector, scanAllSectors, SECTOR_UNIVERSES } from "@/lib/sector-scanner";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const sector = searchParams.get("sector");

  try {
    if (sector) {
      const result = await scanSector(sector);
      return Response.json(result);
    }

    // List available sectors (no scan)
    if (searchParams.get("list") === "true") {
      return Response.json(
        Object.entries(SECTOR_UNIVERSES).map(([key, val]) => ({
          key,
          name: val.name,
          description: val.description,
          symbolCount: val.symbols.length,
          symbols: val.symbols,
        }))
      );
    }

    // Scan all sectors
    const results = await scanAllSectors();
    return Response.json(results);
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "Failed" },
      { status: 500 }
    );
  }
}
