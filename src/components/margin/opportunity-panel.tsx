"use client";

import { Chip } from "@/components/ui/chip";
import { DataTable, Row, Td, Th } from "@/components/ui/data-table";
import { Label, Note } from "@/components/ui/panel";
import { money, pct, tone } from "@/lib/format";

// "DOES THE 0–100 SCORE RANK?" — the opportunity score (margin-opportunity-score.ts) read against
// outcomes by bucket, beside "Does conviction matter?". A paper ranker: nothing gates on it until
// promotionVerdict says PROMOTABLE and a later PR wires a gate after review.

export interface OppSlice { key: string; resolved: number; wins: number; hitRate: number | null; net: number; tStat: number | null; days: number; open: number }
export interface OpportunityView {
  source: string;
  byScore: OppSlice[]; byLine: OppSlice[]; byEventMode: OppSlice[]; byMtfAligned: OppSlice[]; byFundingSign: OppSlice[];
  verdict: { status: "PROMOTABLE" | "gathering" | "not ranking"; reasons: string[] };
  preregisteredAt: string;
  liveLine: number;
}

const SLICE_MIN = 30;
const verdictTone = (s: OpportunityView["verdict"]["status"]): "green" | "grey" | "red" => (s === "PROMOTABLE" ? "green" : s === "gathering" ? "grey" : "red");

function SliceTable({ title, rows }: { title: string; rows: OppSlice[] }) {
  if (!rows.length) return null;
  return (
    <div className="border-b border-border last:border-0">
      <Label className="px-4 pb-1 pt-3">{title}</Label>
      <DataTable dense>
        <thead>
          <tr>
            <Th>Bucket</Th>
            <Th num>Resolved</Th>
            <Th num>Open</Th>
            <Th num>Hit rate</Th>
            <Th num title="After fees, at paper's base risk">Net (paper)</Th>
            <Th num title="Net per resolved trade">Net / trade</Th>
            <Th num title="Confidence: average ÷ its own noise × √n. Below 2 a good run can still be luck.">t</Th>
          </tr>
        </thead>
        <tbody>
          {rows.map((s) => {
            const judged = s.resolved >= SLICE_MIN;
            return (
              <Row key={s.key}>
                <Td strong>{s.key}{!judged && <span className="ml-1 text-muted-foreground">· watching {s.resolved}/{SLICE_MIN}</span>}</Td>
                <Td num>{s.resolved}</Td>
                <Td num muted>{s.open}</Td>
                <Td num>{pct(s.hitRate)}</Td>
                <Td num className={`font-semibold ${judged ? tone(s.net) : "text-muted-foreground"}`}>{money(s.net)}</Td>
                <Td num className={judged ? tone(s.net) : "text-muted-foreground"}>{s.resolved > 0 ? money(s.net / s.resolved) : "—"}</Td>
                <Td num className={judged ? "" : "text-muted-foreground"}>{s.tStat != null ? s.tStat.toFixed(2) : "—"}</Td>
              </Row>
            );
          })}
        </tbody>
      </DataTable>
    </div>
  );
}

export function OpportunityPanel({ opp }: { opp: OpportunityView }) {
  const v = opp.verdict;
  return (
    <div className="border-t border-border pt-3">
      <div className="flex flex-wrap items-center gap-2 px-0 pb-1">
        <Label>Does the 0–100 score rank? — outcomes by opportunity-score bucket ({opp.source})</Label>
        <Chip tone={verdictTone(v.status)} title={v.reasons.join(" · ")}>{v.status}</Chip>
        <span className="text-xs text-muted-foreground">registered {opp.preregisteredAt} · live line {opp.liveLine} · a paper ranker, not a gate</span>
      </div>
      <Note className="mb-2 text-warn/90">
        The score is stamped on every fresh breakout, taken or refused, and read here against what happened. It earns a live gate only when both ≥{opp.liveLine} and &lt;{opp.liveLine} have {SLICE_MIN} resolved, t(≥{opp.liveLine}) ≥ 2 and ≥{opp.liveLine} out-earns the rest per trade — then a separate PR, after review. Six cuts of one sleeve below is six chances for luck: no cut changes a rule on its own.
      </Note>
      {v.reasons.length > 0 && <p className="mb-1 text-xs text-muted-foreground">{v.reasons.join(" · ")}</p>}
      <div className="rounded-md border border-border">
        <SliceTable title={`By score — ≥${opp.liveLine} / 60–79 / <60`} rows={opp.byScore} />
        <SliceTable title="By event mode at entry" rows={opp.byEventMode} />
        <SliceTable title="By multi-timeframe alignment at entry (1d/4h/1h)" rows={opp.byMtfAligned} />
        <SliceTable title="By funding sign at entry (relative, per 8h)" rows={opp.byFundingSign} />
      </div>
    </div>
  );
}
