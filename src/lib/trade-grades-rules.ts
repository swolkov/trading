// TRADE GRADES — pure rules (Sep 23 2026). The route to automating HIS edge, not a copy of it: the mechanised
// version of his setup lost on 15 years of data (the paper bot's own code: −0.17R a trade, 14 of 16 years red), so
// whatever works is in what he chooses to take. He grades each entry the moment he takes it — before the outcome, so
// the grade is his read, not hindsight — with one tap in Slack: A clean (would take it every time) · B decent ·
// C impulse / boredom / revenge. After ~50 trades the recap says whether A beats C on his own money; a filter that
// does can then be written down and tested on the archive. Pure; unit-tested.
import { createHmac, timingSafeEqual } from "node:crypto";
import type { RoomSymbol } from "@/lib/trading-room-rules";

export type Grade = "A" | "B" | "C";
export const GRADES: Grade[] = ["A", "B", "C"];
export const GRADE_LABEL: Record<Grade, string> = { A: "clean", B: "decent", C: "impulse" };
export const MATCH_WINDOW_MS = 3 * 60_000;   // the journal trip must have entered at most this long BEFORE the co-pilot saw it
export const MATCH_SKEW_MS = 5_000;          // …or at most this long after (clock skew between the broker and our poll)
export const GRADE_TTL_MS = 30 * 60_000;     // a grade is his read at entry: links stop working after 30 minutes (no hindsight edits)

/** One entry = market + side + the moment the co-pilot first saw it. */
export function gradeKey(symbol: RoomSymbol, side: 1 | -1, openedMs: number): string {
  return `${symbol}|${side === 1 ? "L" : "S"}|${Math.round(openedMs)}`;
}
export function parseGradeKey(k: string): { symbol: RoomSymbol; side: 1 | -1; openedMs: number } | null {
  const m = k.match(/^(MES|MNQ|MGC)\|([LS])\|(\d{12,14})$/);
  return m ? { symbol: m[1] as RoomSymbol, side: m[2] === "L" ? 1 : -1, openedMs: Number(m[3]) } : null;
}
export function isGrade(g: unknown): g is Grade { return g === "A" || g === "B" || g === "C"; }

export function gradeSignature(key: string, secret: string): string {
  return createHmac("sha256", secret).update(`grade:${key}`).digest("hex").slice(0, 32);
}
export function gradeSignatureOk(key: string, sig: string, secret: string): boolean {
  if (!/^[0-9a-f]{32}$/.test(sig)) return false;
  const want = gradeSignature(key, secret);
  return timingSafeEqual(Buffer.from(want), Buffer.from(sig));
}

/** The Slack line with three tap links (Slack mrkdwn links work on an incoming webhook — no app interactivity needed). */
export function gradeAskText(symbol: RoomSymbol, side: 1 | -1, openedMs: number, base: string, secret: string, closed = false): string {
  const k = gradeKey(symbol, side, openedMs), sig = gradeSignature(k, secret);
  const url = (g: Grade) => `${base.replace(/\/$/, "")}/api/webhook/trading-room/grade?k=${encodeURIComponent(k)}&g=${g}&sig=${sig}`;
  const lead = closed ? `Grade that quick ${symbol} ${side === 1 ? "long" : "short"} you just closed — how was the ENTRY?` : `Grade this ${symbol} ${side === 1 ? "long" : "short"} now, before it plays out:`;
  return `🏷 ${lead}  <${url("A")}|*A · clean*>   <${url("B")}|*B · decent*>   <${url("C")}|*C · impulse*>`;
}

export interface GradedTrip { grade: Grade; netUsd: number }

/**
 * Match grades to journal trips: same market and side, the LATEST trip that had already entered when the co-pilot saw
 * the position (entry ≤ seen + 5 s, no more than 3 min before). The co-pilot only sees an entry after its fill, so a
 * quick exit + re-entry between two polls must not hand the grade to the later trip. Each trip is used once.
 * Returns, per grade (same order), the index of its trip or −1.
 */
export function matchGrades(grades: { symbol: string; side: 1 | -1; openedMs: number }[], trips: { symbol: string; side: 1 | -1; entryMs: number }[]): number[] {
  const used = new Set<number>();
  return grades.map((g) => {
    let best = -1, bestAt = -Infinity;
    trips.forEach((t, i) => {
      if (used.has(i) || t.symbol !== g.symbol || t.side !== g.side) return;
      if (t.entryMs <= g.openedMs + MATCH_SKEW_MS && t.entryMs >= g.openedMs - MATCH_WINDOW_MS && t.entryMs > bestAt) { best = i; bestAt = t.entryMs; }
    });
    if (best >= 0) used.add(best);
    return best;
  });
}
/** "A 12 trades +$1,840 (58% win) · B … · C …" — only grades that have trades. */
export function gradeLine(rows: GradedTrip[]): string | null {
  if (!rows.length) return null;
  const usd = (x: number) => `${x < 0 ? "−" : "+"}$${Math.abs(Math.round(x)).toLocaleString("en-US")}`;
  const parts = GRADES.map((g) => {
    const x = rows.filter((r) => r.grade === g);
    if (!x.length) return null;
    const net = x.reduce((a, r) => a + r.netUsd, 0), win = x.filter((r) => r.netUsd > 0).length / x.length;
    return `${g} ${x.length} trade${x.length === 1 ? "" : "s"} ${usd(net)} (${Math.round(win * 100)}% win)`;
  }).filter(Boolean);
  return parts.join(" · ");
}

/** The recap block: today, and since grading began with the ~50-trade bar for reading anything into it. */
export function gradesRecapText(today: GradedTrip[], all: GradedTrip[]): string | null {
  if (!all.length) return null;
  const t = gradeLine(today), a = gradeLine(all);
  return `🏷 Your grades — today: ${t ?? "none graded"} · since start: ${a}${all.length < 50 ? ` · (${all.length}/50 before it means much)` : ""}`;
}
