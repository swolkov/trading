import { OPTIONS_MAX_LOSS_KEY, parseOptionsMaxLoss } from "@/lib/options-operation";
import { readAccountSnapshot, readLiveSnapshot } from "@/lib/options-quote-store";
import { prisma } from "@/lib/db";

// The real Robinhood account, as the desk session last pushed it — the counterpart of the
// Kraken Live Account page. Everything here is a SNAPSHOT with an age: the app holds no
// Robinhood credentials, so it cannot read the broker itself, and it never places an order.
export const dynamic = "force-dynamic";

export async function GET() {
  const [account, live, maxLoss] = await Promise.all([
    readAccountSnapshot().catch(() => null),
    readLiveSnapshot().catch(() => null),
    prisma.agentConfig.findUnique({ where: { key: OPTIONS_MAX_LOSS_KEY } }).then((r) => parseOptionsMaxLoss(r?.value)).catch(() => null),
  ]);
  // Anything the desk did not put there. The runner's allowlist has no order tool, so a
  // non-"user" agent on an order is the one thing on this page that should never appear.
  const foreignOrders = (live?.orders ?? []).filter((o) => o.placedAgent && o.placedAgent !== "user");
  return Response.json({
    account, live, lastRun: live?.at ?? account?.at ?? null,
    foreignOrders,
    // Plain statement of what can and cannot happen here, for the page to show verbatim.
    execution: {
      canPlaceOrders: false,
      maxLossUsd: maxLoss,
      paperEnabled: false,
      why: "Live order placement is not active. Direct account reads are separate from live execution. The execution adapter, fill recovery and position guardian are not verified.",
    },
  });
}
