import { OPTIONS_MAX_LOSS_KEY, parseOptionsMaxLoss } from "@/lib/options-operation";
import { readAccountSnapshot, readLiveSnapshot } from "@/lib/options-quote-store";
import { prisma } from "@/lib/db";

// The real Robinhood account, as the desk session last pushed it — the counterpart of the
// Kraken Live Account page. Everything here is a SNAPSHOT with an age: the app holds no
// Robinhood credentials, so it cannot read the broker itself, and it never places an order.
export const dynamic = "force-dynamic";

export async function GET() {
  const [account, live, maxLoss, flags] = await Promise.all([
    readAccountSnapshot().catch(() => null),
    readLiveSnapshot().catch(() => null),
    prisma.agentConfig.findUnique({ where: { key: OPTIONS_MAX_LOSS_KEY } }).then((r) => parseOptionsMaxLoss(r?.value)).catch(() => null),
    prisma.agentConfig.findMany({ where: { key: { in: ["options_live_armed", "options_live_integration_verified"] } } }).then((rows) => Object.fromEntries(rows.map((r) => [r.key, r.value]))).catch(() => ({} as Record<string, string>)),
  ]);
  // The live desk (scripts/robinhood/live-desk.ts on the Mac) records every order it sends as a
  // durable intent. A non-"user" order the desk does not recognise is the one thing on this page
  // that should never appear: it means another session was given an order tool.
  let ours = new Set<string>();
  try { ours = new Set((await prisma.$queryRawUnsafe<{ id: string | null }[]>(`SELECT payload->'order'->>'id' AS id FROM options_live_intents`)).map((r) => r.id ?? "").filter(Boolean)); } catch { /* no desk tables yet */ }
  const foreignOrders = (live?.orders ?? []).filter((o) => o.placedAgent && o.placedAgent !== "user" && !ours.has(o.id));
  const armed = flags.options_live_armed === "true", verified = flags.options_live_integration_verified === "true";
  return Response.json({
    account, live, lastRun: live?.at ?? account?.at ?? null,
    foreignOrders,
    // Plain statement of what can and cannot happen here, for the page to show verbatim.
    execution: {
      canPlaceOrders: armed && verified,
      armed, verified,
      maxLossUsd: maxLoss,
      paperEnabled: false,
      why: armed && verified
        ? "The live desk is armed and its broker adapter is verified: it may place one contract at a time, debit structures only, inside the approved maximum loss including fees. It runs on the Mac every 5 minutes during the session."
        : armed
          ? "The live desk is armed but its broker adapter has not yet been verified on a real review response. The first session tick sends a review only; entries follow once that verifies."
          : "The live desk is disarmed. Direct account reads continue; no order can be placed.",
    },
  });
}
