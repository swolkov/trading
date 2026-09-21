"use client";

import { useCallback, useMemo, useState } from "react";
import useSWR from "swr";
import { Empty, Note, PageHeader, Panel, PanelBody } from "@/components/ui/panel";
import { ReplayPanel } from "@/components/trading-room/replay-panel";
import { DayTable, EquityCurve, StatsStrip } from "@/components/trading-room/library-panels";
import type { JournalRow, Scoreboard, SessionBucket } from "@/lib/trading-room-journal";
import type { LedgerTrade } from "@/lib/trading-room-ledger-rules";
import { dayGroups, equityCurve, filterRows, libraryCsv, libraryRows, libraryStats, type LibraryFilter } from "@/lib/trading-room-library";
import { etParts } from "@/lib/trading-room-rules";

// THE TRADE LIBRARY: every trade on the live account — the room's round trips (replayable) and the broker's own
// record from before the room existed — with the review numbers, the equity curve, filters, his tag / why / grade
// on each trade, a CSV of the lot, and a replay he can send to Slack again.

interface JournalData { rows: JournalRow[]; scoreboard: Scoreboard; ledger?: { trades: LedgerTrade[] }; error?: string }
const fetcher = (u: string) => fetch(u).then((r) => r.json());
const SESSIONS: SessionBucket[] = ["overnight", "premarket", "open", "morning", "midday", "afternoon", "close"];

export default function TradeLibraryPage() {
  const { data, mutate } = useSWR<JournalData>("/api/trade/journal", fetcher, { refreshInterval: 60_000 });
  const [picked, setPicked] = useState<string | null>(null);
  const [filter, setFilter] = useState<LibraryFilter>({});
  const all = useMemo(() => libraryRows(data?.rows ?? [], data?.ledger?.trades ?? []), [data]);
  const rows = useMemo(() => filterRows(all, filter), [all, filter]);
  const stats = useMemo(() => libraryStats(rows), [rows]);
  const curve = useMemo(() => equityCurve(rows), [rows]);
  const groups = useMemo(() => dayGroups(rows, (ms) => etParts(ms).dayKey), [rows]);
  const replayable = rows.filter((r) => r.kind === "journal");
  // The newest replayable trade opens by itself until one is picked; "" means closed on purpose.
  const selected = picked === null ? replayable[0]?.id ?? null : picked === "" ? null : picked;
  const pick = useCallback((id: string) => setPicked(id), []);
  const tags = [...new Set(all.map((r) => r.setupTag).filter((t): t is string => !!t))];
  const onSlack = async (id: string) => { await fetch("/api/trade/journal", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "slack", id }) }); };
  const download = () => {
    const blob = new Blob([libraryCsv(rows)], { type: "text/csv" }); const a = document.createElement("a");
    a.href = URL.createObjectURL(blob); a.download = `trades-${new Date().toISOString().slice(0, 10)}.csv`; a.click(); URL.revokeObjectURL(a.href);
  };
  const sel = "h-7 rounded-md border border-border bg-background px-2 text-xs";
  return (
    <div className="space-y-5">
      <PageHeader title="Trade Library" sub="Every trade on your live Tradovate account. The room's trades replay on their own 1-minute chart with your fills, the levels as they stood, and the stop; the broker's record covers the days before the room existed. Tag, explain and grade each one — the splits below fill in as you do."
        right={data && !data.error && (
          <div className="flex flex-wrap items-center gap-2">
            <select className={sel} value={filter.symbol ?? ""} onChange={(e) => setFilter({ ...filter, symbol: e.target.value || null })}><option value="">all markets</option>{["MES", "MNQ", "MGC"].map((s) => <option key={s} value={s}>{s}</option>)}</select>
            <select className={sel} value={filter.session ?? ""} onChange={(e) => setFilter({ ...filter, session: (e.target.value || null) as SessionBucket | null })}><option value="">all sessions</option>{SESSIONS.map((s) => <option key={s} value={s}>{s}</option>)}</select>
            <select className={sel} value={filter.result ?? ""} onChange={(e) => setFilter({ ...filter, result: (e.target.value || null) as "win" | "loss" | null })}><option value="">wins + losses</option><option value="win">wins</option><option value="loss">losses</option></select>
            <select className={sel} value={filter.tag ?? ""} onChange={(e) => setFilter({ ...filter, tag: e.target.value || null })}><option value="">all tags</option>{tags.map((t) => <option key={t} value={t}>{t}</option>)}</select>
            <select className={sel} value={filter.kind ?? ""} onChange={(e) => setFilter({ ...filter, kind: (e.target.value || null) as "journal" | "record" | null })}><option value="">room + broker record</option><option value="journal">room trades only</option><option value="record">broker record only</option></select>
            <button onClick={download} className="h-7 rounded-md border border-border px-2.5 text-xs text-muted-foreground hover:text-foreground">CSV</button>
          </div>
        )} />
      {!data ? <Panel><PanelBody><Empty>Loading…</Empty></PanelBody></Panel> : data.error ? <Panel tone="amber"><PanelBody><Note>{data.error}</Note></PanelBody></Panel> : (
        <>
          <StatsStrip s={stats} />
          <EquityCurve points={curve} onPick={pick} />
          {selected && <ReplayPanel id={selected} onClose={() => setPicked("")} />}
          <DayTable groups={groups} selected={selected} onSelect={pick} onSaved={() => mutate()} onSlack={onSlack} />
        </>
      )}
    </div>
  );
}
