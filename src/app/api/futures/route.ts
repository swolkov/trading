import { runFuturesAgent } from "@/lib/futures-agent";
import { checkTradovateAuth } from "@/lib/tradovate";
import { getViewMode } from "@/lib/trading-mode";
import { requireOwnerUser } from "@/auth/owner";

export const maxDuration = 300;

export async function GET() {
  try {
    const viewMode = await getViewMode("futures");
    const auth = await checkTradovateAuth(viewMode);
    return Response.json({
      connected: auth.authenticated,
      accountId: auth.accountId,
      accountName: auth.accountName,
      message: auth.authenticated
        ? `Tradovate connected — Account: ${auth.accountName} (#${auth.accountId})`
        : "Tradovate not connected. Set TRADOVATE_USERNAME, TRADOVATE_PASSWORD, TRADOVATE_CID, TRADOVATE_SEC env vars.",
    });
  } catch (error) {
    return Response.json({ connected: false, error: String(error) });
  }
}

export async function POST() {
  const unauthorized = await requireOwnerUser();
  if (unauthorized) return unauthorized;

  try {
    // Railway realtime engines own all new entries. A dashboard-triggered legacy run may inspect
    // and protect the selected account, but must not create a competing entry.
    const result = await runFuturesAgent({ managementOnly: true });
    return Response.json(result);
  } catch (error) {
    console.error("[/api/futures]", error);
    return Response.json(
      { error: error instanceof Error ? error.message : "Futures agent failed" },
      { status: 500 }
    );
  }
}
