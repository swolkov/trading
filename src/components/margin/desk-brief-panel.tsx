"use client";

import useSWR from "swr";
import { Chip } from "@/components/ui/chip";
import { Empty, Panel, PanelBody, PanelHeader } from "@/components/ui/panel";

// THE DESK BRIEF PANEL — the eight-section brief the margin scan writes once a day after 13:00
// UTC (margin-brief-build.ts). Read-only: /api/margin/brief serves the stored text; nothing here
// asks Kraken anything. The ACTION is a precedence ladder (NO TRADE → REDUCE/EXIT → ENTER → WAIT
// → PAPER TEST), never a weighing.

const fetcher = (u: string) => fetch(u).then((r) => r.json());
interface BriefResp { brief: { at: string; action: string; reason: string; text: string } | null }

const actionTone = (a: string): "red" | "amber" | "green" | "grey" | "paper" =>
  a === "NO TRADE" ? "red" : a === "REDUCE/EXIT" ? "amber" : a === "ENTER" ? "green" : a === "WAIT" ? "grey" : "paper";

export function DeskBriefPanel() {
  const { data } = useSWR<BriefResp>("/api/margin/brief", fetcher, { refreshInterval: 300_000 });
  const b = data?.brief ?? null;
  return (
    <Panel>
      <PanelHeader
        title="Desk brief — regime · opportunities · trades · strategies · review · risk · action"
        aside={b ? <><Chip tone={actionTone(b.action)} size="md" dot={b.action === "NO TRADE"}>{b.action}</Chip><span className="tabular-nums">{b.at.slice(0, 10)} {b.at.slice(11, 16)}Z · daily after 13:00 UTC · also in the vault (Brain/crypto-desk-brief.md)</span></> : <span>written once a day by the margin scan</span>}
      />
      {!data ? <Empty>Loading the brief…</Empty>
        : !b ? <Empty>No brief written yet — the first margin-scan tick after 13:00 UTC writes it.</Empty> : (
        <PanelBody>
          <p className="mb-2 text-[13px]"><span className="font-semibold">{b.action}</span> — {b.reason}</p>
          <pre className="max-h-[32rem] overflow-auto whitespace-pre-wrap rounded-md border border-border bg-foreground/[0.02] p-3 font-mono text-[11.5px] leading-relaxed">{b.text}</pre>
        </PanelBody>
      )}
    </Panel>
  );
}
