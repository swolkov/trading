"use client";
import useSWR from "swr";
import { OptionsEvidenceDesk } from "./evidence-desk";
import { Chip } from "@/components/ui/chip";
import { Panel, PanelHeader, PanelBody, Note, Stat, Empty } from "@/components/ui/panel";
import { DataTable, Row, Th, Td } from "@/components/ui/data-table";
import { money, ago } from "@/lib/format";
import type { StrategySignal, ResearchCandidate, NativeScan } from "@/lib/options-desk-model";
import type { OptionsNews } from "@/lib/options-news";
interface Desk {
  execution:{canPlaceOrders:boolean;blockers:string[]};maxLoss:number|null;riskPct:number|null;
  rules:{maxContracts:number;maxPositions:number;minDte:number;maxDte:number;exitBeforeDte:number;minOpenInterest:number;minVolume:number;maxSpreadPct:number};
  research:{capturedAt:string;source:string;contractCount:number;scans:NativeScan[];errors:string[]}|null;
  signals:StrategySignal[];candidates:ResearchCandidate[];news:OptionsNews;
  strategies:{name:string;structures:string;rule:string}[];
}
const fetcher=async(url:string)=>{const r=await fetch(url);if(!r.ok)throw Error("Desk status unavailable");return r.json();};
export function OptionsResearchDesk(){
  const {data,error}=useSWR<Desk>("/api/options/desk",fetcher,{refreshInterval:60000});
  if(error)return <Panel tone="red"><PanelBody>Options research is unavailable. Trading remains blocked.</PanelBody></Panel>;
  if(!data)return <Panel><Empty>Loading scanners, news and readiness checks...</Empty></Panel>;
  return <div className="space-y-5">
    <Panel tone="amber"><PanelHeader title="Live readiness" aside={<Chip tone="amber">Entries blocked</Chip>}/><PanelBody>
      <p className="text-sm">Research scanners can run now. Automatic orders and exits are not operational.</p>
      <ul className="mt-2 list-disc space-y-1 pl-5 text-xs">{data.execution.blockers.map(reason=><li key={reason}>{reason}</li>)}</ul>
    </PanelBody></Panel>
    <Panel><PanelHeader title="Sizing and contract rules"/><PanelBody>
      <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
        <Stat label="Approved loss ceiling" value={data.maxLoss==null?"Unset":money(data.maxLoss)} sub={data.riskPct==null?"Includes fees":`${data.riskPct.toFixed(1)}% of account, including fees`}/>
        <Stat label="Initial quantity" value="1" sub="One contract, or one contract per spread leg"/>
        <Stat label="Expiration window" value={`${data.rules.minDte}–${data.rules.maxDte} days`} sub={`Exit review before ${data.rules.exitBeforeDte} days remain`}/>
        <Stat label="Open positions" value="1 maximum" sub="No averaging down or automatic size increases"/>
      </div>
      <Note className="mt-4">Use the account-based risk illustration below as a starting point only when a liquid contract fits. The approved dollar ceiling is not a spending target. Skip trades that cannot meet the budget without weak liquidity or far-out-of-the-money contracts. Screening reserves $1 per contract for round-trip fees; the actual broker fee review must still pass.</Note>
      <Note className="mt-2">At least {data.rules.minOpenInterest} open contracts, {data.rules.minVolume} daily volume and bid/ask spread no wider than {data.rules.maxSpreadPct}% of the midpoint. No naked shorts, expiry-day entries or separate-leg spread orders.</Note>
    </PanelBody></Panel>
    <OptionsEvidenceDesk />
    <Panel><PanelHeader title="Strategy playbook" aside="Rules under review; no proven profit claim"/><PanelBody><div className="grid gap-4 md:grid-cols-3">{data.strategies.map(s=><div key={s.name}><h3 className="text-sm font-semibold">{s.name}</h3><p className="mt-1 text-xs">{s.structures}</p><Note className="mt-2">{s.rule}</Note></div>)}</div></PanelBody></Panel>
    <Panel><PanelHeader title="Robinhood scanners" aside={data.research?`Collected ${ago(data.research.capturedAt)}`:"Waiting for collection"}/>
      {data.research?.scans.length?<PanelBody><div className="grid gap-4 md:grid-cols-3">{data.research.scans.map(s=><div key={s.id}><h3 className="text-sm font-semibold">{s.name}</h3><p className="mt-1 text-xs">{s.resultCount==null?"Saved in Robinhood; results not collected":`${s.resultCount} matches${s.at?` as of ${ago(s.at)}`:""}`}</p><Note className="mt-2">{s.symbols.slice(0,12).join(", ")||"No matching symbols captured"}</Note><details className="mt-2 text-xs"><summary className="cursor-pointer">Applied broker filters</summary><pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap text-[10px]">{JSON.stringify(s.filters,null,2)}</pre></details></div>)}</div></PanelBody>:<Empty>No verified saved scanners collected yet.</Empty>}
      {data.research?.errors.length?<PanelBody><Note>{data.research.errors.join("; ")}</Note></PanelBody>:null}
    </Panel>
    <Panel><PanelHeader title="Daily trend watch" aside="Completed daily bars from Robinhood"/>
      {data.signals.length?<DataTable><thead><tr><Th>Symbol</Th><Th>Bias</Th><Th>Setup</Th><Th num>Close</Th><Th num>Relative volume</Th><Th>Session</Th></tr></thead><tbody>{data.signals.map(s=><Row key={s.symbol}><Td>{s.symbol}</Td><Td>{s.direction}</Td><Td>{s.setup}</Td><Td num>{money(s.close)}</Td><Td num>{s.relativeVolume?.toFixed(2)??"Unavailable"}</Td><Td>{s.day}</Td></Row>)}</tbody></DataTable>:<Empty>Waiting for enough verified daily history.</Empty>}
    </Panel>
    <Panel><PanelHeader title="Contracts that fit the budget" aside={`${data.research?.contractCount??0} broker contracts collected`}/>
      <PanelBody><Note>Research candidates are not executable orders. Prices retain the broker timestamp. Fresh quotes, event checks, account checks and broker review are required at entry. Spread and long-put profits are capped; long calls have no fixed upside cap.</Note></PanelBody>
      {data.candidates.length?<DataTable><thead><tr><Th>Symbol / structure</Th><Th>Strikes / expiry</Th><Th num>Planned loss + fees</Th><Th num>Maximum profit at expiry</Th><Th>Quote age</Th></tr></thead><tbody>{data.candidates.map(c=><Row key={c.kind+c.legs.join(":")}><Td>{c.symbol} · {c.kind.replaceAll("_"," ")}</Td><Td>{c.strikes.join(" / ")} · {c.expiry}</Td><Td num>{money(c.plannedLoss)}</Td><Td num>{c.maxProfit==null?"No fixed cap":money(c.maxProfit)}</Td><Td>{ago(c.quoteAt)} · {c.quoteFresh?"fresh":"refresh required"}</Td></Row>)}</tbody></DataTable>:<Empty>No collected contracts pass the current budget and liquidity screen. This does not establish that the entire market has no eligible contracts.</Empty>}
    </Panel>
    <Panel><PanelHeader title="News and upcoming events" aside={<Chip tone={data.news.available?"green":"amber"}>{data.news.available?"News connected":"News unavailable"}</Chip>}/><PanelBody>
      {data.news.error&&<p className="mb-3 text-xs text-warn">{data.news.error}. Missing calendars block live entry.</p>}
      <div className="grid gap-5 md:grid-cols-2"><div><h3 className="mb-2 text-sm font-semibold">Market headlines</h3>{data.news.headlines.map(n=><div key={n.url} className="mb-3"><a href={n.url} target="_blank" rel="noopener noreferrer" className="text-sm hover:underline">{n.headline}</a><Note>{n.source} · {ago(n.at)}</Note></div>)}{!data.news.headlines.length&&<Note>No current headlines available.</Note>}</div>
      <div><h3 className="text-sm font-semibold">Earnings: watchlist, next 14 days</h3><Note className="mt-2">{data.news.earningsAvailable?(data.news.earnings.map(e=>`${e.symbol}: ${e.date} (${e.hour})`).join("; ")||"No watchlist earnings reported in this window"):"Calendar unavailable"}</Note>
      <h3 className="mt-4 text-sm font-semibold">US economic events</h3><ul className="mt-2 space-y-2 text-xs">{data.news.macro.slice(0,12).map((e,i)=><li key={`${e.time}:${i}`}>{e.time} · {e.event} ({e.impact})</li>)}</ul>{!data.news.macroAvailable&&<Note>Calendar unavailable</Note>}
      <Note className="mt-4">No new single-stock positions through earnings without explicit review. Credit spreads need dividend and assignment checks. Headlines provide context, not instructions to trade.</Note></div></div>
    </PanelBody></Panel>
  </div>;
}
