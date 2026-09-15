import { prisma } from "@/lib/db";
import { sendNotification } from "@/lib/notifications";
import { vaultAppend, vaultWrite } from "@/lib/vault";
import { strategyBreakdown, candidateDetail, SLICE_MIN_RESOLVED, EXPERIMENT_SOURCES, type StrategyStat, type CandidateDetail } from "@/lib/margin-shadow";
import { capacityReport, type CapacityReport } from "@/lib/margin-capacity";
import { loadLiveFills, divergenceSummary, readStage3, readDemotion, type LiveFill, type Divergence, type Stage3, type Demotion } from "@/lib/margin-synthesis";
import { RETIRED_AUTO_SOURCES } from "@/lib/margin-auto-plans";
import { leaderboard, type LeaderboardRow, type PromotionVerdict } from "@/lib/margin-leaderboard";

// ── THE MONDAY REVIEW ──────────────────────────────────────────────────────────────────────
// One page a week, written by rule, not by mood: where the live book stands, whether the
// forward record is holding, what fees and slippage are taking, what the refused setups
// cost, and — for every sleeve — KEEP, KILL CANDIDATE, or PROMOTE-READY under the same
// verdict ladder the arm switch uses. It changes nothing. The two automatic gates (stage 3
// graduation, demotion) act; this page is what a founder reads so nothing acts unseen.

export type WeeklyAction = "PROMOTE-READY" | "REDUCE · decaying" | "KEEP · paper-only (no container)" | "KILL CANDIDATE" | "KEEP · gathering" | "KEEP · promising" | "retired";

/**
 * With the promotion verdict (margin-leaderboard.ts) the ladder reads the FULL gate — drawdown,
 * profit factor, decay and a live container on top of the scoreboard's four — so PROMOTE-READY
 * means the same thing here as on the page. Without it (older callers) the scoreboard verdict
 * alone decides, exactly as before.
 */
export function weeklyAction(s: Pick<StrategyStat, "key" | "resolved" | "liveNet" | "verdict">, promotion?: Pick<PromotionVerdict, "ready" | "stage"> | null): WeeklyAction {
  if (RETIRED_AUTO_SOURCES.has(s.key) || s.verdict.startsWith("retired")) return "retired";
  if (promotion) {
    if (promotion.stage === "REDUCE") return "REDUCE · decaying";
    if (promotion.ready) return "PROMOTE-READY";
    if (promotion.stage === "PAPER-ONLY") return "KEEP · paper-only (no container)";
  } else if (s.verdict.startsWith("REAL EDGE")) return "PROMOTE-READY";
  if (s.resolved >= 30 && s.liveNet <= 0) return "KILL CANDIDATE";
  if (s.resolved < 30) return "KEEP · gathering";
  return "KEEP · promising";
}

export interface WeeklyInput {
  at: string;
  live: { armed: boolean; sources: string[]; equity: number | null; equityPeak: number | null };
  stage3: Stage3 | null;
  demoted: Demotion | null;
  fills: LiveFill[];
  div: Divergence;
  strategies: StrategyStat[];
  candidate: CandidateDetail | null;
  capacity: CapacityReport | null;
  leaderboard?: LeaderboardRow[];   // per-sleeve metrics + the explicit gate (absent on older callers)
}

const money = (n: number) => `${n < 0 ? "−" : ""}$${Math.abs(n).toFixed(0)}`;
const pct = (n: number | null | undefined) => (n == null ? "—" : `${(n * 100).toFixed(0)}%`);
const tf = (t: number | null | undefined) => (t == null ? "—" : t.toFixed(2));
const pfText = (pf: number | null | undefined) => (pf == null ? "—" : pf === Infinity ? "∞" : pf.toFixed(2));

export function renderWeeklyMemo(i: WeeklyInput): string {
  const L: string[] = [];
  const day = i.at.slice(0, 10);
  L.push("---", `last_updated: "${day}"`, 'updated_by: "margin-weekly"', "tags: [performance, margin, weekly, review]", "---", "");
  L.push(`# Margin desk — Monday review (${day})`, "");
  L.push("> Written by rule every Monday 13:00 UTC. It changes nothing: stage-3 graduation and automatic demotion act on their own; this page makes sure nothing acts unseen. Read the ACTION column, then the forward slice, then fees.", "");

  // 1. Live book
  const closed = i.fills.filter((f) => f.closed && f.source !== "roundtrip");
  const realNet = closed.reduce((a, f) => a + (f.realNet ?? 0), 0);
  const winsLive = closed.filter((f) => (f.realNet ?? 0) > 0).length;
  L.push("## 1 · Live book", "");
  L.push(`- Executor: **${i.demoted ? "DEMOTED to paper" : i.live.armed ? "ARMED" : "disarmed"}** · sleeve: ${i.live.sources.join(", ") || "none"} · equity ${i.live.equity != null ? money(i.live.equity) : "?"}${i.live.equityPeak != null && i.live.equity != null ? ` (peak ${money(i.live.equityPeak)}, ${((i.live.equity / i.live.equityPeak - 1) * 100).toFixed(1)}% from peak)` : ""}`);
  if (i.demoted) L.push(`- ⛔ Demoted ${i.demoted.at.slice(0, 16).replace("T", " ")} UTC: ${i.demoted.reason}`);
  if (i.stage3) L.push(`- Stage 3: **${i.stage3.status}** · ${i.stage3.done ?? 0}/${i.stage3.target} closed live trades at base ${i.stage3.fromBase}% → ${i.stage3.toBase}%${i.stage3.note ? ` · ${i.stage3.note}` : ""}`);
  L.push(`- Closed live trades: ${closed.length} (${winsLive} won) · real net ${money(realNet)} · paper on the same trades at live size ${money(i.div.paperNet)} · verdict: ${i.div.verdict}`);
  L.push(`- Execution: avg entry slippage ${i.div.avgEntrySlipBp != null ? `${i.div.avgEntrySlipBp.toFixed(0)}bp` : "—"} (model ${i.div.modelChaseBp}bp) · avg fee/side ${i.div.avgFeePctSide != null ? `${i.div.avgFeePctSide.toFixed(3)}%` : "—"} (model ${i.div.modelFeePct}%)`, "");

  // 2. The forward record
  const c = i.candidate;
  L.push("## 2 · Is the rule holding? (forward-only record of the live candidate)", "");
  if (c?.forward) {
    const f = c.forward;
    const read = f.resolved >= SLICE_MIN_RESOLVED;
    L.push(`- Forward-only: **${f.resolved} resolved** · ${pct(f.hitRate)} hit · net ${money(f.net)} (paper-sized) · t=${tf(f.tStat)} · ${f.days} days · ${f.open} open → ${read ? (f.net > 0 && (f.tStat ?? 0) >= 2 ? "**holding, significant**" : f.net > 0 ? "**positive, could be luck**" : "**NOT PAYING**") : `watching (${f.resolved}/${SLICE_MIN_RESOLVED} before it is read)`}`);
    const cuts = [...c.byTimeframe.map((s) => ({ ...s, key: `tf ${s.key}` })), ...c.byEntryWindow.map((s) => ({ ...s, key: `entry ${s.key}` }))];
    const readable = cuts.filter((s) => s.resolved >= SLICE_MIN_RESOLVED);
    L.push(`- Pre-registered cuts readable this week: ${readable.length ? readable.map((s) => `${s.key} ${s.resolved} res, net ${money(s.net)}, t=${tf(s.tStat)}`).join(" · ") : "none yet (each needs " + SLICE_MIN_RESOLVED + " resolved)"}`);
  } else L.push("- No forward record yet.");
  L.push("");

  // 3. Fees
  const cand = i.strategies.find((s) => s.key === (i.live.sources[0] ?? "selective"));
  L.push("## 3 · What fees are taking", "");
  if (cand && cand.grossPnl !== 0) {
    const share = cand.fees / Math.max(1, Math.abs(cand.grossPnl) + 0);
    L.push(`- ${cand.label}: gross ${money(cand.grossPnl)} · fees ${money(-cand.fees)} · net ${money(cand.totalPnl)} → fees are **${(share * 100).toFixed(0)}% of gross**. Fees fall by themselves with Kraken volume tiers; nothing to do by hand.`);
  } else L.push("- No fee data for the candidate yet.");
  L.push("");

  // 4. Capacity
  L.push("## 4 · Cost of capacity", "");
  if (i.capacity) {
    const cap = i.capacity; const live = (n: number) => money(n * cap.liveFactor);
    L.push(`- Since arming: ${cap.setups} setups · ${cap.taken} taken · ${cap.refused.total} refused (${cap.refused.slots} slots full, ${cap.refused.cooldown} cooldown, ${cap.refused.dailyCap} daily cap). Refused went on to ${live(cap.refusedOutcome.net)} resolved + ${live(cap.refusedOutcome.floating)} floating at live size.`);
    const cur = cap.replay.find((r) => r.slots === cap.rules.slots); const more = cap.replay.find((r) => r.slots === cap.rules.slots + 1);
    if (cur && more) L.push(`- One more slot would have: taken ${more.taken} vs ${cur.taken}, net ${live(more.net)} vs ${live(cur.net)}. ${more.net > cur.net ? "More, on this sample — still not a reason to raise it before the $10k rung." : "No better. Keep the slots."}`);
  } else L.push("- Not armed yet — nothing to measure.");
  L.push("");

  // 5. Sleeves
  L.push("## 5 · Every sleeve — keep, kill, promote", "");
  L.push("| sleeve | resolved | open | hit | net (live-sized) | t | days | ACTION | Sharpe | Sortino | PF | max DD | avg R | MAE (R) | rolling 30 |", "|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|");
  const rows = i.strategies.filter((s) => s.resolved > 0 || s.open > 0).sort((a, b) => b.resolved - a.resolved);
  const boardOf = (key: string) => i.leaderboard?.find((r) => r.key === key) ?? null;
  const actionOf = (s: StrategyStat) => weeklyAction(s, boardOf(s.key)?.promotion ?? null);
  for (const s of rows) {
    const a = actionOf(s);
    const twin = EXPERIMENT_SOURCES.includes(s.key) ? " · twin, not pooled" : "";
    const b = boardOf(s.key); const m = b?.metrics;
    const cols = m
      ? `${tf(m.sharpe)} | ${tf(m.sortino)} | ${pfText(m.profitFactor)} | ${m.maxDDPct != null ? `${(m.maxDDPct * 100).toFixed(1)}% (${m.maxDDTrades} tr)` : "—"} | ${m.avgR != null ? `${m.avgR.toFixed(2)}R` : "—"} | ${m.maeR != null ? `${m.maeR.toFixed(2)}R` : "—"} | ${b!.rolling.state}`
      : "— | — | — | — | — | — | —";
    L.push(`| ${s.label}${twin} | ${s.resolved}${s.forwardResolved != null ? ` (${s.forwardResolved} fwd)` : ""} | ${s.open} | ${pct(s.hitRate)} | ${money(s.liveNet)} | ${tf(s.tStat)} | ${s.days ?? "—"} | **${a}** | ${cols} |`);
  }
  L.push("", "ACTION ladder: KEEP · gathering (<30 resolved) → KEEP · promising (positive, t<2, or short of the full gate) → PROMOTE-READY (every gate green: 30+ forward, net>0 at live sizing, t≥2, 7+ days, max DD inside the breaker, PF≥1.2, rolling not DECAYING, a guardian-mirrored container) · KEEP · paper-only (every gate green but no live container — it cannot be armed) · REDUCE · decaying (the last 30 are significantly worse than the record — live risk is halved by rule) · KILL CANDIDATE (30+ resolved, net ≤ 0 at live sizing — retire it by hand; the live sleeve demotes itself). Sharpe/Sortino rank and gate nothing (overlapping crypto trades inflate them). A twin is promoted only by beating its base on the same signals.", "");

  // 6. What changes
  const kills = rows.filter((s) => actionOf(s) === "KILL CANDIDATE").map((s) => s.key);
  const promos = rows.filter((s) => actionOf(s) === "PROMOTE-READY").map((s) => s.key);
  const reduces = rows.filter((s) => actionOf(s) === "REDUCE · decaying").map((s) => s.key);
  L.push("## 6 · What changes this week", "");
  if (!kills.length && !promos.length && !reduces.length && !i.demoted) L.push("- **Nothing.** No rule fired. Leave every parameter alone; the samples are still being earned.");
  if (promos.length) L.push(`- PROMOTE-READY: ${promos.join(", ")} — the paper gate is green; arming is Spencer's decision on Live Desk.`);
  if (reduces.length) L.push(`- REDUCE · decaying: ${reduces.join(", ")} — the rolling-30 record is significantly worse than the rest; if armed, live risk is already halved by rule (kraken_margin_decay_multiplier). Nothing to do by hand; watch whether it restores.`);
  if (kills.length) L.push(`- KILL CANDIDATE: ${kills.join(", ")} — retire by adding to RETIRED_AUTO_SOURCES (open trades still resolve).`);
  if (i.demoted) L.push(`- DEMOTED: ${i.demoted.source} — read the record before acknowledging; arming again is a separate act.`);
  L.push("");
  return L.join("\n");
}

export async function runMarginWeekly(): Promise<{ ok: boolean; path: string; actions: string[] }> {
  const cfg = async (k: string) => prisma.agentConfig.findUnique({ where: { key: k } }).then((r) => r?.value ?? null).catch(() => null);
  const [auto, validate, sourcesRaw, watchState, peakRaw] = await Promise.all([cfg("kraken_margin_auto"), cfg("kraken_margin_validate_only"), cfg("kraken_margin_live_sources"), cfg("margin_watch_state"), cfg("kraken_margin_equity_peak")]);
  const sources = (sourcesRaw ?? "").split(",").map((x) => x.trim()).filter(Boolean);
  const candSource = sources[0] || "selective";
  let equity: number | null = null;
  try { const p = watchState ? (JSON.parse(watchState) as { lastEquity?: number }) : null; equity = p?.lastEquity && p.lastEquity > 0 ? p.lastEquity : null; } catch { equity = null; }
  const peak = peakRaw ? parseFloat(peakRaw) : NaN;
  const [strategies, candidate, capacity, fills, stage3, demoted, board] = await Promise.all([
    strategyBreakdown().catch(() => [] as StrategyStat[]),
    candidateDetail(candSource).catch(() => null),
    capacityReport(candSource).catch(() => null),
    loadLiveFills().catch(() => [] as LiveFill[]),
    readStage3().catch(() => null),
    readDemotion().catch(() => null),
    leaderboard().catch(() => [] as LeaderboardRow[]),
  ]);
  const at = new Date().toISOString();
  const memo = renderWeeklyMemo({
    at, live: { armed: auto === "true" && validate === "false", sources, equity, equityPeak: Number.isFinite(peak) && peak > 0 ? peak : null },
    stage3, demoted, fills, div: divergenceSummary(fills), strategies, candidate, capacity, leaderboard: board,
  });
  const path = "Performance/margin-weekly.md";
  await vaultWrite(path, memo, "margin-weekly");
  const actions = strategies.filter((s) => s.resolved > 0 || s.open > 0).map((s) => `${s.key}: ${weeklyAction(s, board.find((r) => r.key === s.key)?.promotion ?? null)}`);
  const headline = actions.filter((a) => /PROMOTE-READY|KILL CANDIDATE|REDUCE/.test(a));
  await vaultAppend("Performance/margin-weekly-log.md", `\n- [${at.slice(0, 10)}] ${headline.length ? headline.join(" · ") : "no rule fired — nothing changes"}${demoted ? ` · DEMOTED ${demoted.source}` : ""}`, "margin-weekly").catch(() => {});
  await sendNotification(`📋 Monday review written to the vault (${path}). ${headline.length ? headline.join(" · ") : "No rule fired — nothing changes this week."}`, "margin_results").catch(() => {});
  return { ok: true, path, actions };
}
