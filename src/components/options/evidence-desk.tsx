"use client";
import useSWR from "swr";
import { Panel, PanelHeader, PanelBody, Note, Stat, Empty } from "@/components/ui/panel";
import { DataTable, Row, Th, Td } from "@/components/ui/data-table";
import { ago, money } from "@/lib/format";
import type { OptionsObservation, optionsRiskView, optionsPerformanceCoverage, summarizeOptionsHistory } from "@/lib/options-evidence-model";

interface Evidence {
  current: Omit<OptionsObservation, "quotes"> | null;
  risk: ReturnType<typeof optionsRiskView>;
  performance: ReturnType<typeof optionsPerformanceCoverage>;
  history: ReturnType<typeof summarizeOptionsHistory> & { available: boolean; invalidRecords: number; windowLimit: number };
}
const fetcher = async (url: string): Promise<Evidence> => {
  const response = await fetch(url);
  if (!response.ok) throw Error("Evidence unavailable");
  return response.json();
};
export function OptionsEvidenceDesk() {
  const { data, error } = useSWR<Evidence>("/api/options/evidence", fetcher, { refreshInterval: 60000 });
  if (error) return <Panel tone="amber"><PanelBody>Learning evidence unavailable. No strategy or risk increase is justified by missing data.</PanelBody></Panel>;
  if (!data) return <Panel><Empty>Loading research history and performance coverage...</Empty></Panel>;
  const { current, risk, performance, history } = data;
  return <div className="space-y-5">
    <Panel><PanelHeader title="Account growth and risk" aside="No automatic size increases" /><PanelBody>
      <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
        <Stat label="Broker account value" value={risk.equity == null ? "Unavailable" : money(risk.equity)} sub={risk.accountAt ? `Snapshot ${ago(risk.accountAt)}` : "Waiting for broker confirmation"} />
        <Stat label="Suggested risk range" value={risk.suggestedMin == null || risk.suggestedMax == null ? "Unavailable" : `${money(risk.suggestedMin)}–${money(risk.suggestedMax)}`} sub="1–2% illustration, capped at approved ceiling" />
        <Stat label="Approved ceiling / account" value={risk.ceilingPct == null ? "Unavailable" : `${risk.ceilingPct}%`} sub="Full planned loss, including fees" />
        <Stat label="Net trading profit" value="Not measurable yet" sub="Deposits are not trading profits" />
      </div>
      {!risk.accountFresh && <p className="mt-3 text-xs text-warn">The account snapshot is missing, future-dated or over 15 minutes old. Refresh before making a sizing decision.</p>}
      <Note className="mt-3">{risk.fiveLossDrawdownPct == null ? "A confirmed balance and loss ceiling are required for risk comparisons." : `Five full losses at the approved ceiling would consume ${risk.fiveLossDrawdownPct}% of this snapshot balance, assuming a fixed dollar loss per trade.`} A planned stop does not guarantee a fill. For a purchased option, budget the full premium and fees. Skip if no liquid contract fits.</Note>
      <Note className="mt-2">The suggested percentage range can change with the displayed account balance. It does not change the saved dollar ceiling or authorize a larger order. Performance-based growth requires matched fills, costs and cash-flow reconciliation.</Note>
    </PanelBody></Panel>
    <Panel><PanelHeader title="Strategy evidence" aside="Research observations, not simulated trades" /><PanelBody>
      <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
        <Stat label="Archived collections" value={history.available ? String(history.captures) : "Unavailable"} sub={`Latest ${history.windowLimit} collections shown`} />
        <Stat label="Distinct contract quotes" value={history.available ? String(history.distinctContractQuotes) : "Unavailable"} sub="Repeated timestamps count once" />
        <Stat label="Call setup sessions" value={history.available ? String(history.callSetupSessions) : "Unavailable"} sub="Unique symbol / session / rule version" />
        <Stat label="Put setup sessions" value={history.available ? String(history.putSetupSessions) : "Unavailable"} sub="Unique symbol / session / rule version" />
      </div>
      <Note className="mt-3">Every saved collection preserves real option quotes, their source timestamps, the screening rules and exclusion reasons. Repeated scans do not create extra trades or profit. Rule changes require a separate version and review; the system does not rewrite its strategy after a few winners.</Note>
      {!history.available && <p className="mt-2 text-xs text-warn">The research archive is unavailable. The collector must successfully store a collection before history can be assessed.</p>}
      {!!history.invalidRecords && <p className="mt-2 text-xs text-warn">{history.invalidRecords} malformed archived collections excluded.</p>}
      {history.newestQuote && <Note className="mt-2">Archived quote coverage: {history.oldestQuote?.slice(0, 10)} to {history.newestQuote.slice(0, 10)}. This is observed data coverage, not a completed backtest.</Note>}
    </PanelBody></Panel>
    <Panel><PanelHeader title="Why contracts do or do not qualify" aside={current ? `Source collection ${ago(current.capturedAt)}` : "Waiting for research"} />
      <PanelBody><Note>Minimum premium is for one collected long option before fees. Affordable counts check price only; quality counts check liquidity, expiration and contract format. Reasons overlap. Research candidates include spreads and still require fresh quotes and all live checks.</Note></PanelBody>
      {current?.symbols.length ? <DataTable><thead><tr><Th>Symbol / setup</Th><Th num>Contracts</Th><Th num>Minimum premium</Th><Th num>Affordable longs</Th><Th num>Quality / fresh quotes</Th><Th>Exclusions</Th></tr></thead><tbody>
        {current.symbols.map(s => <Row key={s.symbol}>
          <Td>{s.symbol}<div className="mt-1 text-xs text-muted">{s.setup}</div></Td>
          <Td num>{s.contracts}</Td><Td num>{s.minimumPremium == null ? "Unavailable" : money(s.minimumPremium)}</Td>
          <Td num>{s.affordableLongs}</Td><Td num>{s.qualityContracts} / {s.freshQuotes}</Td>
          <Td><details><summary className="cursor-pointer text-xs">{s.exclusions.length ? `${s.exclusions.length} reasons` : "No contract exclusions"}</summary><ul className="mt-2 space-y-1 text-xs">{s.exclusions.map(e => <li key={e.reason}>{e.reason}: {e.contracts}</li>)}</ul></details></Td>
        </Row>)}
      </tbody></DataTable> : <Empty>No usable broker research to diagnose.</Empty>}
    </Panel>
    <Panel><PanelHeader title="What is needed to measure real results" aside="Win rate, returns and drawdown unavailable" /><PanelBody>
      <p className="text-sm">{performance.observedOrders == null ? "No usable order snapshot." : `${performance.observedOrders} orders and ${performance.observedPositions ?? "unknown"} positions in the latest account snapshot.`} This is not a complete performance ledger.</p>
      <ul className="mt-3 list-disc space-y-1 pl-5 text-xs">{performance.gaps.map(gap => <li key={gap}>{gap}</li>)}</ul>
      <Note className="mt-3">Assess calls and puts separately using net results after costs, average wins and losses, and drawdown. Historical studies need actual option quotes and a separate evaluation period. An early trade sample checks operations; it does not prove future profitability. Options paper remains retired.</Note>
    </PanelBody></Panel>
    <Panel><PanelHeader title="Collection history" aside="Original screening decisions preserved" />
      {history.recent.length ? <DataTable><thead><tr><Th>Collected</Th><Th num>Symbols / quotes</Th><Th num>Research candidates</Th><Th num>Read errors</Th><Th>Rules</Th></tr></thead><tbody>{history.recent.map(o => <Row key={`${o.capturedAt}:${o.screenedAt}`}><Td>{ago(o.capturedAt)}</Td><Td num>{o.symbols} / {o.contracts}</Td><Td num>{o.candidates}</Td><Td num>{o.errors}</Td><Td>{o.ruleVersion}</Td></Row>)}</tbody></DataTable> : <Empty>No archived collections available yet.</Empty>}
    </Panel>
  </div>;
}
