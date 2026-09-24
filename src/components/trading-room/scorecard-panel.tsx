"use client";

import useSWR from "swr";
import { Panel } from "@/components/ui/panel";

// HIS SCORECARD — read-only, from GET /api/trade/scorecard: the grades, discipline and paper-bot lines from the
// daily Slack recap, shown here so they can be checked without scrolling Slack.

type Line = { text: string | null; error?: string };
type Scorecard = { atMs: number; grades: Line; discipline: Line; paperBot: Line };

const fetcher = (u: string) => fetch(u).then((r) => r.json());
// The recap lines start with an emoji and a label ("🏷 Your grades — ", "🤖 PAPER bot today: "); the row label replaces them.
export const recapBody = (t: string) => t.replace(/^\p{Extended_Pictographic}️?\s*/u, "").replace(/^[^—]*—\s*/, "").replace(/^PAPER bot\s+/i, "");

function Row({ label, line, empty }: { label: string; line?: Line; empty: string }) {
  return (
    <div className="flex gap-3 text-[12px] leading-5">
      <span className="num w-24 shrink-0 text-[10px] font-medium uppercase tracking-[0.12em] text-muted-foreground pt-0.5">{label}</span>
      {line?.error ? <span className="text-warn">unavailable: {line.error}</span>
        : <span className={line?.text ? "" : "text-muted-foreground"}>{line?.text ? recapBody(line.text) : empty}</span>}
    </div>
  );
}

export function ScorecardPanel() {
  const { data } = useSWR<Scorecard>("/api/trade/scorecard", fetcher, { refreshInterval: 60_000 });
  if (!data) return null;
  return (
    <Panel>
      <div className="space-y-1.5 px-4 py-3">
        <span className="text-[13px] font-semibold tracking-[-0.01em]">Scorecard</span>
        <Row label="Your grades" line={data.grades} empty="No trades graded yet (tap A/B/C on the Slack entry card)." />
        <Row label="Discipline" line={data.discipline} empty="No closed trades scored yet." />
        <Row label="Paper bot" line={data.paperBot} empty="The paper bot has no trades yet." />
      </div>
    </Panel>
  );
}
