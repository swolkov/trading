import { prisma } from "@/lib/db";
import { invalidateAssignmentsCache, type AccountKey } from "@/lib/strategy-assignments";
import { STRATEGIES } from "@/lib/strategies/registry";

const VALID_STATUSES = ["active", "observation", "disabled"] as const;
const VALID_ACCOUNTS = ["demo-futures", "live-futures", "paper-stocks", "paper-crypto"] as const;

export async function GET() {
  try {
    const rows = await prisma.strategyAssignment.findMany();
    return Response.json({ assignments: rows });
  } catch (e) {
    // Table missing (migration not run) — return empty list. Frontend renders defaults.
    return Response.json({ assignments: [], warning: e instanceof Error ? e.message : String(e) });
  }
}

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { accountKey, strategyId, status, maxContractsOverride } = body as {
      accountKey?: string;
      strategyId?: string;
      status?: string;
      maxContractsOverride?: number | null;
    };

    // Validation
    if (!accountKey || !VALID_ACCOUNTS.includes(accountKey as AccountKey)) {
      return Response.json({ error: `accountKey must be one of: ${VALID_ACCOUNTS.join(", ")}` }, { status: 400 });
    }
    if (!strategyId || !STRATEGIES.some((s) => s.id === strategyId)) {
      return Response.json({ error: `strategyId not registered: ${strategyId}` }, { status: 400 });
    }
    if (status !== undefined && !VALID_STATUSES.includes(status as typeof VALID_STATUSES[number])) {
      return Response.json({ error: `status must be one of: ${VALID_STATUSES.join(", ")}` }, { status: 400 });
    }

    const data: { status?: string; maxContractsOverride?: number | null } = {};
    if (status !== undefined) data.status = status;
    if (maxContractsOverride !== undefined) data.maxContractsOverride = maxContractsOverride;

    const row = await prisma.strategyAssignment.upsert({
      where: { accountKey_strategyId: { accountKey, strategyId } },
      update: data,
      create: {
        accountKey,
        strategyId,
        status: status ?? "observation",
        maxContractsOverride: maxContractsOverride ?? null,
      },
    });

    // Invalidate the in-process cache so the engine picks up the change next cycle.
    invalidateAssignmentsCache(accountKey as AccountKey);

    return Response.json({ assignment: row });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // Migration-not-run is the most common "expected" failure.
    if (msg.includes("does not exist") || msg.includes("relation")) {
      return Response.json({ error: "DB migration not yet run. Run `npx prisma db push` to create the StrategyAssignment table." }, { status: 503 });
    }
    return Response.json({ error: msg }, { status: 500 });
  }
}
