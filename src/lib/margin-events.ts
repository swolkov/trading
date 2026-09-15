// THE CRYPTO DESK'S EVENT VETO (Sep 15 2026). The guardian computes an EventPolicy every run
// (event-calendar.ts, Finnhub + the static table) and writes it to kraken_margin_event_policy;
// the executor reads it back here and turns the mode into a sizing multiplier — or a refusal.
//
// FAIL-SAFE DIRECTION, stated once: a policy that is missing, unparseable, or older than 20
// minutes (the guardian runs every 5) reads as REDUCED, not normal and not paused. The feed
// can never open the desk wider than the calendar allows, and a dead guardian already halts
// entries through margin_watch_protect_ok — so "reduced" here is the honest middle: trade at
// half size on a stale calendar rather than pretend the calendar is clear.
// kraken_margin_event_veto="false" is the operator's off switch (mode normal, said so).
import { prisma } from "@/lib/db";
import type { EventMode, EventPolicy } from "@/lib/event-calendar";

export const EVENT_POLICY_KEY = "kraken_margin_event_policy";
export const EVENT_VETO_KEY = "kraken_margin_event_veto";
export const EVENT_POLICY_MAX_AGE_MS = 20 * 60_000;

export function eventRiskMultiplier(mode: EventMode): number {
  if (mode === "paused") return 0;
  if (mode === "reduced") return 0.5;
  return 1;
}

/** Pure: the stored policy JSON + the veto switch → the policy the executor acts on. */
export function resolveEventPolicy(raw: string | null | undefined, vetoRaw: string | null | undefined, nowMs: number): EventPolicy & { stale: boolean; source?: string } {
  const at = new Date(nowMs).toISOString();
  if (vetoRaw === "false") return { mode: "normal", reason: "event veto off (kraken_margin_event_veto=false)", nextEvent: null, at, stale: false };
  if (!raw) return { mode: "reduced", reason: "policy stale/missing — no event policy written yet", nextEvent: null, at, stale: true };
  let parsed: (EventPolicy & { source?: string }) | null = null;
  try { parsed = JSON.parse(raw) as EventPolicy & { source?: string }; } catch { parsed = null; }
  if (!parsed || typeof parsed !== "object" || (parsed.mode !== "normal" && parsed.mode !== "reduced" && parsed.mode !== "paused") || typeof parsed.at !== "string") {
    return { mode: "reduced", reason: "policy stale/missing — unparseable kraken_margin_event_policy", nextEvent: null, at, stale: true };
  }
  const writtenAt = Date.parse(parsed.at);
  if (!Number.isFinite(writtenAt) || nowMs - writtenAt > EVENT_POLICY_MAX_AGE_MS) {
    return { mode: "reduced", reason: `policy stale/missing — last written ${parsed.at}`, nextEvent: parsed.nextEvent ?? null, at, stale: true };
  }
  return { ...parsed, nextEvent: parsed.nextEvent ?? null, stale: false };
}

/** STRICT: a database failure throws, and the executor refuses the entry. */
export async function readEventPolicy(nowMs: number = Date.now()): Promise<ReturnType<typeof resolveEventPolicy>> {
  const [policy, veto] = await Promise.all([
    prisma.agentConfig.findUnique({ where: { key: EVENT_POLICY_KEY } }),
    prisma.agentConfig.findUnique({ where: { key: EVENT_VETO_KEY } }),
  ]);
  return resolveEventPolicy(policy?.value ?? null, veto?.value ?? null, nowMs);
}
