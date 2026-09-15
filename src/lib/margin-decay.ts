// STRATEGY DECAY → REDUCE BEFORE DEMOTE (C3, Sep 15 2026).
//
// The demotion rule (margin-synthesis.ts) is binary: a sleeve runs at full size until its
// forward record is not paying at 30 resolved, then it is disarmed. Between those two states
// nothing answered "is the edge fading?". This does, with the rolling read from
// margin-metrics.ts: when the LAST 30 resolved trades of the armed sleeve are significantly
// worse than the trades before them (Welch t ≤ −2 → DECAYING), live risk is HALVED by writing
// kraken_margin_decay_multiplier = 0.5 — the executor's one multiplier chain
// (liveRiskPctChain, A1) already reads that key on every entry, so nothing else has to change
// for the reduction to bite. It is restored to 1 only when the read is back to `stable`;
// `cooling` keeps the reduction (hysteresis — a sleeve does not get its size back for one
// good week). A DECAYING sleeve whose last 30 are also net ≤ 0 is handed to demotionVerdict's
// third rule and disarmed; demotion resets the multiplier.
//
// Runs inside maybeDemote() on every armed scan tick and in the daily synthesis, so no cron.
// Only the ARMED sleeve is read (the same arm predicate as demotion). The transition itself
// is pure (decayTransition) and test-pinned; this file's I/O is four config keys and Slack.
import { prisma } from "@/lib/db";
import { sendNotification } from "@/lib/notifications";
import { loadSleeveRows } from "@/lib/margin-leaderboard";
import { ROLLING_WINDOW, rollingVerdict, type RollingState, type RollingVerdict } from "@/lib/margin-metrics";
import { parseDecayMultiplier } from "@/lib/margin-risk-tiers";

export const DECAY_MULT_KEY = "kraken_margin_decay_multiplier";
export const DECAY_STATE_KEY = "kraken_margin_decay_state";
export const DECAY_REDUCED_MULT = "0.5";
export const DECAY_FULL_MULT = "1";

export interface DecayState {
  source: string; state: RollingState; at: string; welchT: number | null;
  last30Net: number; lastExpectancy: number | null; priorExpectancy: number | null;
  reducedAt?: string;   // when the 0.5× was written; absent at 1×
  note: string;
}
export type DecayChange = "REDUCED" | "RESTORED" | null;

/**
 * THE PURE RULE. `current` is the raw kraken_margin_decay_multiplier. DECAYING → 0.5 (written
 * only if it is not already 0.5, so Slack pages once). `stable` → 1, but only from the 0.5 this
 * rule wrote: an unreadable value stays unreadable (the executor is refusing on it and a human
 * should see why) and a hand-set 0.25 is not this rule's to undo. `cooling` and `insufficient`
 * keep whatever is there — the hysteresis.
 */
export function decayTransition(current: string | null | undefined, state: RollingState): { next: string | null; change: DecayChange } {
  const cur = parseDecayMultiplier(current);
  if (state === "DECAYING") {
    return cur === 0.5 ? { next: DECAY_REDUCED_MULT, change: null } : { next: DECAY_REDUCED_MULT, change: "REDUCED" };
  }
  if (state === "stable" && cur === 0.5) return { next: DECAY_FULL_MULT, change: "RESTORED" };
  return { next: current ?? null, change: null };
}

async function cfgGet(key: string): Promise<string | null> {
  return (await prisma.agentConfig.findUnique({ where: { key } }).catch(() => null))?.value ?? null;
}
async function cfgRequired(key: string): Promise<string> {
  const row = await prisma.agentConfig.findUnique({ where: { key } });
  if (!row?.value) throw new Error(`Required risk config unavailable: ${key}`);
  return row.value;
}
async function cfgSet(key: string, value: string): Promise<void> {
  await prisma.agentConfig.upsert({ where: { key }, update: { value }, create: { key, value } });
}
async function armLog(line: string): Promise<void> {
  try {
    const raw = await cfgGet("kraken_margin_arm_log"); const log: string[] = raw ? JSON.parse(raw) : [];
    log.push(line);
    await cfgSet("kraken_margin_arm_log", JSON.stringify(log.slice(-50)));
  } catch { /* log only */ }
}

export async function readDecayState(): Promise<DecayState | null> {
  const raw = await cfgGet(DECAY_STATE_KEY);
  if (!raw) return null;
  try { return JSON.parse(raw) as DecayState; } catch { return null; }
}

export interface DecayRun { source: string; rolling: RollingVerdict; multiplier: string | null; change: DecayChange; state: DecayState }

/**
 * Read the armed sleeve's rolling record and move the multiplier by the rule above. Returns
 * null when nothing is armed. Throws when the arm predicate's keys are unreadable — the same
 * fail-closed behaviour as maybeDemote, whose caller marks the tick's entry checks failed.
 */
export async function maybeDecayReduce(): Promise<DecayRun | null> {
  const [auto, validate, sources] = await Promise.all([cfgRequired("kraken_margin_auto"), cfgRequired("kraken_margin_validate_only"), cfgRequired("kraken_margin_live_sources")]);
  if (!(auto === "true" && validate === "false")) return null;
  const source = (sources ?? "").split(",").map((x) => x.trim()).filter(Boolean)[0];
  if (!source) throw new Error("Armed source unavailable");
  const rows = await loadSleeveRows({ source });
  const rolling = rollingVerdict(rows, ROLLING_WINDOW);
  const current = await cfgGet(DECAY_MULT_KEY);
  const { next, change } = decayTransition(current, rolling.state);
  const prev = await readDecayState();
  const at = new Date().toISOString();
  const state: DecayState = {
    source, state: rolling.state, at, welchT: rolling.welchT,
    last30Net: rolling.last.net, lastExpectancy: rolling.last.expectancy, priorExpectancy: rolling.prior?.expectancy ?? null,
    note: rolling.note,
  };
  if (change === "REDUCED") state.reducedAt = at;
  else if (change !== "RESTORED" && parseDecayMultiplier(next) === 0.5) state.reducedAt = prev?.reducedAt ?? at;
  if (change === "REDUCED") {
    await cfgSet(DECAY_MULT_KEY, DECAY_REDUCED_MULT);   // risk down FIRST
    await armLog(`${at} REDUCED to 0.5× risk: ${source} is DECAYING — ${rolling.note}. Restores to 1× by itself only when the rolling read is stable again (cooling keeps 0.5×).`);
    const msg = `⚠️ REDUCED to 0.5× risk: ${source}'s last ${rolling.window} paper trades are significantly worse than its record — ${rolling.note}. Live entries now risk half (kraken_margin_decay_multiplier=0.5). It restores by itself only on a stable read; if the last 30 are also net ≤ $0 the sleeve is demoted.`;
    await sendNotification(msg, "margin_live").catch(() => {});
    await sendNotification(msg, "margin_urgent").catch(() => {});
  } else if (change === "RESTORED") {
    await cfgSet(DECAY_MULT_KEY, DECAY_FULL_MULT);
    await armLog(`${at} RESTORED to 1× risk: ${source}'s rolling read is stable again — ${rolling.note}.`);
    await sendNotification(`✅ RESTORED to 1× risk: ${source}'s rolling read is stable again — ${rolling.note}.`, "margin_live").catch(() => {});
  }
  await cfgSet(DECAY_STATE_KEY, JSON.stringify(state));
  return { source, rolling, multiplier: next, change, state };
}
