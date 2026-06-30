import { getDipScan, runDipScan } from "@/lib/crypto-dip-scanner";

export const maxDuration = 60;

// Read-only dip-scanner feed for the Kraken page. Returns the latest stored scan; recomputes live if
// missing or stale (>30 min) so it works immediately even before the cron has run. No auth, no key.
export async function GET() {
  try {
    let scan = await getDipScan();
    const stale = !scan || Date.now() - new Date(scan.ts).getTime() > 30 * 60 * 1000;
    if (stale) scan = await runDipScan();
    return Response.json(scan);
  } catch (error) {
    return Response.json({ error: String(error), rows: [], ts: null }, { status: 500 });
  }
}
