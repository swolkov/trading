import { cashOut } from "@/lib/meme-scanner";

export const maxDuration = 120;

// Password-gated cash-out: sell every position to SOL and send it all to `destination`.
// destination = your Kraken SOL DEPOSIT address (Kraken → Deposit → SOL).
export async function POST(request: Request) {
  try {
    const { password, destination } = await request.json();
    if (!process.env.LIVE_TRADING_PASSWORD || password !== process.env.LIVE_TRADING_PASSWORD) {
      return Response.json({ error: "Wrong password" }, { status: 401 });
    }
    if (!destination || typeof destination !== "string" || destination.length < 32) {
      return Response.json({ error: "Provide a valid Solana destination address" }, { status: 400 });
    }
    const res = await cashOut(destination.trim());
    return Response.json(res, { status: res.ok ? 200 : 500 });
  } catch (e) {
    return Response.json({ error: String(e) }, { status: 500 });
  }
}
