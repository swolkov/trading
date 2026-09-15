"use client";

import useSWR from "swr";
import { Chip } from "@/components/ui/chip";
import { Empty, Note, Panel, PanelBody, PanelHeader } from "@/components/ui/panel";
import { ago } from "@/lib/format";
import type { StoredOptionsBrief } from "@/lib/options-brief-store";

// THE DESK BRIEF (D8): ACCOUNT / MARKET / TOP 5 / BEST TRADE / ACTION / CONDITIONAL ORDERS, rendered by the research ingest after
// each run and by the 17:32 account collect. ACTION is computed through the entry tick's own gate functions on stamped data.
const fetcher = (u: string) => fetch(u).then((r) => r.json());
const tone = (a: string | undefined) => (a === "ENTER NOW" ? "green" : a === "WAIT FOR TRIGGER" ? "amber" : "grey");

export function OptionsBriefPanel() {
  const { data } = useSWR<{ brief: StoredOptionsBrief | null }>("/api/options/brief", fetcher, { refreshInterval: 120_000 });
  if (!data) return <Panel><PanelHeader title="Desk brief" /><PanelBody><Empty>Loading…</Empty></PanelBody></Panel>;
  const b = data.brief;
  return (
    <Panel>
      <PanelHeader title="Desk brief — what the desk would do, and why" aside={b ? <Chip tone={tone(b.action.action)} dot={b.action.action === "ENTER NOW"}>{b.action.action}{b.bestSymbol ? ` · ${b.bestSymbol}` : ""}</Chip> : <Chip tone="grey">no brief yet</Chip>} />
      <PanelBody className="space-y-3">
        {b ? (
          <>
            <Note>Rendered {ago(b.at)} by the {b.source === "ingest" ? "research ingest" : "17:32 account collect"} · {b.action.reason}. ENTER NOW means the best structure passed every stamped gate (earnings, market veto, chase, cluster, ladder cap, reserve, expiry, drawdown tier, armed) through the same functions the entry tick calls; the tick still re-checks the intraday SPY shock and the broker&apos;s earnings date live. Conditional orders are the exact rule the tick executes for each Trend-watch name.</Note>
            <pre className="max-h-[32rem] overflow-auto whitespace-pre-wrap text-[11px] leading-relaxed text-muted-foreground">{b.text}</pre>
          </>
        ) : <Empty>No brief rendered yet — the next research run writes one.</Empty>}
      </PanelBody>
    </Panel>
  );
}
