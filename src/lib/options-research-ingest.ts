import { OPTIONS_WATCHLIST, type OptionsResearch, type ResearchBar, type ResearchContract, type NativeScan } from "./options-desk-model";
import { nextExDiv, type ResearchEvent, type ResearchEvents } from "./options-events";
const obj=(x:unknown):Record<string,unknown>=>x&&typeof x==="object"&&!Array.isArray(x)?x as Record<string,unknown>:{};
const num=(x:unknown):number=>typeof x==="number"||typeof x==="string"&&x.trim()!==""?Number(x):NaN;
const text=(x:unknown):string=>typeof x==="string"?x:"";
const rows=(x:unknown):Record<string,unknown>[]=>Array.isArray(x)?x.map(obj):[];
const list=(x:unknown,...keys:string[]):Record<string,unknown>[]|null=>{
  if(Array.isArray(x))return rows(x);
  for(const k of keys){const v=obj(x)[k];if(Array.isArray(v))return rows(v);}
  return null;
};
const dayOf=(x:unknown):string|null=>{const t=text(x);const d=t.slice(0,10);return /^\d{4}-\d{2}-\d{2}$/.test(d)&&Number.isFinite(Date.parse(d))?d:null;};
const timingOf=(x:unknown):"am"|"pm"|null=>{const t=text(x).toLowerCase();return /^(am|bmo|before|pre)/.test(t)?"am":/^(pm|amc|after|post)/.test(t)?"pm":null;};
const symbolOf=(row:Record<string,unknown>)=>text(row.symbol);
// Broker shapes captured live Sep 15 2026. Earnings rows (calendar and results alike):
//   {symbol, year, quarter, eps:{estimate, actual}, report:{date:"YYYY-MM-DD", timing:"am"|"pm"|null, verified}} — `verified:false` is
//   tentative and still counts. Fundamentals rows: {symbol, dividend_yield, dividend_per_share, distribution_frequency, payable_date,
//   ex_dividend_date, record_date, …} where ex_dividend_date is the MOST RECENT scheduled ex-date (past or upcoming) and a non-payer
//   has every dividend field null. A row must carry a `report` object to be an earnings row at all.
function earningsOf(row:Record<string,unknown>):{day:string|null;timing:"am"|"pm"|null}{
  const report=obj(row.report);
  return {day:dayOf(report.date),timing:timingOf(report.timing)};
}
const DIVIDEND_FIELDS=["dividend_yield","dividend_per_share","distribution_frequency","payable_date","ex_dividend_date","record_date"];
function response(content:unknown):Record<string,unknown>{
  if(typeof content==="string")return obj(JSON.parse(content));
  if(Array.isArray(content)){
    const parts=content.filter(c=>obj(c).type==="text").map(c=>text(obj(c).text));
    if(parts.length===1)return obj(JSON.parse(parts[0]));
  }
  throw Error("Unrecognized broker tool response");
}
// Read ONLY actual tool-result events, not assistant prose or its summary JSON.
export function parseRobinhoodResearchEvents(jsonl:string,capturedAt=new Date().toISOString()):OptionsResearch{
  const result:OptionsResearch={capturedAt,source:"Robinhood MCP",bars:{},contracts:[],scans:[],errors:[]};
  const uses=new Map<string,{name:string;input:Record<string,unknown>}>();
  const requestedQuotes=new Set<string>();
  const instruments=new Map<string,Record<string,unknown>>(),quotes=new Map<string,Record<string,unknown>>(),scans=new Map<string,NativeScan>();
  const earnings=new Map<string,{day:string;timing:"am"|"pm"|null}>(),dividends=new Map<string,{exDivAt:string|null;source:"scheduled"|"projected"|null;amount:number|null}>();
  let calendarRead=false;
  for(const line of jsonl.split("\n").filter(Boolean)){
    const event=obj(JSON.parse(line));
    for(const block of rows(obj(event.message).content)){
      if(block.type==="tool_use"){
        uses.set(text(block.id),{name:text(block.name),input:obj(block.input)});
        if(block.name==="mcp__robinhood-trading__get_option_quotes"){
          const ids=obj(block.input).instrument_ids;
          if(Array.isArray(ids))for(const id of ids)if(typeof id==="string"&&id)requestedQuotes.add(id);
        }
      }
      if(block.type!=="tool_result")continue;
      const use=uses.get(text(block.tool_use_id));if(!use||!use.name.startsWith("mcp__robinhood-trading__"))continue;
      if(block.is_error){result.errors.push(`${use.name}: broker read failed`);continue;}
      let data:Record<string,unknown>,rawData:unknown;
      try {const envelope=response(block.content);if(envelope.error)throw Error("Broker error");rawData=envelope.data;data=obj(envelope.data);}catch{result.errors.push(`${use.name}: unreadable response`);continue;}
      const name=use.name.replace("mcp__robinhood-trading__","");
      if(name==="get_earnings_calendar"||name==="get_earnings_results"){
        const entries=list(rawData,"results");
        if(!entries||!entries.every(row=>row.report!==undefined)){result.errors.push(`${name}: unrecognized shape`);continue;}
        if(name==="get_earnings_calendar")calendarRead=true;   // only the market-wide calendar can vouch for "none"
        for(const row of entries){
          const symbol=symbolOf(row),{day,timing}=earningsOf(row);
          if(!/^[A-Z.]{1,10}$/.test(symbol)||!day||day<capturedAt.slice(0,10))continue;
          const prior=earnings.get(symbol);if(!prior||day<prior.day)earnings.set(symbol,{day,timing});
        }
      }
      if(name==="get_equity_fundamentals"){
        const entries=list(rawData,"results");
        if(!entries||!entries.every(row=>DIVIDEND_FIELDS.some(k=>k in row))){result.errors.push("get_equity_fundamentals: unrecognized shape");continue;}
        for(const row of entries){
          const symbol=symbolOf(row);if(!/^[A-Z.]{1,10}$/.test(symbol))continue;
          const d=nextExDiv(row,capturedAt.slice(0,10));
          if(!d.known){result.errors.push(`${symbol}: next ex-dividend cannot be placed (last ${text(row.ex_dividend_date)||"?"}, ${text(row.distribution_frequency)||"unknown frequency"}) — spreads refused`);continue;}
          dividends.set(symbol,{exDivAt:d.exDivAt,source:d.source,amount:d.amount});
        }
      }
      if(name==="get_equity_historicals")for(const history of rows(data.results)){
        const symbol=text(history.symbol);if(!/^[A-Z.]{1,10}$/.test(symbol)||history.interval!=="day"||history.bounds!=="regular")continue;
        const bars:ResearchBar[]=rows(history.bars).map(b=>({day:text(b.begins_at).slice(0,10),open:num(b.open_price),high:num(b.high_price),low:num(b.low_price),close:num(b.close_price),volume:num(b.volume)}));
        const valid=bars.every(b=>/^\d{4}-\d{2}-\d{2}$/.test(b.day)&&Number.isFinite(Date.parse(b.day))&&new Date(b.day).toISOString().slice(0,10)===b.day&&[b.open,b.high,b.low,b.close].every(n=>Number.isFinite(n)&&n>0)&&Number.isFinite(b.volume)&&b.volume>=0&&b.high>=Math.max(b.open,b.close)&&b.low<=Math.min(b.open,b.close));
        if(!valid){result.errors.push(`${symbol}: malformed bars`);continue;}
        // Never include today's unfinished daily candle. Preserve source session dates.
        const ny=new Intl.DateTimeFormat("en-CA",{timeZone:"America/New_York",year:"numeric",month:"2-digit",day:"2-digit",hour:"2-digit",hourCycle:"h23"}).formatToParts(new Date(capturedAt));
        const part=(key:string)=>ny.find(p=>p.type===key)?.value??"";
        const sessionDay=`${part("year")}-${part("month")}-${part("day")}`;
        const completed=bars.filter(b=>b.day<sessionDay||(b.day===sessionDay&&Number(part("hour"))>=16)).sort((a,b)=>a.day.localeCompare(b.day));
        if(new Set(completed.map(b=>b.day)).size!==completed.length){result.errors.push(`${symbol}: duplicate bars`);continue;}
        result.bars[symbol]=completed;
      }
      if(name==="get_option_instruments")for(const instrument of rows(data.instruments)){
        if(instrument.state==="active"&&instrument.tradability==="tradable")instruments.set(text(instrument.id),instrument);
      }
      if(name==="get_option_quotes")for(const item of rows(data.results)){const quote=obj(item.quote);quotes.set(text(quote.instrument_id),quote);}
      if(name==="get_scans"||name==="create_scan"){
        const entries=Array.isArray(data.scans)?rows(data.scans):data.scan?[obj(data.scan)]:[obj(data.result??data)];
        for(const scan of entries){const id=text(scan.scan_id)||text(scan.id),scanName=text(scan.scan_title)||text(scan.name);if(id&&scanName.startsWith("Esbueno "))scans.set(id,{id,name:scanName,filters:scan.filters_applied??scan.filters??null,symbols:scans.get(id)?.symbols??[],resultCount:scans.get(id)?.resultCount??null,at:scans.get(id)?.at??null});}
      }
      if(name==="run_scan"){
        const detail=obj(data.result??data);const id=text(use.input.scan_id);const scan=scans.get(id);
        if(scan){const matches=rows(detail.results);scan.symbols=[...new Set([...scan.symbols,...matches.map(x=>text(x.ticker)||text(x.symbol)||text(obj(x.instrument).symbol)).filter(Boolean)])];scan.resultCount=Number.isSafeInteger(detail.total_items)?Number(detail.total_items):Array.isArray(detail.results)?Math.max(scan.resultCount??0,scan.symbols.length):scan.resultCount;scan.at=capturedAt;}
      }
    }
  }
  for(const [id,instrument]of instruments){
    const q=quotes.get(id);if(!q)continue;
    const contract:ResearchContract={id,symbol:text(instrument.chain_symbol),type:instrument.type as "call"|"put",strike:num(instrument.strike_price),expiry:text(instrument.expiration_date),multiplier:num(instrument.trade_value_multiplier),
      bid:num(q.bid_price),ask:num(q.ask_price),bidSize:num(q.bid_size),askSize:num(q.ask_size),at:text(q.updated_at),delta:q.delta==null?null:num(q.delta),iv:q.implied_volatility==null?null:num(q.implied_volatility),theta:q.theta==null?null:num(q.theta),volume:num(q.volume),openInterest:num(q.open_interest),selloutAt:text(instrument.sellout_datetime)||null};
    if(!id||!contract.symbol||!["call","put"].includes(contract.type)||!Number.isFinite(Date.parse(contract.expiry))||!Number.isFinite(Date.parse(contract.at))
      ||![contract.strike,contract.multiplier,contract.bid,contract.ask,contract.bidSize,contract.askSize,contract.volume,contract.openInterest].every(n=>Number.isFinite(n)&&n>=0)
      ||[contract.delta,contract.iv,contract.theta].some(n=>n!==null&&!Number.isFinite(n))){result.errors.push("Malformed contract or quote rejected");continue;}
    result.contracts.push(contract);
  }
  const matched=new Set(result.contracts.map(c=>c.id));
  const unmatched=[...requestedQuotes].filter(id=>!matched.has(id)).length;
  if(unmatched>0)result.errors.push(`${unmatched} requested contracts lacked usable matched quotes`);
  for(const symbol of Object.keys(result.bars))if(!result.contracts.some(c=>c.symbol===symbol))result.errors.push(`${symbol}: no matched option quotes in this collection`);
  // One event row per researched symbol, only once the calendar itself was read: "no earnings" is a statement the
  // broker made, never one this parser infers from silence. The ex-dividend key is present only when fundamentals came back.
  if(calendarRead){
    const events:ResearchEvents={};
    for(const symbol of new Set([...Object.keys(result.bars),...result.contracts.map(c=>c.symbol)])){
      const e=earnings.get(symbol),d=dividends.get(symbol);
      const row:ResearchEvent={earningsAt:e?.day??null,earningsTiming:e?.timing??null,at:capturedAt};
      if(d){row.exDivAt=d.exDivAt;if(d.source)row.exDivSource=d.source;row.dividendAmount=d.amount;}
      events[symbol]=row;
    }
    result.events=events;
  } else if(Object.keys(result.bars).length||result.contracts.length) result.errors.push("earnings calendar not read — every single-name candidate will be refused as unknown");
  result.scans=[...scans.values()];return result;
}

// Current display keeps the base universe plus at most six current discoveries.
// The archive is built from `next` alone, never from this inherited display state.
export function mergeResearchSnapshot(prior: OptionsResearch | null, next: OptionsResearch): OptionsResearch {
  const observed = [...new Set([...Object.keys(next.bars), ...next.contracts.map(c => c.symbol)])];
  const pool = observed.length ? observed : [...Object.keys(prior?.bars ?? {}), ...(prior?.contracts ?? []).map(c => c.symbol)];
  const extras = [...new Set(pool.filter(s => !OPTIONS_WATCHLIST.includes(s)))].sort().slice(0, 6);
  const selected = new Set([...OPTIONS_WATCHLIST, ...extras]);
  const bars = Object.fromEntries([...selected].flatMap(symbol => {
    const rows = next.bars[symbol] ?? prior?.bars[symbol];
    return rows ? [[symbol, rows]] : [];
  }));
  // Event rows carry forward with their original `at`: a stale row refuses on its own (36h) instead of being invented fresh.
  const events = Object.fromEntries([...selected].flatMap(symbol => {
    const row = next.events?.[symbol] ?? prior?.events?.[symbol];
    return row ? [[symbol, row]] : [];
  }));
  return { ...next, bars,
    contracts: [...selected].flatMap(symbol => {
      const fresh = next.contracts.filter(c => c.symbol === symbol);
      return fresh.length ? fresh : (prior?.contracts ?? []).filter(c => c.symbol === symbol);
    }),
    scans: next.scans.length ? next.scans : prior?.scans ?? [],
    ...(Object.keys(events).length ? { events } : {}) };
}

// Small deterministic seed list extracted by code from actual broker scan pages,
// including oversized tool responses that the conversational collector cannot read.
export function discoverySymbols(scans: NativeScan[]): string[] {
  const selected = scans.filter(s => ["Esbueno Bullish Trend", "Esbueno Bearish Trend"].includes(s.name));
  const candidates = selected.flatMap(s => s.symbols.filter(x => /^[A-Z.]{1,10}$/.test(x)).slice(0, 25));
  return [...new Set(candidates)].filter(s => !OPTIONS_WATCHLIST.includes(s)).slice(0, 50);
}
