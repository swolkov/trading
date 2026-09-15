// FUTURES DESK — the desk brief's I/O (E8): gather the keys the guardian already writes (regime, event
// policy, risk state, anomaly, feed), the watch rows of the last 24 h and the latest ledger entry, hand
// them to the pure brief, then write the result to the vault (`Brain/futures-desk-brief.md`, the same
// DB-backed vault the reviews use), the Slack lane and `futures_desk_brief_latest`. Triggered by the
// guardian right after the daily review (same day key); the API can also render it live — no broker
// call anywhere here. Fail-soft: a failed write is a guardian note. Imports the store, never futures-desk.ts.
import { sendNotification } from "@/lib/notifications";
import { vaultWrite } from "@/lib/vault";
import { EVENT_POLICY_KEY, eventWindowText, nextRollByRoot, parseEventPolicy } from "@/lib/futures-desk-calendar";
import { renderFuturesBrief, type BriefAction, type BriefEntry, type BriefInput, type BriefWatch } from "@/lib/futures-desk-brief";
import { parseRiskState } from "@/lib/futures-desk-risk";
import { etDayKey, type DeskLimits } from "@/lib/futures-desk-rules";
import { parseAnomaly, feedStale } from "@/lib/futures-desk-safety";
import { EXPECTED_MOVE_ATR_K, REGIME_KEY, parseRegime } from "@/lib/futures-desk-score";
import { ANOMALY_KEY, FEED_SEEN_KEY, LANE, cfg, deskEnabled, ensureDeskTables, loadState, rawRows, setKey } from "@/lib/futures-desk-store";
import { rollGuardDays } from "@/lib/tradovate-desk";

export const BRIEF_KEY = "futures_desk_brief_latest";
export const BRIEF_VAULT_PATH = "Brain/futures-desk-brief.md";
const WRITER = "futures-desk";

export interface BriefLatest { at: string; action: BriefAction; markdown: string }
export function parseBriefLatest(raw: string | null | undefined): BriefLatest | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as Record<string, unknown>;
    if (!v || typeof v.at !== "string" || typeof v.markdown !== "string" || !["NO TRADE", "REDUCE", "WAIT"].includes(String(v.action))) return null;
    return { at: v.at, action: v.action as BriefAction, markdown: v.markdown };
  } catch { return null; }
}

type WatchRow = { edge: string; root: string; side: string; price: number; stop: number | null; score: number | null; reason: string | null; received_at: string };
type EntryRow = {
  id: number; contract: string; micro: string; side: string; qty: number; entry_price: number; stop_price: number; risk_usd: number; stop_points: number | null; atr_at_entry: number | null;
  session: string | null; regime: string | null; event_mode: string | null; grade: string | null; mfe_r: number | null; opened_at: string; status: string; score: number | null;
};

/** Everything the brief reads, from keys and the two tables only. */
export async function briefInputNow(limits: DeskLimits, now = new Date()): Promise<BriefInput> {
  await ensureDeskTables();
  const [state, enabled, regimeRaw, policyRaw, riskRaw, anomalyRaw, feedSeenAt, watches, entries] = await Promise.all([
    loadState(), deskEnabled(), cfg(REGIME_KEY), cfg(EVENT_POLICY_KEY), cfg("futures_desk_risk_state"), cfg(ANOMALY_KEY), cfg(FEED_SEEN_KEY),
    rawRows<WatchRow>(`SELECT edge, root, side, price, stop, score, reason, received_at FROM futures_desk_signals WHERE action = 'watch' AND status = 'watch' AND reason NOT LIKE 'watch cap%' AND received_at > now() - interval '24 hours' ORDER BY score DESC NULLS LAST, id DESC LIMIT 20`),
    rawRows<EntryRow>(
      `SELECT t.id, t.contract, t.micro, t.side, t.qty, t.entry_price, t.stop_price, t.risk_usd, t.stop_points, t.atr_at_entry, t.session, t.regime, t.event_mode, t.grade, t.mfe_r, t.opened_at, t.status, s.score
       FROM futures_desk_trades t LEFT JOIN futures_desk_signals s ON s.id = t.signal_id
       WHERE t.status = 'open' OR (t.opened_at AT TIME ZONE 'America/New_York')::date = $1::date ORDER BY (t.status = 'open') DESC, t.id DESC LIMIT 1`, etDayKey(now)),
  ]);
  const policy = parseEventPolicy(policyRaw);
  const risk = parseRiskState(riskRaw);
  const tier = risk?.tier ?? 0;
  const halted = !enabled || !!state.disabledReason || tier >= 4;
  const paused = policy?.mode === "paused" || (risk != null && risk.dailyLossRemaining <= 0);
  const anomaly = parseAnomaly(anomalyRaw) != null;
  const stale = feedStale(feedSeenAt, now.getTime());
  const reasons: string[] = [];
  if (!enabled) reasons.push("desk disabled");
  if (state.disabledReason) reasons.push(state.disabledReason);
  if (tier >= 4) reasons.push("drawdown tier 4 — halted");
  if (policy?.mode === "paused") reasons.push(`event window: ${eventWindowText(policy) ?? policy.reason}`);
  if (risk != null && risk.dailyLossRemaining <= 0) reasons.push("daily loss budget spent");
  if (anomaly) reasons.push("anomaly open — entries paused");
  if (stale) reasons.push(`feed stale (last heartbeat ${feedSeenAt ?? "never"})`);
  const e = entries[0];
  const entry: BriefEntry | null = e ? {
    contract: e.contract, micro: e.micro, side: e.side, qty: e.qty, entryPrice: e.entry_price, stopPrice: e.stop_price, riskUsd: e.risk_usd, stopPoints: e.stop_points, atr: e.atr_at_entry,
    session: e.session, regime: e.regime, eventMode: e.event_mode, grade: e.grade, score: e.score, mfeR: e.mfe_r, openedAt: e.opened_at, status: e.status,
  } : null;
  const openRows = await rawRows<{ root: string; contract: string }>(`SELECT root, contract FROM futures_desk_trades WHERE status = 'open' ORDER BY id`);
  const openPositions = openRows.length;
  const held = Object.fromEntries(openRows.map((r) => [r.root, r.contract]));   // the guardian rolls the HELD month, so the brief shows its date
  return {
    generatedAt: now.toISOString(),
    regime: parseRegime(regimeRaw),
    event: policy ? { mode: policy.mode, reason: policy.reason, window: eventWindowText(policy) } : null,
    rolls: nextRollByRoot(now, rollGuardDays, undefined, held),
    watches: watches.map((w): BriefWatch => ({ edge: w.edge, root: w.root, side: w.side, price: w.price, stop: w.stop, score: w.score, card: w.reason, receivedAt: w.received_at })),
    entry,
    state: { halted, paused, anomaly, feedStale: stale, openPositions, ddTier: tier, watchCount: watches.length, reasons },
    stage: limits.stage,
    k: EXPECTED_MOVE_ATR_K,
  };
}

/** Render now and write everywhere: vault, Slack, the latest key. Returns guardian notes. */
export async function runDeskBrief(limits: DeskLimits, now = new Date()): Promise<string[]> {
  const notes: string[] = [];
  const { markdown, action } = renderFuturesBrief(await briefInputNow(limits, now));
  await setKey(BRIEF_KEY, JSON.stringify({ at: now.toISOString(), action, markdown } satisfies BriefLatest)).catch((e) => notes.push(`brief: key not saved — ${String(e).slice(0, 120)}`));
  try { await vaultWrite(BRIEF_VAULT_PATH, markdown, WRITER); notes.push(`brief: ${action} — written to ${BRIEF_VAULT_PATH}`); }
  catch (e) { notes.push(`brief: vault write failed — ${String(e).slice(0, 120)}`); }
  const head = markdown.split("\n").find((l) => l.startsWith("**")) ?? action;
  await sendNotification(`📋 FUTURES DESK brief ${etDayKey(now)}: ${head}`, LANE).catch(() => notes.push("brief: Slack failed"));
  return notes;
}
