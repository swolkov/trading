import { prisma } from "@/lib/db";
import { resolveEventPolicy } from "@/lib/margin-events";
import type { RiskState } from "@/lib/margin-risk-tiers";
import { btcStateStamp, type BtcShockState } from "@/lib/margin-btc-shock";

// The intelligence layer as the admin page sees it: the event policy the executor acts on,
// the guardian's drawdown-tier row, and the scan's latest stamp. AgentConfig ONLY — no Kraken
// call, no fetch; every number here was written by a cron and is dated. btcShock is the scan's
// last read (margin-btc-shock.ts, carried in kraken_margin_intel_latest); derivatives are
// reserved for the step that builds them.
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const keys = ["kraken_margin_event_policy", "kraken_margin_event_veto", "kraken_margin_risk_state", "kraken_margin_intel_latest"];
    const rows = await prisma.agentConfig.findMany({ where: { key: { in: keys } } });
    const c: Record<string, string> = {};
    for (const r of rows) c[r.key] = r.value;
    const parse = <T,>(raw: string | undefined): T | null => { try { return raw ? (JSON.parse(raw) as T) : null; } catch { return null; } };
    const stored = parse<{ source?: string; calendarAt?: string | null; events?: unknown[] }>(c.kraken_margin_event_policy);
    const eventPolicy = { ...resolveEventPolicy(c.kraken_margin_event_policy ?? null, c.kraken_margin_event_veto ?? null, Date.now()), source: stored?.source ?? null, calendarAt: stored?.calendarAt ?? null, events: stored?.events ?? [] };
    const regime = parse<{ at: string; btcMtf: string | null; ethMtf: string | null; dataIssues: number; eventMode: string | null; btcShock?: BtcShockState; btcVetoOn?: boolean }>(c.kraken_margin_intel_latest);
    const riskState = parse<RiskState>(c.kraken_margin_risk_state);
    const btcShock = regime?.btcShock ? { ...regime.btcShock, vetoOn: regime.btcVetoOn ?? true, stamp: btcStateStamp(regime.btcShock) } : null;
    return Response.json({ eventPolicy, btcShock, derivatives: null, regime, riskState, at: new Date().toISOString() });
  } catch (error) {
    console.error("[/api/margin/intel]", error);
    return Response.json({ error: String(error) }, { status: 500 });
  }
}
