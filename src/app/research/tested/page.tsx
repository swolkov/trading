import { Chip, type ChipTone } from "@/components/ui/chip";
import { DataTable, Row, Td, Th } from "@/components/ui/data-table";
import { Note, PageHeader, Panel, PanelHeader } from "@/components/ui/panel";
import { TESTED_IDEAS, type TestedVerdict } from "@/data/tested-ideas";

// TESTED IDEAS — read-only. The record of every idea that has been tested and what the test said. Static data
// (src/data/tested-ideas.ts); nothing on this page reads or trades anything.

const VERDICT_TONE: Record<TestedVerdict, ChipTone> = {
  "No edge": "red",
  "Inconclusive": "grey",
  "Useful, not directional": "blue",
  "Holds in sample — caution": "amber",
};

function Verdict({ v }: { v: TestedVerdict }) {
  return <Chip tone={VERDICT_TONE[v]} className="shrink-0">{v}</Chip>;
}

export default function TestedIdeasPage() {
  return (
    <div className="space-y-5">
      <PageHeader
        title="Tested ideas"
        sub="Every idea we have tested, with the verdict. Nothing here is traded automatically; an idea without a positive, out-of-sample test stays untraded."
      />

      <Panel>
        <PanelHeader title="The record" aside={<span>{TESTED_IDEAS.length} ideas</span>} />

        {/* phones: one card per idea */}
        <ul className="divide-y divide-border md:hidden">
          {TESTED_IDEAS.map((t) => (
            <li key={t.idea} className="space-y-1.5 px-4 py-3">
              <div className="flex items-start justify-between gap-3">
                <p className="text-[13px] font-semibold leading-snug">{t.idea}</p>
                <Verdict v={t.verdict} />
              </div>
              <p className="num text-[11px] text-muted-foreground">{t.tested ?? "—"} · {t.markets} · {t.sample}</p>
              <p className="text-xs leading-relaxed">{t.result}</p>
              {t.note && <Note>{t.note}</Note>}
            </li>
          ))}
        </ul>

        {/* tablet and up: the table */}
        <div className="hidden md:block">
          <DataTable>
            <thead><tr><Th>Idea</Th><Th>Tested</Th><Th>Markets</Th><Th>Sample</Th><Th>Result</Th><Th>Verdict</Th></tr></thead>
            <tbody>
              {TESTED_IDEAS.map((t) => (
                <Row key={t.idea}>
                  <Td strong className="min-w-48 whitespace-normal align-top">{t.idea}{t.note && <Note className="mt-1 font-normal">{t.note}</Note>}</Td>
                  <Td muted className="num align-top">{t.tested ?? "—"}</Td>
                  <Td muted className="align-top">{t.markets}</Td>
                  <Td muted className="min-w-28 whitespace-normal align-top">{t.sample}</Td>
                  <Td className="min-w-64 whitespace-normal align-top leading-relaxed">{t.result}</Td>
                  <Td className="align-top"><Verdict v={t.verdict} /></Td>
                </Row>
              ))}
            </tbody>
          </DataTable>
        </div>
      </Panel>
    </div>
  );
}
