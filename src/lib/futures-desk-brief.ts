// FUTURES DESK — the desk brief (E8), pure: the LIVE TRADE OUTPUT in the fixed reporting shape —
// MARKET REGIME / TOP OPPORTUNITIES / RECOMMENDED TRADE / ACTION. The jobs module feeds it keys,
// rows and clocks; it returns markdown and the action word. It reads the desk, it never drives it:
// the ACTION line is what a person would do, the executor keeps its own gates. Empty inputs render
// "—" and never throw.
import { usd } from "@/lib/futures-desk-rules";
import type { RootRoll } from "@/lib/futures-desk-calendar";
import type { RegimeSnapshot } from "@/lib/futures-desk-score";

export type BriefAction = "NO TRADE" | "REDUCE" | "WAIT";
export const BRIEF_HEADERS = ["## MARKET REGIME", "## TOP OPPORTUNITIES", "## RECOMMENDED TRADE", "## ACTION"] as const;

export interface BriefState {
  /** Disabled, a guardian halt (`disabledReason`), or drawdown tier 4. */
  halted: boolean;
  /** Event window paused, or the daily loss budget spent. */
  paused: boolean;
  anomaly: boolean;
  feedStale: boolean;
  openPositions: number;
  ddTier: number;
  watchCount: number;
}
/** halted / paused / anomaly / feed stale → NO TRADE; an open position at tier ≥ 2 → REDUCE; a watch → WAIT; else NO TRADE. */
export function actionFor(s: BriefState): BriefAction {
  if (s.halted || s.paused || s.anomaly || s.feedStale) return "NO TRADE";
  if (s.openPositions > 0 && s.ddTier >= 2) return "REDUCE";
  if (s.watchCount > 0) return "WAIT";
  return "NO TRADE";
}

export interface BriefWatch { edge: string; root: string; side: string; price: number; stop: number | null; score: number | null; card: string | null; receivedAt: string }
export interface BriefEntry {
  contract: string; micro: string; side: string; qty: number; entryPrice: number; stopPrice: number; riskUsd: number; stopPoints: number | null; atr: number | null;
  session: string | null; regime: string | null; eventMode: string | null; grade: string | null; score: number | null; mfeR: number | null; openedAt: string; status: string;
}
export interface BriefInput {
  generatedAt: string;
  regime: RegimeSnapshot | null;
  event: { mode: string; reason: string; window: string | null } | null;
  rolls: RootRoll[];
  watches: BriefWatch[];
  /** The latest ledger entry (open, or the last one opened today) — the card when there is one. */
  entry: BriefEntry | null;
  state: BriefState & { reasons: string[] };
  stage: string;
  /** Expected-move multiple for the R:R line (k × ATR ÷ stop). */
  k: number;
}

const f2 = (x: number | null | undefined): string => (x == null || !Number.isFinite(x) ? "—" : x.toFixed(2));
const etDate = (iso: string): string => new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "America/New_York" });
/** `MESZ6` → `Z6`; anything unparseable → "—". */
export function contractMonthOf(contract: string, micro: string): string {
  return contract && micro && contract.startsWith(micro) && contract.length > micro.length ? contract.slice(micro.length) : "—";
}
/** Expected R:R = k × ATR ÷ stop distance; null when either is unknown. */
export function expectedRR(atr: number | null | undefined, stopPoints: number | null | undefined, k: number): number | null {
  return atr != null && stopPoints != null && atr > 0 && stopPoints > 0 ? (k * atr) / stopPoints : null;
}

function regimeLines(i: BriefInput): string[] {
  const roots = i.regime ? Object.keys(i.regime.byRoot) : [];
  const lines = roots.length ? roots.map((r) => { const v = i.regime!.byRoot[r]; return `- ${r}: **${v.label}** · close ${v.close ?? "—"} · SMA50 ${v.sma50 == null ? "—" : Math.round(v.sma50)} · SMA200 ${v.sma200 == null ? "—" : Math.round(v.sma200)} · ATR pct ${v.atrPct == null ? "—" : Math.round(v.atrPct * 100)}%`; }) : ["- regime: — (no snapshot yet)"];
  lines.push(`- Event window: ${i.event ? `**${i.event.mode}**${i.event.window ? ` — ${i.event.window}` : i.event.reason ? ` — ${i.event.reason}` : ""}` : "—"}`);
  lines.push(`- Next roll: ${i.rolls.length ? i.rolls.map((r) => `${r.root} ${r.contract} ~${etDate(r.rollOn)}`).join(" · ") : "—"}`);
  return lines;
}

function topLines(i: BriefInput): string[] {
  const top = [...i.watches].sort((a, b) => (b.score ?? -1) - (a.score ?? -1) || Date.parse(b.receivedAt) - Date.parse(a.receivedAt)).slice(0, 5);
  if (!top.length) return ["- —"];
  return top.map((w, n) => `${n + 1}. ${w.root} ${w.side} · ${w.edge} · score ${w.score ?? "—"} · price ${w.price} · stop ${w.stop ?? "—"} · ${w.card ?? "unsized"}`);
}

function recommendedLines(i: BriefInput): string[] {
  const e = i.entry;
  if (e) {
    const rr = expectedRR(e.atr, e.stopPoints, i.k);
    return [
      `- Account: **DEMO** (Tradovate) · ${e.status === "open" ? "OPEN position" : "latest entry"} · opened ${etDate(e.openedAt)}`,
      `- Symbol: ${e.contract} · month ${contractMonthOf(e.contract, e.micro)} · micro ${e.micro} · ${e.side.toUpperCase()} ${e.qty}× · order: market entry + bracket stop (OSO)`,
      `- Entry ${e.entryPrice} · stop ${e.stopPrice} (${e.stopPoints == null ? "—" : `${e.stopPoints} pts`}) · risk ${usd(e.riskUsd, 2)}`,
      `- R:R: ${rr == null ? "—" : `${f2(rr)} expected (${i.k}×ATR ÷ stop)`}${e.mfeR != null ? ` · MFE ${f2(e.mfeR)}R so far` : ""}`,
      `- Session ${e.session ?? "—"} · regime ${e.regime ?? "—"} · event mode ${e.eventMode ?? "—"} · grade ${e.grade ?? "—"} · score ${e.score ?? "—"} · stage ${i.stage}`,
    ];
  }
  const w = [...i.watches].sort((a, b) => (b.score ?? -1) - (a.score ?? -1))[0];
  if (!w) return ["- —"];
  const regime = i.regime?.byRoot[w.root]?.label ?? "—";
  return [
    `- Account: **DEMO** (Tradovate) · top watch, NOT placed — the rule has not fired`,
    `- ${w.root} ${w.side.toUpperCase()} · ${w.edge} · price ${w.price} · projected stop ${w.stop ?? "—"} · ${w.card ?? "unsized"}`,
    `- Regime ${regime} · event mode ${i.event?.mode ?? "—"} · score ${w.score ?? "—"} · stage ${i.stage}`,
  ];
}

/** The brief as markdown, sections in the fixed order, plus the action word. */
export function renderFuturesBrief(i: BriefInput): { markdown: string; action: BriefAction } {
  const action = actionFor(i.state);
  const why = i.state.reasons.length ? i.state.reasons.join(" · ") : action === "WAIT" ? `${i.state.watchCount} watch alert(s) live — wait for the rule to fire` : action === "REDUCE" ? `open position at drawdown tier ${i.state.ddTier}` : "no setup in play";
  const lines = [
    `# Futures desk brief — ${etDate(i.generatedAt)}`,
    `_Generated ${i.generatedAt}. Tradovate DEMO, paper only. The executor keeps its own gates; this is what a person reading the desk would do._`,
    ``, BRIEF_HEADERS[0], ...regimeLines(i),
    ``, BRIEF_HEADERS[1], ...topLines(i),
    ``, BRIEF_HEADERS[2], ...recommendedLines(i),
    ``, BRIEF_HEADERS[3], `**${action}** — ${why}`,
  ];
  return { markdown: lines.join("\n"), action };
}

/** The empty brief — what renders before the first guardian run. */
export function emptyBriefInput(now: Date): BriefInput {
  return { generatedAt: now.toISOString(), regime: null, event: null, rolls: [], watches: [], entry: null, state: { halted: false, paused: false, anomaly: false, feedStale: true, openPositions: 0, ddTier: 0, watchCount: 0, reasons: ["feed never seen"] }, stage: "A", k: 2 };
}
