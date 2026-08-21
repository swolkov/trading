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

  // Railway realtime engines exclusively own entries and position management. Keep this historical
  // endpoint read-only so a dashboard click can never race broker mutations.
  return Response.json({
    trades: [],
    managed: 0,
    details: ["Read-only position refresh complete. Railway retains exclusive order ownership."],
  });
}
