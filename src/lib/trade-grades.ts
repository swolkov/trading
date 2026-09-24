// TRADE GRADES — I/O (Sep 23 2026). Stores the grade he taps in Slack (raw SQL table created on demand — note that a
// `prisma db push` WOULD drop it, which is one more reason that command is banned here), builds the signed tap links, and reports grades against his journal's real results in the daily recap.
// The grade is his; the P&L is the journal's (trading_room_trades) — matched by market, side and entry time.
import { prisma } from "@/lib/db";
import { tradingDay } from "@/lib/copilot-rules";
import type { RoomSymbol } from "@/lib/trading-room-rules";
import type { Discipline } from "@/lib/copilot-rules";
import { MATCH_WINDOW_MS, disciplineRecapText, gradeAskText, gradeKey, matchGrades, gradesRecapText, parseGradeKey, type Grade, type GradedTrip } from "@/lib/trade-grades-rules";

const base = () => (process.env.PUBLIC_APP_URL ?? "https://trading-eta-snowy.vercel.app").replace(/\/$/, "");
export const gradeSecret = () => process.env.TRADING_ROOM_WEBHOOK_SECRET || null;

export async function ensureDisciplineTable(): Promise<void> {
  await prisma.$executeRawUnsafe(`CREATE TABLE IF NOT EXISTS trading_room_discipline (
    key text PRIMARY KEY, symbol text NOT NULL, side int NOT NULL, opened_at timestamptz NOT NULL, score int NOT NULL,
    broken text NOT NULL, closed_at timestamptz NOT NULL DEFAULT now())`);
}
/** The co-pilot's automatic grade for each closed trip (once per entry; a re-post never duplicates). */
export async function saveDiscipline(rows: Discipline[]): Promise<void> {
  if (!rows.length) return;
  await ensureDisciplineTable();
  for (const d of rows) {
    await prisma.$executeRawUnsafe(
      `INSERT INTO trading_room_discipline (key, symbol, side, opened_at, score, broken) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (key) DO NOTHING`,
      gradeKey(d.symbol, d.side, d.openedMs), d.symbol, d.side, new Date(d.openedMs), d.score, d.broken.join(" · "));
  }
}

/** Discipline scores matched to closed journal trips the same way as grades. */
export async function disciplineRecap(nowMs: number): Promise<string | null> {
  await ensureDisciplineTable();
  type DRow = { symbol: string; side: number; opened_at: Date; score: number };
  const rows: DRow[] = await prisma.$queryRawUnsafe<DRow[]>(`SELECT symbol, side, opened_at, score FROM trading_room_discipline ORDER BY opened_at`);
  if (!rows.length) return null;
  const from = new Date(new Date(rows[0].opened_at).getTime() - MATCH_WINDOW_MS);
  const trips: TripRow[] = await prisma.$queryRawUnsafe<TripRow[]>(`SELECT symbol, side, entry_ts, net_usd FROM trading_room_trades WHERE entry_ts >= $1 AND open = false`, from);
  const idx = matchGrades(
    rows.map((r: DRow) => ({ symbol: r.symbol, side: (r.side === 1 ? 1 : -1) as 1 | -1, openedMs: new Date(r.opened_at).getTime() })),
    trips.map((t: TripRow) => ({ symbol: t.symbol, side: (t.side === "long" ? 1 : -1) as 1 | -1, entryMs: new Date(t.entry_ts).getTime() })));
  const key = tradingDay(nowMs);
  const all: { score: number; netUsd: number; day: string }[] = [];
  rows.forEach((r: DRow, n: number) => { const i = idx[n]; if (i >= 0) all.push({ score: Number(r.score), netUsd: Number(trips[i].net_usd ?? 0), day: tradingDay(new Date(r.opened_at).getTime()) }); });
  return disciplineRecapText(all.filter((r) => r.day === key), all);
}

export async function ensureGradesTable(): Promise<void> {
  await prisma.$executeRawUnsafe(`CREATE TABLE IF NOT EXISTS trading_room_grades (
    key text PRIMARY KEY, symbol text NOT NULL, side int NOT NULL, opened_at timestamptz NOT NULL, grade text NOT NULL,
    graded_at timestamptz NOT NULL DEFAULT now())`);
}

/** The Slack line for a new entry, or null when the signing secret isn't configured (then no links are posted). */
export function gradeAsk(symbol: RoomSymbol, side: 1 | -1, openedMs: number, closed = false): string | null {
  const secret = gradeSecret();
  return secret ? gradeAskText(symbol, side, openedMs, base(), secret, closed) : null;
}

/** Save (or change) a grade. The key was already verified by its signature. */
export async function saveGrade(key: string, grade: Grade): Promise<{ symbol: RoomSymbol; side: 1 | -1; openedMs: number } | null> {
  const k = parseGradeKey(key);
  if (!k) return null;
  await ensureGradesTable();
  await prisma.$executeRawUnsafe(
    `INSERT INTO trading_room_grades (key, symbol, side, opened_at, grade) VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (key) DO UPDATE SET grade = $5, graded_at = now()`,
    key, k.symbol, k.side, new Date(k.openedMs), grade);
  return k;
}

interface GradeRow { key: string; symbol: string; side: number; opened_at: Date; grade: string }
interface TripRow { symbol: string; side: string; entry_ts: Date; net_usd: number | null }

/**
 * Grades matched to closed journal trips: same market and side, the LATEST trip that had already entered when the
 * co-pilot saw the position (entry ≤ seen + 5 s, and no more than 3 min before) — the co-pilot only ever sees an entry
 * after its fill, and a quick exit + re-entry between two polls must not hand the grade to the later trip. Each trip once.
 */
export async function gradedTrips(nowMs = Date.now()): Promise<{ graded: (GradedTrip & { day: string })[]; ungradedToday: number }> {
  await ensureGradesTable();
  const grades: GradeRow[] = await prisma.$queryRawUnsafe<GradeRow[]>(`SELECT key, symbol, side, opened_at, grade FROM trading_room_grades ORDER BY opened_at`);
  if (!grades.length) return { graded: [], ungradedToday: 0 };
  const from = new Date(new Date(grades[0].opened_at).getTime() - MATCH_WINDOW_MS);
  const trips: TripRow[] = await prisma.$queryRawUnsafe<TripRow[]>(`SELECT symbol, side, entry_ts, net_usd FROM trading_room_trades WHERE entry_ts >= $1 AND open = false`, from);
  const idx = matchGrades(
    grades.map((g: GradeRow) => ({ symbol: g.symbol, side: (g.side === 1 ? 1 : -1) as 1 | -1, openedMs: new Date(g.opened_at).getTime() })),
    trips.map((t: TripRow) => ({ symbol: t.symbol, side: (t.side === "long" ? 1 : -1) as 1 | -1, entryMs: new Date(t.entry_ts).getTime() })));
  const used = new Set(idx.filter((i) => i >= 0));
  const out: (GradedTrip & { day: string })[] = [];
  grades.forEach((g: GradeRow, n: number) => {
    const i = idx[n];
    if (i >= 0) out.push({ grade: g.grade as Grade, netUsd: Number(trips[i].net_usd ?? 0), day: tradingDay(new Date(g.opened_at).getTime()) });
  });
  const now = tradingDay(nowMs);
  const ungradedToday = trips.filter((t: TripRow, i: number) => !used.has(i) && tradingDay(new Date(t.entry_ts).getTime()) === now).length;
  return { graded: out, ungradedToday };
}

export async function gradesRecap(nowMs: number): Promise<string | null> {
  const { graded, ungradedToday } = await gradedTrips(nowMs);
  const key = tradingDay(nowMs);
  const txt = gradesRecapText(graded.filter((r) => r.day === key), graded);
  return txt && ungradedToday ? `${txt} · ${ungradedToday} trade${ungradedToday === 1 ? "" : "s"} today not graded` : txt;
}
