// BUILDING THE DESK BRIEF (Sep 15 2026) — gathers renderDeskBrief's input from what the desk
// already holds, every block behind a soft catch so one dead source blanks one section ("—"),
// never the brief. Publishes to the vault (Brain/crypto-desk-brief.md), the AgentConfig key
// margin_brief_latest (what /api/margin/brief and the /margin panel read — no Kraken call of
// their own) and Slack margin_results. Live positions come from the CACHED display snapshot
// (marginDisplaySnapshot) — never a direct private read from here.
//
// Scheduled by the margin scan: the first tick after 13:00 UTC each day (briefDue), guarded by
// the route's deadline. No cron of its own.
import { prisma } from "@/lib/db";
import { sendNotification } from "@/lib/notifications";
import { vaultWrite } from "@/lib/vault";
import { marginDisplaySnapshot } from "@/lib/kraken-margin";
import type { TfFeatures } from "@/lib/margin-scanner";
import { recentPaperTrades, strategyBreakdown, type StrategyStat } from "@/lib/margin-shadow";
import { leaderboard, type LeaderboardRow } from "@/lib/margin-leaderboard";
import { weeklyAction } from "@/lib/margin-weekly";
import { loadLiveFills, divergenceSummary, readStage3, readDemotion } from "@/lib/margin-synthesis";
import { DECAY_MULT_KEY, readDecayState } from "@/lib/margin-decay";
import { CUSHION_WARN_AT } from "@/lib/margin-live-risk";
import type { RiskState } from "@/lib/margin-risk-tiers";
import { refreshCryptoRegime } from "@/lib/margin-crypto-regime";
import { cushionUsed, deriveAction, renderDeskBrief, type BriefInput, type BriefOpportunity } from "@/lib/margin-brief";

export const BRIEF_LATEST_KEY = "margin_brief_latest";
export const BRIEF_VAULT_PATH = "Brain/crypto-desk-brief.md";
export const BRIEF_HOUR_UTC = 13;

export interface BriefLatest { at: string; action: string; reason: string; text: string; sections: number }

/** Pure: is today's brief due at `nowMs`? First run at/after 13:00 UTC, once per UTC day. */
export function briefDue(lastDay: string | null | undefined, nowMs: number): { due: boolean; day: string } {
  const d = new Date(nowMs);
  const day = d.toISOString().slice(0, 10);
  return { due: d.getUTCHours() >= BRIEF_HOUR_UTC && lastDay !== day, day };
}

const cfg = async (k: string): Promise<string | null> => prisma.agentConfig.findUnique({ where: { key: k } }).then((r) => r?.value ?? null).catch(() => null);
const soft = <T,>(p: Promise<T>, fallback: T): Promise<T> => p.catch(() => fallback);

export interface BuildOpts { features?: Record<string, TfFeatures> | null; opportunities?: BriefOpportunity[] | null; nowMs?: number }

/** Gather everything; never throws. */
export async function buildDeskBrief(opts: BuildOpts = {}): Promise<BriefInput> {
  const at = new Date(opts.nowMs ?? Date.now()).toISOString();
  const [regimeRes, opps, paper, strategies, board, fills, stage3, demoted, decayState, decayMult, snap, riskRaw, anomaly, auto, validate, sourcesRaw, breaker] = await Promise.all([
    soft(refreshCryptoRegime(opts.features ?? null), null),
    opts.opportunities ? Promise.resolve(opts.opportunities) : cfg("margin_scan_last_result").then((raw) => { try { return raw ? ((JSON.parse(raw) as { look?: BriefOpportunity[] }).look ?? []) : []; } catch { return []; } }),
    soft(recentPaperTrades(100), []),
    soft(strategyBreakdown(), [] as StrategyStat[]),
    soft(leaderboard(), [] as LeaderboardRow[]),
    soft(loadLiveFills(), []),
    soft(readStage3(), null),
    soft(readDemotion(), null),
    soft(readDecayState(), null),
    cfg(DECAY_MULT_KEY),
    soft(marginDisplaySnapshot().then((c) => c.value), null),
    cfg("kraken_margin_risk_state"),
    cfg("kraken_margin_anomaly"),
    cfg("kraken_margin_auto"), cfg("kraken_margin_validate_only"), cfg("kraken_margin_live_sources"), cfg("kraken_margin_disarmed_dd"),
  ]);
  const sources = (sourcesRaw ?? "").split(",").map((x) => x.trim()).filter(Boolean);
  let risk: RiskState | null = null;
  try { risk = riskRaw ? (JSON.parse(riskRaw) as RiskState) : null; } catch { risk = null; }
  const livePositions = (snap?.positions ?? []).map((p) => {
    const px = p.value != null && p.vol > 0 ? p.value / p.vol : null;
    return { pair: p.pair, side: p.side, leverage: p.leverage, entryPrice: p.entryPrice, net: p.net, cushionUsed: cushionUsed(p.side, p.entryPrice, p.leverage, px) };
  });
  const div = divergenceSummary(fills);
  const actions = strategies.map((s) => ({ key: s.key, action: weeklyAction(s, board.find((r) => r.key === s.key)?.promotion ?? null) }));
  return {
    at,
    regime: regimeRes?.regime ?? null,
    opportunities: opps,
    paperOpen: paper.filter((r) => r.status === "open" && r.usTradeable).map((r) => ({ symbol: r.symbol, side: r.side, source: r.source, entry: r.entry, unrealized: r.unrealized, ageH: r.ageH, maxHoldH: r.maxHoldH })),
    livePositions,
    livePositionsAt: snap?.readAt ?? null,
    strategies: strategies.map((s) => ({ key: s.key, label: s.label, resolved: s.resolved, hitRate: s.hitRate, liveNet: s.liveNet, tStat: s.tStat, verdict: s.verdict, action: actions.find((a) => a.key === s.key)?.action })),
    live: { armed: auto === "true", validateOnly: validate !== "false", sources, stage3: stage3 ? { status: stage3.status, done: stage3.done, target: stage3.target } : null, fills: { count: div.fills, closed: div.closed, realNet: div.realNet, verdict: div.verdict } },
    review: {
      underReview: actions.filter((a) => /KILL CANDIDATE|REDUCE|PROMOTE-READY/.test(a.action)).map((a) => `${a.key}: ${a.action}`),
      demoted: demoted ? { source: demoted.source, reason: demoted.reason } : null,
      decay: { multiplier: decayMult, state: decayState?.state ?? null, source: decayState?.source ?? null },
      anomaly: anomaly && anomaly.trim() ? anomaly.slice(0, 200) : null,
    },
    risk: {
      equity: snap?.health.equity ?? risk?.equity ?? null,
      marginLevel: snap?.health.marginLevel ?? null,
      dd: risk?.dd ?? null, tier: risk?.tier ?? null, mult: risk?.mult ?? null, losersToday: risk?.losersToday ?? null,
      exposure: risk?.exposure ? { grossNotional: risk.exposure.grossNotional, netNotional: risk.exposure.netNotional, riskIfAllStopsHitUsd: risk.exposure.riskIfAllStopsHitUsd, riskIfAllStopsHitPct: risk.exposure.riskIfAllStopsHitPct, breakerHeadroomPct: risk.exposure.breakerHeadroomPct, clusterOk: risk.exposure.clusterOk } : null,
      cushionWarn: livePositions.some((p) => p.cushionUsed != null && p.cushionUsed >= CUSHION_WARN_AT),
      breakerTripped: breaker === "true",
    },
  };
}

/** Build, render, publish (vault + key + Slack). Never throws; returns what it wrote. */
export async function publishDeskBrief(opts: BuildOpts = {}): Promise<BriefLatest | null> {
  try {
    const input = await buildDeskBrief(opts);
    const text = renderDeskBrief(input);
    const { action, reason } = deriveAction(input);
    const latest: BriefLatest = { at: input.at, action, reason, text, sections: 8 };
    await prisma.agentConfig.upsert({ where: { key: BRIEF_LATEST_KEY }, update: { value: JSON.stringify(latest) }, create: { key: BRIEF_LATEST_KEY, value: JSON.stringify(latest) } }).catch(() => {});
    await vaultWrite(BRIEF_VAULT_PATH, text, "margin-desk").catch(() => {});
    // Slack gets the digest — the regime and the action — and points at the vault for the rest.
    const digest = text.split("\n## ")[1]?.split("\n").slice(1).filter((l) => l.startsWith("- ")).join("\n") ?? "";
    await sendNotification(`🗞 Crypto desk brief ${input.at.slice(0, 10)} — *${action}* — ${reason}\n${digest}\n_Full eight-section brief in the vault: Brain/crypto-desk-brief.md (and the /margin page)._`, "margin_results").catch(() => {});
    return latest;
  } catch (e) {
    console.error("[desk-brief]", String(e).slice(0, 200));
    return null;
  }
}

export async function readLatestBrief(): Promise<BriefLatest | null> {
  try {
    const raw = await cfg(BRIEF_LATEST_KEY);
    const p = raw ? (JSON.parse(raw) as BriefLatest) : null;
    return p && typeof p.text === "string" && typeof p.at === "string" ? p : null;
  } catch { return null; }
}
