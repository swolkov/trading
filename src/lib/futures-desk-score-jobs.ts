// FUTURES DESK — the regime engine's and the score's I/O (E7). Two jobs:
//   • `refreshRegime` — the guardian, once per ET day: Yahoo daily bars per root → `regimeOf` →
//     `futures_desk_regime`. Fail-soft per root: a root whose bars did not arrive keeps its previous
//     entry; nothing here can throw into the guardian's protect step.
//   • `scoreSignal` — the webhook path, at receipt: the score of an entry or watch alert from the
//     regime key, the event policy and the desk's own leaderboard cells, stamped on the signal row
//     (`score`, `score_json`, `regime`). Fail-soft: a scoring failure leaves the alert unscored (null),
//     never unhandled — the score is a stamp, and a missing stamp is a measured gap.
// Imports the store and the review jobs, never futures-desk.ts (no cycle).
import { deskEventPolicy, eventContextOf, EVENT_POLICY_KEY } from "@/lib/futures-desk-calendar";
import { YAHOO_FOR_ROOT } from "@/lib/futures-desk-journal";
import { futuresLeaderboard, journalToMetricRows } from "@/lib/futures-desk-review";
import { journal } from "@/lib/futures-desk-review-jobs";
import type { AlertPayload } from "@/lib/futures-desk-rules";
import {
  REGIME_KEY, REGIME_ROOTS, futuresOpportunityScore, parseRegime, regimeLabelFor, regimeOf, regimeStamp, scoreJsonOf,
  type CellStats, type DailyBar, type OpportunityScore, type RegimeSnapshot,
} from "@/lib/futures-desk-score";
import { cfg, setKey, stampSignal } from "@/lib/futures-desk-store";

/** Calendar days of daily bars to ask Yahoo for: ≥ 200 for the slow SMA and ≈ 250 ATR values for the percentile. */
const REGIME_LOOKBACK_DAYS = 420;
const YAHOO_DEADLINE_MS = 30_000;

async function yahooDaily(sym: string): Promise<DailyBar[]> {
  const y = await import("@/lib/yahoo");
  return (await y.getHistoricalBars(sym, REGIME_LOOKBACK_DAYS)).map((b) => ({ h: b.h, l: b.l, c: b.c }));
}
function withTimeout<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const clock = new Promise<T>((r) => { timer = setTimeout(() => r(fallback), ms); });
  return Promise.race([p, clock]).finally(() => clearTimeout(timer));
}

/** Label every root from Yahoo daily bars and write the snapshot. All roots fetched in parallel under
 *  one 30-second deadline; a root that failed or labelled "unknown" for want of bars keeps the previous
 *  snapshot's entry (if any) so one bad fetch never blanks the stamp. Returns guardian notes. */
export async function refreshRegime(now = new Date(), loadBars: (sym: string) => Promise<DailyBar[]> = yahooDaily): Promise<string[]> {
  const notes: string[] = [];
  const prev = parseRegime(await cfg(REGIME_KEY).catch(() => null));
  const at = now.toISOString();
  const results = new Map<string, DailyBar[] | null>();
  await withTimeout(Promise.all(REGIME_ROOTS.map(async (root) => {
    const sym = YAHOO_FOR_ROOT[root];
    if (!sym) { results.set(root, null); return; }
    results.set(root, await loadBars(sym).catch(() => null));
  })), YAHOO_DEADLINE_MS, undefined);
  const byRoot: RegimeSnapshot["byRoot"] = { ...(prev?.byRoot ?? {}) };
  let fresh = 0;
  for (const root of REGIME_ROOTS) {
    const bars = results.get(root);
    if (bars === undefined) { notes.push(`regime: ${root} bars did not arrive within ${YAHOO_DEADLINE_MS / 1000}s`); continue; }
    if (bars === null) { notes.push(`regime: ${root} bars failed`); continue; }
    const r = regimeOf(bars);
    if (r.label === "unknown") { notes.push(`regime: ${root} has ${bars.length} bars — unknown`); continue; }
    byRoot[root] = { label: r.label, close: r.close, sma50: r.sma50, sma200: r.sma200, atr: r.atr, atrPct: r.atrPct, at };
    fresh++;
  }
  await setKey(REGIME_KEY, JSON.stringify({ at, byRoot } satisfies RegimeSnapshot));
  notes.push(`regime: ${fresh} of ${REGIME_ROOTS.length} roots labelled (${Object.entries(byRoot).map(([k, v]) => `${k} ${v.label}`).join(", ") || "none"})`);
  return notes;
}

/** The desk's own edge × root and edge × regime cells from the leaderboard (n and avg R). */
export async function scoreCells(edge: string, root: string, regime: string | null, basisUsd: number): Promise<{ edgeRoot: CellStats | null; edgeRegime: CellStats | null }> {
  const board = futuresLeaderboard(journalToMetricRows(await journal()), basisUsd);
  const cell = (rows: { label: string; metrics: { n: number; avgR: number | null } }[], label: string): CellStats | null => {
    const r = rows.find((x) => x.label === label);
    return r ? { n: r.metrics.n, avgR: r.metrics.avgR } : null;
  };
  return { edgeRoot: cell(board.byEdgeRoot, `${edge} · ${root}`), edgeRegime: regime ? cell(board.byRegime, `${edge} · ${regime}`) : null };
}

export interface ScoredAlert { alert: AlertPayload; score: OpportunityScore | null; regime: string | null }

/** Score an entry or watch alert at receipt and stamp the row. The score REPLACES any chart-sent
 *  `score` on the alert (the desk's own is the measured one). An exit is stamped with the regime only.
 *  Fail-soft: on any failure the alert comes back unchanged and the failure is the note. */
export async function scoreSignal(signalId: number, a: AlertPayload, basisUsd: number, now = new Date()): Promise<ScoredAlert & { note: string | null }> {
  try {
    const [regimeRaw, policyRaw] = await Promise.all([cfg(REGIME_KEY), cfg(EVENT_POLICY_KEY)]);
    const snap = parseRegime(regimeRaw);
    const regime = regimeStamp(snap, a.root);
    if (a.action === "exit") { await stampSignal(signalId, { regime }); return { alert: a, score: null, regime, note: null }; }
    const mode = eventContextOf(policyRaw, now.getTime(), deskEventPolicy(now)).mode;
    const cells = await scoreCells(a.edge, a.root, regime, basisUsd).catch(() => ({ edgeRoot: null, edgeRegime: null }));
    const s = futuresOpportunityScore(a, regimeLabelFor(snap, a.root), mode, cells);
    await stampSignal(signalId, { score: s.score, scoreJson: scoreJsonOf(a, s), regime });
    return { alert: { ...a, score: s.score }, score: s, regime, note: null };
  } catch (e) {
    return { alert: a, score: null, regime: null, note: `score: ${String(e).slice(0, 120)}` };
  }
}
