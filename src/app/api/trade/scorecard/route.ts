import { disciplineRecap, gradesRecap } from "@/lib/trade-grades";
import { paperBotRecap } from "@/lib/paper-bot";

// HIS SCORECARD, READ-ONLY — the same three lines the 16:35 Slack recap posts (his A/B/C grades, the automatic
// discipline grade, and the PAPER bot vs his hands), so the page and Slack can never disagree. Nothing here places
// or changes an order; the recap helpers only read (their CREATE TABLE IF NOT EXISTS is a no-op on existing tables).
export const dynamic = "force-dynamic";

type Line = { text: string | null; error?: string };

async function line(f: () => Promise<string | null>): Promise<Line> {
  try { return { text: await f() }; } catch (e) { return { text: null, error: String(e).slice(0, 160) }; }
}

export async function GET() {
  const now = Date.now();
  const [grades, discipline, paperBot] = await Promise.all([
    line(() => gradesRecap(now)), line(() => disciplineRecap(now)), line(() => paperBotRecap(now)),
  ]);
  return Response.json({ atMs: now, grades, discipline, paperBot });
}
