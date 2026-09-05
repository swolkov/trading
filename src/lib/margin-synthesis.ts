// MARGIN SYNTHESIS — the learning loop for the Kraken margin desk, paper AND live.
//
// Once a day it (1) reads the paper scoreboard (every sleeve's resolved trades, net, t-stat,
// verdict), (2) matches every paper row that was ALSO traded live to its real Kraken fills
// (entry price, fees, exit) and measures the divergence — slippage vs the modelled chase, real
// fee per side vs the modelled 0.15%/0.25%, real net vs paper net — (3) writes the vault:
// Performance/margin-statistics.md (regenerated), Journal/YYYY-MM-DD.md (a YAML block per
// live round trip, once), Lessons/raw-observations.md (what moved), and (4) when there is new
// material, asks a model for the desk's lessons → Lessons/margin-lessons.md.
//
// It NEVER changes a strategy parameter. The paper sleeves are pre-registered experiments;
// tuning them on their own results would turn measurement into curve-fitting. It reports;
// a human (or a deliberate PR) changes the code.
import Anthropic from "@anthropic-ai/sdk";
import { prisma } from "@/lib/db";
import { sendNotification } from "@/lib/notifications";
import { vaultWrite, vaultAppend, vaultRead, logObservation } from "@/lib/vault";
import { strategyBreakdown, shadowScore, edgeBreakdowns, ensureShadowColumns, positionNotional, type StrategyStat, type ShadowScore, type EdgeBreakdowns } from "@/lib/margin-shadow";
import { pairBase } from "@/lib/kraken-pairs";

export const SYNTH_LAST_RUN = "margin_synthesis_last_run";
export const SYNTH_JOURNALED = "margin_synthesis_journaled";
export const MODEL_CHASE_BP = 10;          // the paper model's entry chase (0.1%)
export const MODEL_TAKER_FEE_PCT = 0.25;   // the paper model's fee assumptions (calibrated to real fills, Aug 31)
export const MODEL_MAKER_FEE_PCT = 0.15;

// ---- Pure matching -------------------------------------------------------------------------

export interface PaperLiveRow {
  id: number; time: string; symbol: string; side: string; source: string | null; leverage: number | null;
  markPrice: number | null; shadowStatus: string | null; shadowExit: number | null; shadowPnl: number | null;
  shadowFees: number | null; shadowReason: string | null; shadowResolvedAt: string | null; liveTxid: string;
  paperNotional?: number | null;   // the paper model's position size for this row (ref equity × risk ÷ stop)
}
export interface TradeRow { txid: string; ordertxid: string; pair: string; time: string; type: string; price: number; cost: number; fee: number; vol: number; margin: number; posstatus: string }
export interface LiveFill {
  rowId: number; source: string; symbol: string; side: "long" | "short"; liveTxid: string;
  signalPrice: number | null; paperEntry: number | null; paperExit: number | null; paperPnl: number | null; paperFees: number | null; paperReason: string | null;
  realEntry: number; realVol: number; realEntryFee: number; realEntryAt: string;
  realExit: number | null; realExitFee: number; realExitAt: string | null; realNet: number | null;
  paperPnlAtLiveSize: number | null;   // paper P&L rescaled to the live notional — the like-for-like number
  entrySlipBp: number | null; feePctSide: number | null; closed: boolean;
}

/** Match each live-traded paper row to its Kraken fills. Entry = the trades on our order
 *  txid; exit = the next closing fills on the same pair after it, FIFO, never reused. */
export function matchLiveFills(rows: PaperLiveRow[], trades: TradeRow[]): LiveFill[] {
  const byTime = [...trades].sort((a, b) => new Date(a.time).getTime() - new Date(b.time).getTime());
  const consumed = new Map<string, number>();   // trade txid → volume already allocated
  const out: LiveFill[] = [];
  const sortedRows = [...rows].sort((a, b) => new Date(a.time).getTime() - new Date(b.time).getTime());
  for (const r of sortedRows) {
    const entries = byTime.filter((t) => t.ordertxid === r.liveTxid);
    const vol = entries.reduce((s, t) => s + t.vol, 0);
    if (!(vol > 0)) continue;
    const cost = entries.reduce((s, t) => s + t.cost, 0);
    const realEntry = cost / vol;
    const entryFee = entries.reduce((s, t) => s + t.fee, 0);
    const entryAt = entries[0].time;
    const side: "long" | "short" = entries[0].type === "buy" ? "long" : "short";
    const closeType = side === "long" ? "sell" : "buy";
    // Closing fills: opposite type, same pair, after the entry, flagged as position-closing.
    let need = vol; let exitCost = 0; let exitFee = 0; let exitAt: string | null = null;
    for (const t of byTime) {
      if (need <= vol * 1e-6) break;
      const samePair = pairBase(t.pair) === pairBase(entries[0].pair) || pairBase(t.pair) === pairBase(r.symbol.replace("/", ""));
      if (t.type !== closeType || !samePair) continue;
      if (new Date(t.time).getTime() <= new Date(entryAt).getTime()) continue;
      if (!(t.posstatus && t.posstatus.length) && !(t.margin > 0)) continue;   // spot fills are not closes
      const left = t.vol - (consumed.get(t.txid) ?? 0);
      if (left <= 0) continue;
      const take = Math.min(left, need);
      const frac = take / t.vol;
      exitCost += t.cost * frac; exitFee += t.fee * frac; need -= take; exitAt = t.time;
      consumed.set(t.txid, (consumed.get(t.txid) ?? 0) + take);
    }
    const closed = need <= vol * 1e-6;
    const filledVol = vol - need;
    const realExit = closed && filledVol > 0 ? exitCost / filledVol : null;
    const realNet = realExit != null ? (side === "long" ? (realExit - realEntry) : (realEntry - realExit)) * vol - entryFee - exitFee : null;
    const signal = r.markPrice != null && r.markPrice > 0 ? (r.side === "buy" ? r.markPrice / (1 + MODEL_CHASE_BP / 1e4) : r.markPrice / (1 - MODEL_CHASE_BP / 1e4)) : null;
    const entrySlipBp = signal ? (side === "long" ? realEntry / signal - 1 : 1 - realEntry / signal) * 1e4 : null;
    const paperPnlAtLiveSize = r.shadowPnl != null && r.paperNotional != null && r.paperNotional > 0 ? r.shadowPnl * (cost / r.paperNotional) : null;
    out.push({
      rowId: r.id, source: r.source ?? "manual", symbol: r.symbol, side, liveTxid: r.liveTxid,
      signalPrice: signal, paperEntry: r.markPrice, paperExit: r.shadowExit, paperPnl: r.shadowPnl, paperFees: r.shadowFees, paperReason: r.shadowReason,
      realEntry, realVol: vol, realEntryFee: entryFee, realEntryAt: entryAt,
      realExit, realExitFee: closed ? exitFee : 0, realExitAt: closed ? exitAt : null, realNet, paperPnlAtLiveSize,
      entrySlipBp, feePctSide: cost > 0 ? (entryFee / cost) * 100 : null, closed,
    });
  }
  return out;
}

export interface Divergence {
  fills: number; closed: number; avgEntrySlipBp: number | null; modelChaseBp: number;
  avgFeePctSide: number | null; modelFeePct: number; realNet: number; paperNet: number; verdict: string;
}
export function divergenceSummary(fills: LiveFill[]): Divergence {
  const measured = fills.filter((f) => f.source !== "roundtrip");
  const slips = measured.map((f) => f.entrySlipBp).filter((x): x is number => x != null);
  const fees = measured.map((f) => f.feePctSide).filter((x): x is number => x != null);
  const closed = measured.filter((f) => f.closed);
  const avg = (a: number[]) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : null);
  const realNet = closed.reduce((s, f) => s + (f.realNet ?? 0), 0);
  // Paper is sized off a fixed reference equity; live off the real account (and, early on, a
  // per-entry cap). Compare paper RESCALED to each trade's live size, never raw dollars.
  const paperNet = closed.reduce((s, f) => s + (f.paperPnlAtLiveSize ?? 0), 0);
  const avgSlip = avg(slips); const avgFee = avg(fees);
  let verdict = "no live fills yet";
  if (measured.length) {
    const bad: string[] = [];
    if (avgSlip != null && avgSlip > MODEL_CHASE_BP * 2) bad.push(`entry slippage ${avgSlip.toFixed(0)}bp vs ${MODEL_CHASE_BP}bp modelled`);
    if (avgFee != null && avgFee > MODEL_TAKER_FEE_PCT * 1.2) bad.push(`fee ${avgFee.toFixed(3)}%/side vs ${MODEL_TAKER_FEE_PCT}% modelled`);
    if (closed.length >= 5 && paperNet > 0 && realNet < paperNet * 0.5) bad.push(`real net $${realNet.toFixed(0)} vs paper $${paperNet.toFixed(0)} (paper rescaled to live size) on the same trades`);
    verdict = bad.length ? `LIVE DIVERGES FROM PAPER — ${bad.join("; ")}. Stop and recalibrate the paper model before scaling.` : closed.length >= 20 ? "live matches paper on 20+ trades — stage 3 reconciliation passed" : `live tracking paper so far (${closed.length}/20 closed trades reconciled)`;
  }
  return { fills: measured.length, closed: closed.length, avgEntrySlipBp: avgSlip, modelChaseBp: MODEL_CHASE_BP, avgFeePctSide: avgFee, modelFeePct: MODEL_TAKER_FEE_PCT, realNet, paperNet, verdict };
}

// ---- Rendering -----------------------------------------------------------------------------

const money = (n: number) => `${n < 0 ? "−" : ""}$${Math.abs(n).toFixed(0)}`;
const pct = (n: number | null) => (n == null ? "—" : `${(n * 100).toFixed(0)}%`);

export function renderStatistics(input: { at: string; strategies: StrategyStat[]; shadow: ShadowScore | null; edges: EdgeBreakdowns; fills: LiveFill[]; div: Divergence; live: { armed: boolean; sources: string[]; equity: number | null } }): string {
  const s = input.strategies.filter((x) => x.resolved > 0 || x.open > 0);
  const lines: string[] = [];
  lines.push("---", `last_updated: "${input.at.slice(0, 10)}"`, 'updated_by: "margin-synthesis"', "tags: [performance, margin, paper, live]", "---", "");
  lines.push("# Margin desk — statistics (auto-generated daily)", "");
  lines.push(`> Generated ${input.at}. Paper = every sleeve scored on real Kraken prices with real fees. Live = the bot's real fills, matched to the paper row they came from. **Nothing here changes a parameter** — the sleeves are pre-registered experiments; this file reports.`, "");
  lines.push("## Live book", "");
  lines.push(`- Executor: **${input.live.armed ? "ARMED" : "disarmed"}** · armed sources: ${input.live.sources.length ? input.live.sources.join(", ") : "none"} · equity at last guardian run: ${input.live.equity != null ? money(input.live.equity) : "?"}`);
  lines.push(`- Live vs paper: **${input.div.verdict}**`);
  lines.push(`- Fills matched: ${input.div.fills} (${input.div.closed} closed) · avg entry slippage ${input.div.avgEntrySlipBp != null ? `${input.div.avgEntrySlipBp.toFixed(1)}bp` : "—"} (model ${input.div.modelChaseBp}bp) · avg fee/side ${input.div.avgFeePctSide != null ? `${input.div.avgFeePctSide.toFixed(3)}%` : "—"} (model ${input.div.modelFeePct}%) · real net ${money(input.div.realNet)} vs paper ${money(input.div.paperNet)} on the same closed trades`, "");
  if (input.fills.length) {
    lines.push("| when | sleeve | pair | side | real entry | paper entry | slip bp | real exit | paper exit | real net | paper net (at live size) |", "|---|---|---|---|---|---|---|---|---|---|---|");
    for (const f of input.fills.slice(-30)) {
      lines.push(`| ${f.realEntryAt.slice(0, 16)} | ${f.source} | ${f.symbol} | ${f.side} | ${f.realEntry.toFixed(2)} | ${f.paperEntry?.toFixed(2) ?? "—"} | ${f.entrySlipBp?.toFixed(1) ?? "—"} | ${f.realExit?.toFixed(2) ?? "open"} | ${f.paperExit?.toFixed(2) ?? "open"} | ${f.realNet != null ? money(f.realNet) : "—"} | ${f.paperPnlAtLiveSize != null ? money(f.paperPnlAtLiveSize) : "—"} |`);
    }
    lines.push("");
  }
  lines.push("## Paper scoreboard (the record that earns arming)", "");
  lines.push("| sleeve | resolved | hit | net (live-sized) | t | days-independent verdict |", "|---|---|---|---|---|---|");
  for (const x of s) lines.push(`| ${x.label} | ${x.resolved} (${x.open} open) | ${pct(x.hitRate)} | ${money(x.liveNet)} | ${x.tStat?.toFixed(2) ?? "—"} | ${x.verdict} |`);
  lines.push("", "Verdict ladder: gathering → not paying → promising (could be luck) → **REAL EDGE** (30+ resolved, net>0 at live sizing, t≥2, 7+ distinct days). Arm nothing below REAL EDGE.", "");
  if (input.shadow) lines.push(`Shadow totals (current cohort, US universe): ${input.shadow.resolved} resolved · ${pct(input.shadow.hitRate)} hit · net ${money(input.shadow.totalPnl)} · ${input.shadow.open} open (${money(input.shadow.openUnrealized)} unrealized).`, "");
  const top = (arr: { key: string; resolved: number; totalPnl: number; hitRate: number | null }[], n: number) => [...arr].filter((e) => e.resolved >= 3).sort((a, b) => b.totalPnl - a.totalPnl).slice(0, n);
  const dir = input.edges.byDirection; const coins = top(input.edges.byCoin as { key: string; resolved: number; totalPnl: number; hitRate: number | null }[], 8);
  if (dir.length) lines.push("## Edges", "", "By direction: " + dir.map((e) => `${e.key} ${e.resolved} trades, ${pct(e.hitRate)} hit, ${money(e.totalPnl)}`).join(" · "), "");
  if (coins.length) lines.push("Best coins (3+ resolved): " + coins.map((e) => `${e.key} ${money(e.totalPnl)} (${e.resolved})`).join(" · "), "");
  lines.push("## How this file is used", "", "- The synthesis agent regenerates it daily (cron `margin-synthesis`, 00:20 UTC) and appends what moved to `Lessons/raw-observations.md`.", "- Live round trips are journaled once each in `Journal/YYYY-MM-DD.md`.", "- Model-extracted lessons live in `Lessons/margin-lessons.md`.", "- Stage 3 of the go-live plan is the live-vs-paper line above: ~20 reconciled trades that match, or stop and recalibrate.");
  return lines.join("\n");
}

export function journalBlock(f: LiveFill): string {
  const d = (f.realExitAt ?? f.realEntryAt).slice(0, 10);
  return [
    `### Live margin round trip — ${f.symbol} ${f.side} (${f.source})`,
    "```yaml",
    `trade_id: "${d}-${f.liveTxid}"`, `timestamp_entry: "${f.realEntryAt}"`, `timestamp_exit: "${f.realExitAt ?? ""}"`,
    `instrument: "${f.symbol}"`, `direction: "${f.side.toUpperCase()}"`, `strategy: "kraken-margin/${f.source}"`, `book: "live"`,
    `volume: ${f.realVol}`, `entry_price: ${f.realEntry.toFixed(2)}`, `exit_price: ${f.realExit?.toFixed(2) ?? 0}`,
    `fees_dollars: ${(f.realEntryFee + f.realExitFee).toFixed(4)}`, `pnl_dollars: ${f.realNet?.toFixed(2) ?? 0}`,
    `paper_entry: ${f.paperEntry?.toFixed(2) ?? 0}`, `paper_exit: ${f.paperExit?.toFixed(2) ?? 0}`, `paper_pnl: ${f.paperPnl?.toFixed(2) ?? 0}`, `paper_pnl_at_live_size: ${f.paperPnlAtLiveSize?.toFixed(2) ?? 0}`, `paper_reason: "${f.paperReason ?? ""}"`,
    `entry_slippage_bp: ${f.entrySlipBp?.toFixed(1) ?? 0}`,
    "```", "",
  ].join("\n");
}

// ---- The run -------------------------------------------------------------------------------

async function cfgGet(key: string): Promise<string | null> {
  return (await prisma.agentConfig.findUnique({ where: { key } }).catch(() => null))?.value ?? null;
}
async function cfgSet(key: string, value: string): Promise<void> {
  await prisma.agentConfig.upsert({ where: { key }, update: { value }, create: { key, value } });
}

export async function loadLiveFills(): Promise<LiveFill[]> {
  await ensureShadowColumns();
  const rows = await prisma.$queryRawUnsafe<{ id: number; time: Date; symbol: string; side: string; source: string | null; leverage: number | null; mark_price: number | null; shadow_status: string | null; shadow_exit: number | null; shadow_pnl: number | null; shadow_fees: number | null; shadow_reason: string | null; shadow_resolved_at: Date | null; live_txid: string }[]>(
    `SELECT id, time, symbol, side, source, leverage, mark_price, shadow_status, shadow_exit, shadow_pnl, shadow_fees, shadow_reason, shadow_resolved_at, live_txid
     FROM tradingview_alerts WHERE live_txid IS NOT NULL AND executed = true AND side IN ('buy','sell') ORDER BY time`,
  );
  if (!rows.length) return [];
  const refEquity = parseFloat((await cfgGet("kraken_shadow_ref_equity")) ?? "") || 5000;
  const paperRisk = parseFloat((await cfgGet("kraken_margin_max_risk_pct")) ?? "") || 3;
  const since = new Date(Math.min(...rows.map((r) => r.time.getTime())) - 3600_000);
  const trades = await prisma.$queryRawUnsafe<{ txid: string; ordertxid: string; pair: string; time: Date; type: string; price: number; cost: number; fee: number; vol: number; margin: number; posstatus: string }[]>(
    `SELECT txid, ordertxid, pair, time, type, price, cost, fee, vol, margin, posstatus FROM kraken_my_trades WHERE time >= $1 ORDER BY time`, since,
  );
  return matchLiveFills(
    rows.map((r) => ({ id: r.id, time: r.time.toISOString(), symbol: r.symbol, side: r.side, source: r.source, leverage: r.leverage, markPrice: r.mark_price, shadowStatus: r.shadow_status, shadowExit: r.shadow_exit, shadowPnl: r.shadow_pnl, shadowFees: r.shadow_fees, shadowReason: r.shadow_reason, shadowResolvedAt: r.shadow_resolved_at?.toISOString() ?? null, liveTxid: r.live_txid,
      paperNotional: r.mark_price != null && r.mark_price > 0 ? positionNotional(r.source, r.leverage ?? 1, r.mark_price, refEquity, paperRisk) : null })),
    trades.map((t) => ({ ...t, time: t.time.toISOString(), price: t.price ?? 0, cost: t.cost ?? 0, fee: t.fee ?? 0, vol: t.vol ?? 0, margin: t.margin ?? 0, posstatus: t.posstatus ?? "" })),
  );
}

async function extractLessons(stats: string, prevLessons: string | null): Promise<string | null> {
  if (!process.env.ANTHROPIC_API_KEY) return null;
  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const prompt = `You are the synthesis agent for a Kraken US spot-margin desk run by a non-technical founder. Below is today's auto-generated statistics file (paper sleeves scored with real fees, and the live book's real fills matched to paper). Write the desk's lessons file in Markdown.

Rules:
- Judge on expectancy, t-stat and distinct-day spread — NEVER on hit rate alone, and never call a t<2 result an edge.
- Fees and give-back are the historical killers of this account; say when they are the story.
- If live diverges from paper, that is lesson #1 and it says STOP scaling.
- Max 6 lessons, each 1–2 sentences, ranked by what it would cost to ignore. Then max 3 anti-patterns. Then 2–3 "what to watch next" items.
- Do NOT propose parameter changes to sleeves (pre-registered experiments). You may propose what a future, separately pre-registered sleeve should test.
- Plain English. No hedging filler. Start with a one-line status: are we closer to arming, or not, and why.

Previous lessons file (may be empty):
${prevLessons ? prevLessons.slice(0, 4000) : "(none)"}

Today's statistics:
${stats.slice(0, 12000)}`;
  const res = await anthropic.messages.create({ model: "claude-sonnet-5", max_tokens: 1800, messages: [{ role: "user", content: prompt }] });
  const text = res.content.map((c) => (c.type === "text" ? c.text : "")).join("").trim();
  return text || null;
}

export interface SynthesisRun { ran: boolean; reason: string; fills: number; closed: number; journaled: number; lessons: boolean; observations: string[]; divergence: string }

export async function runMarginSynthesis(force = false): Promise<SynthesisRun> {
  const lastRun = await cfgGet(SYNTH_LAST_RUN);
  const hours = lastRun ? (Date.now() - new Date(lastRun).getTime()) / 3600_000 : Infinity;
  if (!force && hours < 20) return { ran: false, reason: `ran ${hours.toFixed(1)}h ago`, fills: 0, closed: 0, journaled: 0, lessons: false, observations: [], divergence: "" };

  const [strategies, shadow, edges, fills] = await Promise.all([
    strategyBreakdown().catch(() => [] as StrategyStat[]),
    shadowScore().catch(() => null),
    edgeBreakdowns().catch(() => ({ byDirection: [], byCoin: [] }) as EdgeBreakdowns),
    loadLiveFills().catch(() => [] as LiveFill[]),
  ]);
  const div = divergenceSummary(fills);
  const [auto, validate, sources, watchState] = await Promise.all([cfgGet("kraken_margin_auto"), cfgGet("kraken_margin_validate_only"), cfgGet("kraken_margin_live_sources"), cfgGet("margin_watch_state")]);
  let equity: number | null = null;
  try { const p = watchState ? (JSON.parse(watchState) as { lastEquity?: number }) : null; equity = p?.lastEquity && p.lastEquity > 0 ? p.lastEquity : null; } catch { equity = null; }
  const at = new Date().toISOString();
  const stats = renderStatistics({ at, strategies, shadow, edges, fills, div, live: { armed: auto === "true" && validate === "false", sources: (sources ?? "").split(",").map((x) => x.trim()).filter(Boolean), equity } });
  await vaultWrite("Performance/margin-statistics.md", stats, "margin-synthesis");

  // Journal each closed live round trip once.
  let journaledList: string[] = [];
  try { journaledList = JSON.parse((await cfgGet(SYNTH_JOURNALED)) ?? "[]") as string[]; } catch { journaledList = []; }
  const journaledSet = new Set(journaledList);
  let journaled = 0;
  for (const f of fills) {
    if (!f.closed || journaledSet.has(f.liveTxid)) continue;
    const day = (f.realExitAt ?? f.realEntryAt).slice(0, 10);
    const path = `Journal/${day}.md`;
    const existing = await vaultRead(path);
    if (!existing) await vaultWrite(path, `---\ndate: "${day}"\nagent: "kraken-margin"\n---\n\n# Trading Journal — ${day}\n\n## Trades\n\n${journalBlock(f)}`, "margin-synthesis");
    else await vaultAppend(path, journalBlock(f), "margin-synthesis");
    journaledSet.add(f.liveTxid); journaled++;
  }
  if (journaled) await cfgSet(SYNTH_JOURNALED, JSON.stringify([...journaledSet].slice(-500)));

  // Observations: what moved since the last run (verdict changes, divergence, milestones).
  const observations: string[] = [];
  const prevSnapRaw = await cfgGet("margin_synthesis_snapshot");
  let prev: Record<string, { resolved: number; verdict: string; t: number | null }> = {};
  try { prev = prevSnapRaw ? JSON.parse(prevSnapRaw) : {}; } catch { prev = {}; }
  const snap: typeof prev = {};
  for (const s of strategies) {
    snap[s.key] = { resolved: s.resolved, verdict: s.verdict, t: s.tStat };
    const p = prev[s.key];
    if (p && p.verdict !== s.verdict) observations.push(`${s.label}: verdict ${p.verdict} → ${s.verdict} (${s.resolved} resolved, t=${s.tStat?.toFixed(2) ?? "—"})`);
    if (p && s.resolved >= 30 && p.resolved < 30) observations.push(`${s.label} crossed 30 resolved: net ${money(s.liveNet)}, t=${s.tStat?.toFixed(2) ?? "—"} — ${s.verdict}`);
  }
  if (div.fills && /DIVERGES/.test(div.verdict)) observations.push(`LIVE vs PAPER: ${div.verdict}`);
  if (journaled) observations.push(`${journaled} live round trip(s) journaled; live net ${money(div.realNet)} vs paper ${money(div.paperNet)} on the same trades`);
  for (const o of observations) await logObservation("margin-synthesis", o).catch(() => {});
  await cfgSet("margin_synthesis_snapshot", JSON.stringify(snap));

  // Lessons: only when there is new material (≥5 new resolved trades or a new live round trip).
  const prevResolved = Object.values(prev).reduce((s, x) => s + x.resolved, 0);
  const nowResolved = strategies.reduce((s, x) => s + x.resolved, 0);
  let lessons = false;
  if (force || journaled > 0 || nowResolved - prevResolved >= 5 || !prevSnapRaw) {
    try {
      const prevLessons = await vaultRead("Lessons/margin-lessons.md");
      const text = await extractLessons(stats, prevLessons);
      if (text) {
        await vaultWrite("Lessons/margin-lessons.md", `---\nlast_updated: "${at.slice(0, 10)}"\nupdated_by: "margin-synthesis"\ntags: [lessons, margin]\n---\n\n# Margin desk — lessons (auto-generated)\n\n> Extracted daily from Performance/margin-statistics.md. Read with Lessons/active-lessons.md. These never change a sleeve's parameters.\n\n${text}\n`, "margin-synthesis");
        lessons = true;
        const active = await vaultRead("Lessons/active-lessons.md");
        if (active && !active.includes("margin-lessons.md")) await vaultAppend("Lessons/active-lessons.md", "\n> Margin desk (Kraken paper + live): see [[margin-lessons]] — regenerated daily by the margin synthesis agent.", "margin-synthesis");
      }
    } catch { lessons = false; }
  }

  await cfgSet(SYNTH_LAST_RUN, at);
  const armedLine = auto === "true" && validate === "false" ? "ARMED" : "disarmed";
  const best = [...strategies].filter((s) => s.resolved > 0).sort((a, b) => (b.tStat ?? -9) - (a.tStat ?? -9))[0];
  await sendNotification(
    `📚 Margin synthesis: ${strategies.filter((s) => s.resolved > 0).length} sleeves scored · best ${best ? `${best.label} (${best.resolved} resolved, t=${best.tStat?.toFixed(2) ?? "—"}, ${best.verdict})` : "—"} · live ${armedLine}, ${div.fills} fills (${div.closed} closed): ${div.verdict}${observations.length ? `\n• ${observations.join("\n• ")}` : ""}${lessons ? "\nLessons updated → Lessons/margin-lessons.md" : ""}`,
    "margin_results",
  ).catch(() => {});
  return { ran: true, reason: force ? "forced" : "daily", fills: div.fills, closed: div.closed, journaled, lessons, observations, divergence: div.verdict };
}
