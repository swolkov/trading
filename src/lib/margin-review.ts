// POST-TRADE REVIEW (C4, Sep 15 2026) — the operating spec's seven questions, answered
// MECHANICALLY for every closed live round trip and written once to the vault's Decisions/ log.
//
//   1. Did it behave as paper?          paper exit path + paper-at-live-size vs the real net
//   2. Execution                        entry slip vs MODEL_CHASE_BP, fee vs the model
//   3. Was the stop appropriate?        exit kind, MAE in R, and what the twins did on the SAME signal
//   4. Size vs intent                   the card's notional vs what filled (±10% / ±30% bands)
//   5. Slippage flags                   entry and stop-fill slippage beyond 2× the model
//   6. Regime at entry vs exit          the BTC daily regime stamped at entry vs the one at exit
//   7. Variance or deterioration?       where this R sits in the sleeve's distribution + the rolling read
//
// The facts are pure (reviewFacts). The prose is a Sonnet paragraph under the same rules as the
// lessons extractor — and it is FORBIDDEN from proposing a parameter change: a paragraph that
// says "widen the stop" is dropped, not printed. Sleeves are pre-registered experiments; a review
// that nudged a parameter would turn measurement into curve-fitting. Without an API key the
// prose is skipped and the facts stand alone.
import Anthropic from "@anthropic-ai/sdk";
import { prisma } from "@/lib/db";
import { logDecision, vaultAppend } from "@/lib/vault";
import { getKrakenOHLC } from "@/lib/kraken-margin";
import { btcRegimeUp } from "@/lib/margin-regime";
import { loadSleeveRows } from "@/lib/margin-leaderboard";
import { rMultiple, rollingVerdict, type RollingState } from "@/lib/margin-metrics";
import { policyCutFor } from "@/lib/margin-shadow";

export const REVIEW_DONE_KEY = "margin_review_done";
export const REVIEW_MODEL_CHASE_BP = 10;        // = margin-synthesis MODEL_CHASE_BP (kept local: synthesis imports this file)
export const REVIEW_MODEL_FEE_PCT = 0.25;       // = MODEL_TAKER_FEE_PCT
export const REVIEW_MODEL_STOP_SLIP_BP = 70;    // = MODEL_STOP_SLIP_BP (EXPECTED_SLIP_PCT 0.7% × 100)
export const REVIEW_TWIN_SOURCES = ["swing-lev", "swing-wide", "swing-lock", "swing-pyr"] as const;
/** The verbs a review may never use with "the": the prose proposes no parameter change. */
export const FORBIDDEN_PROSE_RE = /\b(widen|tighten|raise|lower|loosen)\s+(the|your|its|our)\b/i;
export const PROSE_MAX_WORDS = 120;

/** The slice of a LiveFill (margin-synthesis.ts) the review reads. Structural, so the two files do not cycle. */
export interface ReviewFill {
  liveTxid: string; source: string; symbol: string; side: "long" | "short";
  realEntry: number; realVol: number; realEntryAt: string; realExit: number | null; realExitAt: string | null; realNet: number | null;
  realEntryFee: number; realExitFee: number;
  paperPnl: number | null; paperPnlAtLiveSize: number | null; paperReason: string | null; paperExit: number | null;
  entrySlipBp: number | null; feePctSide: number | null; stopFillSlipBp: number | null;
  exitKind: "stop" | "close" | null; mfeR: number | null; maeR: number | null; regime: string | null;
}
export interface TwinOutcome { source: string; pnl: number | null; reason: string | null; open: boolean }
export interface ReviewContext {
  twins: TwinOutcome[];                 // the other swing containers' rows on the same signal
  intendedNotional: number | null;      // the trade card's notional (liveNotional's intent)
  intendedRiskUsd: number | null;       // the card's riskUsd — one R in dollars at live size
  regimeAtExit: "up" | "down" | "unknown" | null;
  sleeveRs: number[];                   // the sleeve's resolved paper R-multiples (fee-inclusive)
  rolling: RollingState | null;
}
export type SizeBand = "within ±10%" | "off by 10–30%" | "off by >30%" | "unknown";
export type VarianceVerdict = "variance" | "watch" | "deterioration" | "insufficient";
export interface ReviewFacts {
  txid: string; symbol: string; side: string; source: string; closedAt: string; realNet: number | null;
  behaved: { ok: boolean | null; text: string };
  execution: { ok: boolean; entrySlipBp: number | null; feePctSide: number | null; text: string };
  stop: { exitKind: string; maeR: number | null; mfeR: number | null; twins: TwinOutcome[]; text: string };
  size: { band: SizeBand; ratio: number | null; intended: number | null; real: number; text: string };
  slippage: { flags: string[]; text: string };
  regime: { atEntry: string; atExit: string; flipped: boolean; text: string };
  variance: { verdict: VarianceVerdict; rMultiple: number | null; rPercentile: number | null; rolling: RollingState | null; text: string };
}

const money = (n: number) => `${n < 0 ? "−" : "+"}$${Math.abs(n).toFixed(0)}`;
const fin = (x: number | null | undefined): x is number => x != null && Number.isFinite(x);

export function sizeBand(intended: number | null, real: number): { band: SizeBand; ratio: number | null } {
  if (!fin(intended) || !(intended > 0) || !(real > 0)) return { band: "unknown", ratio: null };
  const ratio = real / intended;
  const off = Math.abs(ratio - 1);
  return { ratio, band: off <= 0.10 ? "within ±10%" : off <= 0.30 ? "off by 10–30%" : "off by >30%" };
}

/** Fraction of `sample` strictly below `x` (0–1); null on an empty sample. */
export function percentileOf(x: number, sample: number[]): number | null {
  const s = sample.filter(Number.isFinite);
  if (!s.length) return null;
  return s.filter((v) => v < x).length / s.length;
}

export function reviewFacts(f: ReviewFill, ctx: ReviewContext): ReviewFacts {
  const closedAt = f.realExitAt ?? f.realEntryAt;
  const real = f.realNet;
  // 1. Behaved as paper: same sign and within max($25, 20%) of the paper twin at live size.
  let behaved: ReviewFacts["behaved"];
  if (!fin(real) || !fin(f.paperPnlAtLiveSize)) {
    behaved = { ok: null, text: `paper twin ${f.paperPnlAtLiveSize == null ? "not resolved yet" : "unknown"} — no like-for-like number` };
  } else {
    const p = f.paperPnlAtLiveSize;
    const tol = Math.max(25, Math.abs(p) * 0.2);
    const sameSign = (real >= 0) === (p >= 0);
    const ok = sameSign && Math.abs(real - p) <= tol;
    behaved = { ok, text: `${ok ? "yes" : "NO"} — real ${money(real)} vs paper-at-live-size ${money(p)} (paper exit: ${f.paperReason ?? "open"}; live exit: ${f.exitKind ?? "?"})` };
  }
  // 2. Execution.
  const slipBad = fin(f.entrySlipBp) && f.entrySlipBp > REVIEW_MODEL_CHASE_BP * 2;
  const feeBad = fin(f.feePctSide) && f.feePctSide > REVIEW_MODEL_FEE_PCT * 1.2;
  const execution = {
    ok: !slipBad && !feeBad, entrySlipBp: f.entrySlipBp, feePctSide: f.feePctSide,
    text: `entry slip ${fin(f.entrySlipBp) ? `${f.entrySlipBp.toFixed(1)}bp` : "—"} vs ${REVIEW_MODEL_CHASE_BP}bp modelled${slipBad ? " (>2× — FLAG)" : ""}; fee ${fin(f.feePctSide) ? `${f.feePctSide.toFixed(3)}%` : "—"}/side vs ${REVIEW_MODEL_FEE_PCT}%${feeBad ? " (FLAG)" : ""}`,
  };
  // 3. The stop, and what the twins did on the same signal.
  const exitKind = f.exitKind === "stop" ? (fin(f.mfeR) && f.mfeR >= 1 ? "trailing stop" : "initial stop") : f.exitKind === "close" ? "market close (time stop / guardian)" : "open";
  const twinLines = ctx.twins.map((t) => `${t.source} ${t.open ? "still open" : t.pnl != null ? `${money(t.pnl)} (${t.reason ?? "?"})` : "no row"}`);
  const twinsResolved = ctx.twins.filter((t) => !t.open && t.pnl != null);
  let stopText = `${exitKind}; MAE ${fin(f.maeR) ? `${f.maeR.toFixed(2)}R` : "—"}, MFE ${fin(f.mfeR) ? `${f.mfeR.toFixed(2)}R` : "—"}`;
  if (twinLines.length) stopText += `; same signal in the twins: ${twinLines.join(" · ")}`;
  if (f.exitKind === "stop" && exitKind === "initial stop" && twinsResolved.length) {
    const allStopped = twinsResolved.every((t) => (t.pnl ?? 0) <= 0);
    stopText += allStopped
      ? ` — every twin lost too: the move went against the entry, not the stop width`
      : ` — a wider container survived this one: the difference is the exit rule, not the entry`;
  }
  const stop = { exitKind, maeR: f.maeR, mfeR: f.mfeR, twins: ctx.twins, text: stopText };
  // 4. Size vs intent.
  const realNotional = f.realEntry * f.realVol;
  const sb = sizeBand(ctx.intendedNotional, realNotional);
  const size = {
    band: sb.band, ratio: sb.ratio, intended: ctx.intendedNotional, real: realNotional,
    text: sb.band === "unknown" ? `filled $${realNotional.toFixed(0)}; no card notional to compare` : `${sb.band} — card intended $${(ctx.intendedNotional as number).toFixed(0)}, filled $${realNotional.toFixed(0)} (${((sb.ratio as number) * 100).toFixed(0)}%)`,
  };
  // 5. Slippage flags.
  const flags: string[] = [];
  if (slipBad) flags.push(`entry slippage ${(f.entrySlipBp as number).toFixed(0)}bp > 2× the ${REVIEW_MODEL_CHASE_BP}bp chase`);
  if (fin(f.stopFillSlipBp) && f.stopFillSlipBp > REVIEW_MODEL_STOP_SLIP_BP * 2) flags.push(`stop filled ${f.stopFillSlipBp.toFixed(0)}bp past the ledgered level (model ${REVIEW_MODEL_STOP_SLIP_BP}bp)`);
  const slippage = { flags, text: flags.length ? flags.join("; ") : `none${fin(f.stopFillSlipBp) ? ` (stop fill ${f.stopFillSlipBp.toFixed(0)}bp)` : ""}` };
  // 6. Regime.
  const atEntry = f.regime === "up" || f.regime === "down" ? f.regime : "unknown";
  const atExit = ctx.regimeAtExit ?? "unknown";
  const flipped = atEntry !== "unknown" && atExit !== "unknown" && atEntry !== atExit;
  const regime = { atEntry, atExit, flipped, text: flipped ? `BTC regime FLIPPED ${atEntry} → ${atExit} while the trade was open` : `BTC regime ${atEntry} at entry, ${atExit} at exit` };
  // 7. Variance vs deterioration.
  const R = fin(real) && fin(ctx.intendedRiskUsd) && ctx.intendedRiskUsd > 0 ? real / ctx.intendedRiskUsd : null;
  const pct = R != null ? percentileOf(R, ctx.sleeveRs) : null;
  let verdict: VarianceVerdict; let vtext: string;
  if (ctx.rolling === "DECAYING") { verdict = "deterioration"; vtext = `the sleeve's rolling-30 read is DECAYING — this loss is part of a significant fall, not noise`; }
  else if (ctx.sleeveRs.length < 30 || R == null || pct == null) { verdict = "insufficient"; vtext = `${ctx.sleeveRs.length}/30 resolved paper trades in the sleeve — no distribution to place this ${R != null ? `${R.toFixed(2)}R` : "trade"} against yet`; }
  else if (ctx.rolling === "cooling") { verdict = "watch"; vtext = `${R.toFixed(2)}R sits at the ${(pct * 100).toFixed(0)}th percentile of the sleeve's ${ctx.sleeveRs.length} paper R-multiples; rolling read is cooling (not significant) — watch`; }
  else if (pct < 0.05 || pct > 0.95) { verdict = "variance"; vtext = `${R.toFixed(2)}R is a tail outcome (${(pct * 100).toFixed(0)}th percentile of ${ctx.sleeveRs.length}); rolling read ${ctx.rolling ?? "stable"} — variance unless the rolling read turns`; }
  else { verdict = "variance"; vtext = `${R.toFixed(2)}R sits at the ${(pct * 100).toFixed(0)}th percentile of the sleeve's ${ctx.sleeveRs.length} paper R-multiples; rolling read ${ctx.rolling ?? "stable"} — inside the distribution, variance`; }
  return {
    txid: f.liveTxid, symbol: f.symbol, side: f.side, source: f.source, closedAt, realNet: real,
    behaved, execution, stop, size, slippage, regime,
    variance: { verdict, rMultiple: R, rPercentile: pct, rolling: ctx.rolling, text: vtext },
  };
}

/** True when the prose proposes no parameter change and fits the word budget. */
export function proseAllowed(text: string | null | undefined): boolean {
  if (!text || !text.trim()) return false;
  if (FORBIDDEN_PROSE_RE.test(text)) return false;
  return text.trim().split(/\s+/).length <= PROSE_MAX_WORDS;
}

export function reviewOneLiner(r: ReviewFacts): string {
  return `${r.symbol} ${r.side} (${r.source}) closed ${r.realNet != null ? money(r.realNet) : "—"}: behaved as paper ${r.behaved.ok == null ? "?" : r.behaved.ok ? "yes" : "NO"} · execution ${r.execution.ok ? "ok" : "FLAG"} · ${r.stop.exitKind} · size ${r.size.band} · slippage ${r.slippage.flags.length ? "FLAG" : "none"} · regime ${r.regime.flipped ? "flipped" : "held"} · ${r.variance.verdict}`;
}

/** Header + YAML + the seven answers + the prose (or why it is absent). Markdown for Decisions/. */
export function renderReview(r: ReviewFacts, prose: string | null, proseNote?: string): string {
  const y = (v: number | null | undefined, d = 2) => (fin(v) ? v.toFixed(d) : "null");
  return [
    `### Post-trade review — ${r.symbol} ${r.side} (${r.source}) — ${r.txid}`,
    "```yaml",
    `txid: "${r.txid}"`, `closed_at: "${r.closedAt}"`, `strategy: "kraken-margin/${r.source}"`, `real_net: ${y(r.realNet)}`,
    `behaved_as_paper: ${r.behaved.ok == null ? "unknown" : r.behaved.ok ? "yes" : "no"}`,
    `execution_ok: ${r.execution.ok}`, `entry_slip_bp: ${y(r.execution.entrySlipBp, 1)}`, `fee_pct_side: ${y(r.execution.feePctSide, 3)}`,
    `exit_kind: "${r.stop.exitKind}"`, `mae_r: ${y(r.stop.maeR)}`, `mfe_r: ${y(r.stop.mfeR)}`,
    `twins: [${r.stop.twins.map((t) => `"${t.source}: ${t.open ? "open" : t.pnl != null ? t.pnl.toFixed(0) : "none"}"`).join(", ")}]`,
    `size_band: "${r.size.band}"`, `size_ratio: ${y(r.size.ratio, 3)}`,
    `slippage_flags: ${r.slippage.flags.length}`,
    `regime_entry: "${r.regime.atEntry}"`, `regime_exit: "${r.regime.atExit}"`, `regime_flipped: ${r.regime.flipped}`,
    `r_multiple: ${y(r.variance.rMultiple)}`, `r_percentile: ${y(r.variance.rPercentile, 3)}`, `rolling: "${r.variance.rolling ?? "unknown"}"`, `verdict: "${r.variance.verdict}"`,
    "```",
    `1. **Behaved as paper?** ${r.behaved.text}`,
    `2. **Execution.** ${r.execution.text}`,
    `3. **Stop appropriate?** ${r.stop.text}`,
    `4. **Size vs intent.** ${r.size.text}`,
    `5. **Slippage.** ${r.slippage.text}`,
    `6. **Regime.** ${r.regime.text}`,
    `7. **Variance or deterioration?** ${r.variance.text}`,
    "",
    prose ? `> ${prose.trim().replace(/\n+/g, " ")}` : `> _(prose ${proseNote ?? "skipped"})_`,
    "",
  ].join("\n");
}

/** Sonnet, ≤120 words, the lessons extractor's rules, no parameter changes. null without a key or when the rules are broken. */
export async function reviewProse(r: ReviewFacts): Promise<{ text: string | null; note: string }> {
  if (!process.env.ANTHROPIC_API_KEY) return { text: null, note: "skipped — no API key" };
  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const prompt = `You are the post-trade reviewer for a Kraken US spot-margin desk run by a non-technical founder. Below are the mechanical facts of ONE closed live trade. Write ONE paragraph, at most ${PROSE_MAX_WORDS} words, plain English.

Rules:
- Judge on expectancy and the sleeve's distribution, never on this one outcome's size or the hit rate.
- Fees and give-back are this account's historical killers; say so when they are the story.
- If live diverged from paper, that is the first sentence and it says STOP scaling.
- Do NOT propose parameter changes (never write "widen/tighten/raise/lower the ..."). Sleeves are pre-registered experiments. You may say what a future, separately registered sleeve could test.
- Live stops trigger on Kraken's INDEX price; paper stops on last-trade candles — a stop-out that paper survived is a measurement difference, not an edge.
- No hedging filler. Start with whether this trade was variance or deterioration.

Facts:
${renderReview(r, null, "omitted").split("\n").slice(0, 30).join("\n")}`;
  const res = await anthropic.messages.create({ model: "claude-sonnet-5", max_tokens: 400, messages: [{ role: "user", content: prompt }] });
  const text = res.content.map((c) => (c.type === "text" ? c.text : "")).join("").trim();
  if (!text) return { text: null, note: "skipped — empty response" };
  if (FORBIDDEN_PROSE_RE.test(text)) return { text: null, note: "withheld — the model proposed a parameter change" };
  const words = text.split(/\s+/);
  return { text: words.length > PROSE_MAX_WORDS ? `${words.slice(0, PROSE_MAX_WORDS).join(" ")}…` : text, note: "sonnet" };
}

// ---- I/O: gathering the context and writing the review once per txid ----------------------

async function cfgGet(key: string): Promise<string | null> {
  return (await prisma.agentConfig.findUnique({ where: { key } }).catch(() => null))?.value ?? null;
}
async function cfgSet(key: string, value: string): Promise<void> {
  await prisma.agentConfig.upsert({ where: { key }, update: { value }, create: { key, value } });
}

/** BTC's daily regime as it stood at `atIso`: complete daily closes only, truncated at that instant. Fail-soft → null. */
export async function btcRegimeAt(atIso: string): Promise<"up" | "down" | "unknown" | null> {
  try {
    const at = new Date(atIso).getTime() / 1000;
    if (!Number.isFinite(at)) return null;
    const bars = await getKrakenOHLC("BTC/USD", 1440);
    const dedup = bars.filter((b, i) => i === bars.length - 1 || bars[i + 1].t !== b.t);
    const closes = dedup.filter((b) => b.t + 86_400 <= at).map((b) => b.c);
    const up = btcRegimeUp(closes);
    return up == null ? "unknown" : up ? "up" : "down";
  } catch { return null; }
}

/** Everything reviewFacts needs beyond the fill. Every piece is best-effort: a missing one reads as unknown. */
export async function reviewContextFor(f: ReviewFill): Promise<ReviewContext> {
  const ctx: ReviewContext = { twins: [], intendedNotional: null, intendedRiskUsd: null, regimeAtExit: null, sleeveRs: [], rolling: null };
  try {
    const others = REVIEW_TWIN_SOURCES.filter((s) => s !== f.source);
    const rows = await prisma.$queryRawUnsafe<{ source: string; shadow_pnl: number | null; shadow_reason: string | null; shadow_status: string | null }[]>(
      `SELECT source, shadow_pnl, shadow_reason, shadow_status FROM tradingview_alerts
       WHERE symbol=$1 AND side=$2 AND source = ANY($3::text[]) AND time BETWEEN $4::timestamptz - interval '20 minutes' AND $4::timestamptz + interval '20 minutes'
       ORDER BY time`,
      f.symbol, f.side === "long" ? "buy" : "sell", others, f.realEntryAt,
    );
    const seen = new Set<string>();
    for (const r of rows) {
      if (seen.has(r.source)) continue;
      seen.add(r.source);
      ctx.twins.push({ source: r.source, pnl: r.shadow_status === "resolved" ? r.shadow_pnl : null, reason: r.shadow_reason, open: r.shadow_status !== "resolved" });
    }
  } catch { /* twins are a comparison, not a requirement */ }
  try {
    const cards = await prisma.$queryRawUnsafe<{ card: { notional?: unknown; riskUsd?: unknown } | null }[]>(`SELECT card FROM margin_trade_cards WHERE txid=$1 AND card IS NOT NULL ORDER BY id DESC LIMIT 1`, f.liveTxid);
    const c = cards[0]?.card;
    if (c && typeof c === "object") {
      const n = Number(c.notional), r = Number(c.riskUsd);
      ctx.intendedNotional = Number.isFinite(n) && n > 0 ? n : null;
      ctx.intendedRiskUsd = Number.isFinite(r) && r > 0 ? r : null;
    }
  } catch { /* no card → size unknown */ }
  try {
    const all = await loadSleeveRows({ source: f.source });
    ctx.sleeveRs = all.map(rMultiple).filter((x): x is number => x != null);
    const cut = all.filter((r) => r.time > policyCutFor(f.source));
    ctx.rolling = rollingVerdict(cut).state;
  } catch { /* no distribution → insufficient */ }
  if (f.realExitAt) ctx.regimeAtExit = await btcRegimeAt(f.realExitAt);
  return ctx;
}

export interface ReviewRun { reviewed: string[]; skipped: number; errors: string[] }

/**
 * Review every CLOSED live fill not yet reviewed, once each (REVIEW_DONE_KEY = the txids done).
 * Writes Decisions/<today>.md via logDecision (the one-line rationale) plus the full block. A
 * failure on one fill is logged and never blocks the next; nothing here throws out.
 */
export async function runPostTradeReviews(fills: ReviewFill[], opts: { withProse?: boolean } = {}): Promise<ReviewRun> {
  const out: ReviewRun = { reviewed: [], skipped: 0, errors: [] };
  let done: string[] = [];
  try { done = JSON.parse((await cfgGet(REVIEW_DONE_KEY)) ?? "[]") as string[]; } catch { done = []; }
  const doneSet = new Set(done);
  for (const f of fills) {
    if (!f.realExitAt || f.realNet == null || f.source === "roundtrip") { out.skipped++; continue; }
    if (doneSet.has(f.liveTxid)) { out.skipped++; continue; }
    try {
      const ctx = await reviewContextFor(f);
      const facts = reviewFacts(f, ctx);
      const prose = opts.withProse === false ? { text: null, note: "skipped" } : await reviewProse(facts).catch((e) => ({ text: null, note: `failed: ${String(e).slice(0, 60)}` }));
      const checks = [facts.behaved.ok !== false, facts.execution.ok, facts.size.band === "within ±10%" || facts.size.band === "unknown", facts.slippage.flags.length === 0];
      const confidence = checks.filter(Boolean).length / checks.length;
      await logDecision("kraken-margin", "EXIT", f.symbol, reviewOneLiner(facts), confidence);
      const today = new Date().toISOString().slice(0, 10);
      await vaultAppend(`Decisions/${today}.md`, renderReview(facts, prose.text, prose.note), "margin-review");
      doneSet.add(f.liveTxid);
      out.reviewed.push(f.liveTxid);
    } catch (e) {
      out.errors.push(`${f.liveTxid}: ${String(e).slice(0, 80)}`);
    }
  }
  if (out.reviewed.length) await cfgSet(REVIEW_DONE_KEY, JSON.stringify([...doneSet].slice(-500))).catch(() => {});
  return out;
}
