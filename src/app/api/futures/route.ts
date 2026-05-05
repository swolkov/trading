import { runFuturesAgent } from "@/lib/futures-agent";
import { checkAuth } from "@/lib/ibkr";

export const maxDuration = 300;

export async function GET() {
  try {
    const auth = await checkAuth();
    return Response.json({
      connected: auth.authenticated,
      accountId: auth.accountId,
      message: auth.authenticated
        ? "IBKR connected — futures trading active"
        : "IBKR not connected. Set IBKR_BASE_URL, IBKR_ACCOUNT_ID env vars and run the Client Portal Gateway.",
    });
  } catch (error) {
    return Response.json({ connected: false, error: String(error) });
  }
}

export async function POST() {
  try {
    const result = await runFuturesAgent();
    return Response.json(result);
  } catch (error) {
    console.error("[/api/futures]", error);
    return Response.json(
      { error: error instanceof Error ? error.message : "Futures agent failed" },
      { status: 500 }
    );
  }
}
