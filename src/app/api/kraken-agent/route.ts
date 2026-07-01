import { getKrakenStatus, runKrakenAccumulator } from "@/lib/kraken-agent";

export const maxDuration = 60;

// Read-only status for the /kraken page: connection, cash, holdings, total invested, buys.
export async function GET() {
  try {
    const status = await getKrakenStatus();
    // TEMP diagnostic: which env var NAMES (never values) contain "krak"? Helps debug env wiring.
    const envNames = Object.keys(process.env).filter((k) => /krak/i.test(k));
    const lens = { keyLen: (process.env.Kraken_API_Key || "").length, secretLen: (process.env.Kraken_API_Secret || "").length };
    return Response.json({ ...status, _envDebug: envNames, _lens: lens });
  } catch (error) {
    return Response.json({ error: String(error) }, { status: 500 });
  }
}

// Manual trigger (auth-gated). POST ?dry=1 previews without ordering; else runs one accumulator tick.
export async function POST(request: Request) {
  const authHeader = request.headers.get("authorization");
  if (!process.env.CRON_SECRET || authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }
  try {
    const dry = new URL(request.url).searchParams.get("dry") === "1";
    return Response.json(await runKrakenAccumulator({ dry }));
  } catch (error) {
    console.error("[/api/kraken-agent POST]", error);
    return Response.json({ error: String(error) }, { status: 500 });
  }
}
