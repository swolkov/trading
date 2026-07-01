import { getKrakenStatus, runKrakenAgent } from "@/lib/kraken-agent";

export const maxDuration = 60;

// Read-only status for the /kraken page: connection, cash, holdings, total invested, buys.
export async function GET() {
  try {
    return Response.json(await getKrakenStatus());
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
    return Response.json(await runKrakenAgent({ dry }));
  } catch (error) {
    console.error("[/api/kraken-agent POST]", error);
    return Response.json({ error: String(error) }, { status: 500 });
  }
}
