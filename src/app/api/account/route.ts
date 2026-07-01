import { getAccount } from "@/lib/alpaca";

export async function GET() {
  try {
    // Alpaca is live-only — always show the real live account (no paper/demo).
    // Tradovate keeps its own demo/live toggle on the Futures side.
    const account = await getAccount("live");
    return Response.json(account);
  } catch (error) {
    console.error("[/api/account]", error);
    return Response.json(
      { error: error instanceof Error ? error.message : "Unknown error" },
      { status: 500 }
    );
  }
}
