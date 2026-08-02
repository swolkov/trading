/**
 * VAULT SESSION GATES — the mapping from synthesis-agent time buckets to engine session names, and
 * the rule for how a bucket's win rate blocks or shrinks trading in that session.
 *
 * SHARED ON PURPOSE (2026-08-02). The engine gates on this and the admin must be able to SHOW it.
 * These anti-patterns are written automatically by the synthesis agent, so a future run could emit
 * e.g. `mid_morning ... 22% win rate` and silently shut off live's primary window — live only trades
 * London 03:00-09:00 and the morning 09:45-12:00 — with no alert and nothing visible in admin. You
 * would just see zero trades and no reason. A second copy of this table in the web app would drift
 * from the engine's copy and start describing a gate that no longer matches the one being enforced,
 * so both import this one.
 */

export interface VaultSessionRule { pattern: string; sessions: string[]; label: string }

/** Synthesis buckets are ET-aware: first_30_min = 9:30-10:00, last_30_min = 3:30-4:00 PM,
 *  after_hours = 4:00 PM+ (the ETH sessions). */
export const VAULT_SESSION_RULES: VaultSessionRule[] = [
  { pattern: "first_30_min", sessions: ["open", "morning"], label: "first 30 min" },
  { pattern: "mid_morning", sessions: ["morning"], label: "mid-morning" },
  { pattern: "midday", sessions: ["midday"], label: "midday/lunch" },
  { pattern: "afternoon", sessions: ["afternoon"], label: "afternoon" },
  { pattern: "last_30_min", sessions: ["close"], label: "last 30 min" },
  { pattern: "after_hours", sessions: ["eth_evening", "eth_asia", "eth_europe", "pre_market"], label: "after hours / ETH" },
];

/** Win rate the synthesis agent recorded for a bucket, or null if it never mentioned it. */
export function vaultWinRateFor(antiPatterns: string, pattern: string): number | null {
  const ap = antiPatterns.toLowerCase();
  if (!ap.includes(pattern)) return null;
  const m = ap.match(new RegExp(`${pattern}[^\\n]*?(\\d+)%\\s*win\\s*rate`));
  return m ? parseInt(m[1], 10) : null;
}

/** BLOCK under 30%, half size under 40% — the thresholds the engine enforces. */
export function vaultVerdict(winRate: number | null): "block" | "half" | "ok" {
  if (winRate === null) return "ok";
  if (winRate < 30) return "block";
  if (winRate < 40) return "half";
  return "ok";
}

/** Every session currently blocked or reduced, for display. */
export function activeVaultGates(antiPatterns: string): { session: string; label: string; winRate: number; effect: "block" | "half" }[] {
  const out: { session: string; label: string; winRate: number; effect: "block" | "half" }[] = [];
  for (const rule of VAULT_SESSION_RULES) {
    const wr = vaultWinRateFor(antiPatterns, rule.pattern);
    const v = vaultVerdict(wr);
    if (v === "ok" || wr === null) continue;
    for (const s of rule.sessions) out.push({ session: s, label: rule.label, winRate: wr, effect: v });
  }
  return out;
}
