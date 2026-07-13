import { prisma } from "@/lib/db";
import type { TradingMode } from "@/lib/trading-mode";

// ── CAPITAL FLOW TRACKING ────────────────────────────────────────────────────
// A deposit or withdrawal is a CAPITAL event, not trading P&L. Without tracking it,
// "balance − starting capital" counts a deposit as profit (e.g. the $4k ACH on Jul 11
// showed as +$4k "gain"). This ledger records external cash flows so every P&L view can
// subtract them and stay trading-only — no manual re-baselining ever again.
//
// Storage: a single agentConfig JSON key per mode (`capital_flows_<mode>`) — no schema
// migration (the engine's raw-SQL tables must never be touched by `prisma db push`).
// Detection: the engine's own daily EOD balance snapshots + realized trade P&L (both in our DB —
// reliable and testable, unlike Tradovate's cashBalanceLog which returns empty for this account).
// For each day, the change in balance NOT explained by realized trading P&L is an external flow:
//     externalFlow_d = (eod_d − eod_{d-1}) − realizedPnL_d
// Amount > 0 = deposit, < 0 = withdrawal. Manual overrides take precedence over auto.
// (Validated Jul 11: the $4k ACH day computes exactly +4000; trading days net to < $50.)

export interface CapitalFlow {
  date: string;            // "YYYY-MM-DD" (ET trade date)
  amount: number;          // + deposit, − withdrawal (USD)
  source: "auto" | "manual";
  note?: string;
}

const NOISE_THRESHOLD = 50; // ignore sub-$50 residuals (fees/rounding vs realized P&L); real transfers are ≫this
const RECONCILE_TTL_MS = 60 * 60 * 1000; // re-scan at most hourly (detection is cheap DB reads)

function flowsKey(mode: TradingMode): string {
  return `capital_flows_${mode === "live" ? "live" : "demo"}`;
}
function reconcileGuardKey(mode: TradingMode): string {
  return `capital_flows_${mode === "live" ? "live" : "demo"}_last_reconcile`;
}

export async function getCapitalFlows(mode: TradingMode): Promise<CapitalFlow[]> {
  try {
    const row = await prisma.agentConfig.findUnique({ where: { key: flowsKey(mode) } });
    if (!row?.value) return [];
    const parsed = JSON.parse(row.value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function saveCapitalFlows(mode: TradingMode, flows: CapitalFlow[]): Promise<void> {
  const sorted = [...flows].sort((a, b) => a.date.localeCompare(b.date));
  await prisma.agentConfig.upsert({
    where: { key: flowsKey(mode) },
    update: { value: JSON.stringify(sorted) },
    create: { key: flowsKey(mode), value: JSON.stringify(sorted) },
  });
}

// Sum of flows with date STRICTLY AFTER the funded inception. The inception baseline
// (starting_capital_live) already bakes in any deposit up to and including inception day,
// so only later flows adjust P&L — this prevents double-counting the funding deposit.
export function netFlowsAfterInception(flows: CapitalFlow[], inceptionDate: string): number {
  return flows
    .filter((f) => f.date > inceptionDate)
    .reduce((s, f) => s + (f.amount || 0), 0);
}

// Manual override / backstop: record a confirmed deposit or withdrawal. Wins over auto on the same date.
export async function recordManualFlow(mode: TradingMode, date: string, amount: number, note?: string): Promise<CapitalFlow[]> {
  const flows = await getCapitalFlows(mode);
  const others = flows.filter((f) => f.date !== date || f.source !== "manual");
  if (amount === 0) {
    // amount 0 = delete any manual flow on that date
    await saveCapitalFlows(mode, others);
    return others;
  }
  const next: CapitalFlow[] = [...others.filter((f) => f.date !== date), { date, amount, source: "manual", note }];
  await saveCapitalFlows(mode, next);
  return next;
}

interface ReconcileResult {
  flows: CapitalFlow[];
  detected: CapitalFlow[];          // freshly computed auto flows (for validation/debug)
  logs?: { date: string; eod: number; dBal: number; realized: number; flow: number }[]; // per-day series, only when debug
  ran: boolean;                     // false if skipped due to TTL cache
  error?: string;
}

// Auto-detect external cash flows from engine EOD balance snapshots + realized trade P&L.
// Idempotent: re-running recomputes the "auto" flows from scratch and preserves any "manual"
// overrides. Best-effort — on any DB failure it returns the stored flows unchanged so callers never break.
export async function reconcileCapitalFlows(mode: TradingMode, opts: { force?: boolean; debug?: boolean } = {}): Promise<ReconcileResult> {
  const stored = await getCapitalFlows(mode);

  // Hourly cache guard (avoid re-writing the ledger on every positions call)
  if (!opts.force) {
    try {
      const guard = await prisma.agentConfig.findUnique({ where: { key: reconcileGuardKey(mode) } });
      if (guard?.value && Date.now() - new Date(guard.value).getTime() < RECONCILE_TTL_MS) {
        return { flows: stored, detected: [], ran: false };
      }
    } catch { /* fall through and reconcile */ }
  }

  const isLive = mode === "live";
  const eodPrefix = isLive ? "live_eod_balance_" : "eod_balance_"; // note: "eod_balance_" does NOT match "live_eod_balance_"
  const tradePrefix = isLive ? "live_" : "futures_";              // the engine's authoritative rows for this mode

  const series: { date: string; eod: number; dBal: number; realized: number; flow: number }[] = [];
  const detected: CapitalFlow[] = [];
  try {
    // Daily EOD balances (engine-written). Archived pre-inception snapshots live under warmup_* and
    // are intentionally excluded, so live detection is clean from the funded baseline forward.
    const eodRows = await prisma.agentConfig.findMany({ where: { key: { startsWith: eodPrefix } } });
    const eod: Record<string, number> = {};
    for (const r of eodRows) {
      if (!r.key.startsWith(eodPrefix)) continue;
      const v = parseFloat(r.value);
      if (!isNaN(v)) eod[r.key.slice(eodPrefix.length)] = v;
    }

    // Realized trading P&L per ET calendar day.
    const trades = await prisma.autoTradeLog.findMany({
      where: { symbol: { startsWith: "FUT:" }, action: { startsWith: tradePrefix }, pnl: { not: null } },
      select: { pnl: true, createdAt: true },
    });
    const realized: Record<string, number> = {};
    for (const t of trades) {
      const d = new Date(t.createdAt).toLocaleDateString("en-CA", { timeZone: "America/New_York" });
      realized[d] = (realized[d] || 0) + (t.pnl || 0);
    }

    // externalFlow_d = (eod_d − eod_{d-1}) − realizedPnL_d
    const dates = Object.keys(eod).sort();
    for (let i = 1; i < dates.length; i++) {
      const d = dates[i], p = dates[i - 1];
      const dBal = eod[d] - eod[p];
      const rz = realized[d] || 0;
      const flow = dBal - rz;
      series.push({ date: d, eod: eod[d], dBal, realized: rz, flow });
      // The NEWEST snapshot is still revisable: the engine writes eod_d at 3:50 PM ET, then
      // overwrites it at the next session reset, so an evening trade (e.g. Sunday gold) briefly
      // shows as a phantom flow (realized P&L with no balance move yet — this recorded a fake
      // -$58 "withdrawal" on Jul 12). For the newest day only record unmistakable transfers;
      // smaller residuals resolve themselves once the next snapshot finalizes the day.
      const isNewestDay = i === dates.length - 1;
      const threshold = isNewestDay ? 500 : NOISE_THRESHOLD;
      if (Math.abs(flow) >= threshold) detected.push({ date: d, amount: Math.round(flow), source: "auto" });
    }
  } catch (e) {
    return { flows: stored, detected: [], ran: false, error: e instanceof Error ? e.message : "flow detection failed" };
  }

  // Merge: manual overrides win over auto on the same date.
  const manual = stored.filter((f) => f.source === "manual");
  const manualDates = new Set(manual.map((f) => f.date));
  const merged = [...manual, ...detected.filter((f) => !manualDates.has(f.date))];
  await saveCapitalFlows(mode, merged);
  try {
    await prisma.agentConfig.upsert({
      where: { key: reconcileGuardKey(mode) },
      update: { value: new Date().toISOString() },
      create: { key: reconcileGuardKey(mode), value: new Date().toISOString() },
    });
  } catch { /* guard write is best-effort */ }

  return { flows: merged, detected, logs: opts.debug ? series : undefined, ran: true };
}
