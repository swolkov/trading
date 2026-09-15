import test from "node:test";
import assert from "node:assert/strict";
import { parseRobinhoodResearchEvents } from "../src/lib/options-research-ingest";
import { OPTIONS_DESK_RULES, contractQualityFailures, deltaBandOf, dteBucketOf, isOptionsResearch, noCandidateNote, screenResearchContracts, realizedVol20, impliedMoveFrac, payoffAtUsd, type OptionsResearch, type ResearchContract } from "../src/lib/options-desk-model";
import { mergeResearchSnapshot } from "../src/lib/options-research-ingest";
import { exDivRisk, nextExDiv, spansEarnings } from "../src/lib/options-events";
import { loadOptionsNews } from "../src/lib/options-news";
import { parseRpcResponse, validOAuthState, RobinhoodReadClient } from "../scripts/robinhood/client";
import { assertDurableOptionsIntent } from "../src/lib/options-live-store";
import { optionsRequestFingerprint, OPTIONS_LIVE_ACCOUNT } from "../src/lib/options-live-policy";
import type { OptionsIntentRecord } from "../src/lib/options-live-executor";
const now=Date.parse("2026-09-12T16:00:00Z");
const capture=(name:string,data:unknown)=>JSON.stringify({message:{content:[{type:"tool_use",id:"read-1",name:`mcp__robinhood-trading__${name}`,input:{}}]}})+"\n"+JSON.stringify({message:{content:[{type:"tool_result",tool_use_id:"read-1",content:JSON.stringify({data})}]}});
function research():OptionsResearch{
 const bars=Array.from({length:201},(_,i)=>({day:new Date(now-(201-i)*86400000).toISOString().slice(0,10),open:100,high:i===200?106:101,low:99,close:i===200?105:100,volume:1000000}));
 const c:ResearchContract={id:"a",symbol:"TEST",type:"call",strike:105,expiry:"2026-10-16",multiplier:100,bid:0.85,ask:0.9,bidSize:10,askSize:10,at:new Date(now).toISOString(),delta:0.5,iv:0.25,theta:-0.01,volume:500,openInterest:1000,selloutAt:null};
 // A fresh event row: calendar read (no earnings ahead), fundamentals read (no ex-dividend). Without it a single name is refused as unknown.
 return {source:"Robinhood MCP",capturedAt:new Date(now).toISOString(),bars:{TEST:bars},contracts:[c],scans:[],errors:[],events:{TEST:{earningsAt:null,earningsTiming:null,calendarThrough:"2026-11-11",exDivAt:null,dividendAmount:null,at:new Date(now).toISOString()}}};
}
test("after-close Friday bar is included, intraday incomplete bar excluded",()=>{
 const raw=capture("get_equity_historicals",{results:[{symbol:"SPY",interval:"day",bounds:"regular",bars:[{begins_at:"2026-09-11T00:00:00Z",open_price:"100",high_price:"102",low_price:"99",close_price:"101",volume:1000}]}]});
 assert.equal(parseRobinhoodResearchEvents(raw,"2026-09-11T21:30:00Z").bars.SPY.length,1);
 assert.equal(parseRobinhoodResearchEvents(raw,"2026-09-11T19:30:00Z").bars.SPY.length,0);
});
test("source dates and exact capture time are preserved, assistant summaries ignored",()=>{
 const r=parseRobinhoodResearchEvents(JSON.stringify({message:{content:[{type:"text",text:'{"data":{"contracts":[{"price":0.01}]}}'}]}}),"2026-09-01T12:00:00Z");
 assert.equal(r.capturedAt,"2026-09-01T12:00:00Z");assert.equal(r.contracts.length,0);
});
test("malformed stored research and impossible source bars fail validation",()=>{
 for(const value of [null,{},[],{contracts:[]}])assert.equal(isOptionsResearch(value),false);
 assert.equal(isOptionsResearch(research()),true);
 const raw=capture("get_equity_historicals",{results:[{symbol:"SPY",interval:"day",bounds:"regular",bars:[{begins_at:"2026-02-30T00:00:00Z",open_price:100,high_price:102,low_price:99,close_price:101,volume:100}]}]});
 assert.equal(parseRobinhoodResearchEvents(raw).errors.length,1);
});
test("contract screening uses actual affordable debit and reserves fees inside $100",()=>{
 const r=research();const candidates=screenResearchContracts(r,100,500,now);assert.equal(candidates.length,1);assert.equal(candidates[0].plannedLoss,91);assert.equal(candidates[0].quantity,1);
 r.contracts[0].bid=0.98;r.contracts[0].ask=0.991;
 assert.equal(screenResearchContracts(r,100,500,now).length,0); // rounds debit to $1 + fees, not 99.1 cents
});
test("old daily data, watch-only trends, future quotes and weak liquidity cannot qualify",()=>{
 const base=research();
 const stale=structuredClone(base);stale.bars.TEST=stale.bars.TEST.map(b=>({...b,day:b.day.replace("2026","2025")}));assert.equal(screenResearchContracts(stale,100,500,now).length,0);
 const watch=structuredClone(base);watch.bars.TEST.at(-2)!.high=200;assert.equal(screenResearchContracts(watch,100,500,now).length,0);
 for(const changed of [{at:new Date(now+1).toISOString()},{openInterest:0},{volume:0},{bid:0},{multiplier:10},{delta:0.1}]){
  const r=structuredClone(base);Object.assign(r.contracts[0],changed);assert.equal(screenResearchContracts(r,100,500,now).length,0);
 }
});
test("stale contract prices are retained as research, explicitly not fresh",()=>{
 const r=research();r.contracts[0].at=new Date(now-60000).toISOString();assert.equal(screenResearchContracts(r,100,500,now)[0].quoteFresh,false);
});
test("null provider envelopes and malformed rows yield unavailable, never a crash",async()=>{
 const original=globalThis.fetch,old=process.env.FINNHUB_API_KEY;process.env.FINNHUB_API_KEY="offline-test";
 try{
  globalThis.fetch=async()=>Response.json(null);const empty=await loadOptionsNews(new Date(now));assert.equal(empty.available,false);assert.equal(empty.earningsAvailable,false);assert.equal(empty.macroAvailable,false);
  globalThis.fetch=async()=>Response.json([null]);const broken=await loadOptionsNews(new Date(now));assert.equal(broken.available,false);
  globalThis.fetch=async()=>new Response("denied",{status:403});const denied=await loadOptionsNews(new Date(now));assert.match(denied.error??"",/unavailable/);
 }finally{globalThis.fetch=original;if(old===undefined)delete process.env.FINNHUB_API_KEY;else process.env.FINNHUB_API_KEY=old;}
});
test("MCP responses match exact request IDs and refuse ambiguous/errors",()=>{
 assert.deepEqual(parseRpcResponse('data: {"jsonrpc":"2.0","id":1,"result":{"ok":true}}\n\n',1),{ok:true});
 for(const raw of ['{"id":2,"result":{}}','{"id":1,"error":{"message":"no"}}','data: {"id":1,"result":{}}\n\ndata: {"id":1,"result":{}}\n\n'])assert.throws(()=>parseRpcResponse(raw,1));
});
test("OAuth compares byte lengths safely and the native client rejects all money mutations",async()=>{
 assert.equal(validOAuthState("é".repeat(43),"a".repeat(43)),false);assert.equal(validOAuthState("abc","abc"),true);assert.equal(validOAuthState("abc","abd"),false);
 const c=new RobinhoodReadClient();for(const tool of ["place_option_order","cancel_option_order","place_equity_order","exercise_option","review_option_order"]){await assert.rejects(()=>c.call(tool,{}),/read-only/);}
});
function record():OptionsIntentRecord{
 const intent={refId:"4da09d6d-804f-49b1-b4e9-3f7d4044f667",action:"open" as const,kind:"long_call" as const,quantity:1,limitPrice:0.9,legs:[{optionId:"contract-a",side:"buy" as const}]};
 const canonicalOrder={account_number:OPTIONS_LIVE_ACCOUNT,legs:[{option_id:"contract-a",side:"buy" as const,position_effect:"open" as const,ratio_quantity:1}],quantity:"1",direction:"debit" as const,type:"limit" as const,price:"0.90",time_in_force:"gfd" as const,market_hours:"regular_hours" as const};
 return{refId:intent.refId,accountNumber:OPTIONS_LIVE_ACCOUNT,action:"open",fingerprint:optionsRequestFingerprint(canonicalOrder),state:"submitting",intent,canonicalOrder};
}
test("durable records preserve canonical order, UUID, ownership and broker ID",()=>{
 const r=record();assert.doesNotThrow(()=>assertDurableOptionsIntent(r,null));
 for(const changed of [{refId:"wrong"},{action:"close"},{positionId:"foreign"},{canonicalOrder:undefined},{intent:{...r.intent,quantity:2}}])assert.throws(()=>assertDurableOptionsIntent({...r,...changed} as OptionsIntentRecord,null));
 const accepted={...r,state:"accepted" as const,order:{id:"known",accountNumber:OPTIONS_LIVE_ACCOUNT,refId:r.refId,requestFingerprint:r.fingerprint,state:"open" as const,filledQuantity:0}};
 assert.throws(()=>assertDurableOptionsIntent({...accepted,order:{...accepted.order,id:"other"}},accepted));
});

test("an empty entry tick names the gate: no breakout, or a breakout nothing under the cap could express",()=>{
 const withSignal=research();
 assert.match(noCandidateNote(withSignal,100,now),/signal on TEST bullish but no long call\/put or debit spread fits the \$100 cap/);
 const quiet=research(); quiet.bars.TEST=quiet.bars.TEST.map(b=>({...b,high:101,close:100}));
 assert.match(noCandidateNote(quiet,100,now),/no 20-session breakout or breakdown among the 1 researched names/);
});

test("single leg vs spread follows implied-versus-realized vol; ranking is payoff per dollar at the market's expected move; lottery tickets are rejected",()=>{
 const base=research(); const c0=base.contracts[0]; // ATM call 105 @ 0.90, delta 0.5, spot 105
 const put={...c0,id:"p",type:"put" as const,strike:105,bid:0.85,ask:0.9,delta:-0.5};
 const far={...c0,id:"far",strike:110,bid:0.28,ask:0.3,delta:0.35};
 const rich=structuredClone(base); rich.contracts=[{...c0,iv:0.9},{...put,iv:0.9},{...far,iv:0.9}];  // realized ≈ low (flat bars), implied 90% → rich → spread first
 const rv=realizedVol20(rich.bars.TEST)!; assert.ok(rv>0&&rv<0.9);
 const em=impliedMoveFrac(rich.contracts,"2026-10-16",105)!; assert.ok(Math.abs(em-1.75/105)<1e-9);
 const r1=screenResearchContracts(rich,100,500,now);
 assert.deepEqual(r1.map(x=>x.kind),["call_debit","long_call"]);                  // the 110 single is worth nothing at the expected move → rejected
 assert.ok(r1[0].ivToRealized!>1.15); assert.match(r1[0].reason,/spread preferred/);
 assert.equal(r1[0].payoffAtMoveUsd,Math.round(payoffAtUsd("call_debit",c0,far,105*(1+em),0.62,2)*100)/100);
 const fair=structuredClone(rich); for(const x of fair.contracts)x.iv=rv*1.1;         // implied within 15% of realized → single first
 const r2=screenResearchContracts(fair,100,500,now);
 assert.deepEqual(r2.map(x=>x.kind),["long_call","call_debit"]); assert.match(r2[0].reason,/single leg preferred/);
 const noIv=structuredClone(rich); for(const x of noIv.contracts)x.iv=null;           // unknown vol → spreads by default
 assert.equal(screenResearchContracts(noIv,100,500,now)[0].kind,"call_debit");
});

test("ingest: earnings calendar and fundamentals become event rows for researched symbols only; unknown shapes are errors, not rows",()=>{
 const use=(id:string,name:string,input:unknown={})=>({type:"tool_use",id,name:`mcp__robinhood-trading__${name}`,input});
 const res=(id:string,data:unknown)=>({type:"tool_result",tool_use_id:id,content:JSON.stringify({data})});
 const bars=Array.from({length:3},(_,i)=>({begins_at:`2026-09-0${8+i}T00:00:00Z`,open_price:"100",high_price:"102",low_price:"99",close_price:"101",volume:1000}));
 // Real broker shapes captured live Sep 15 2026 (get_earnings_calendar page, get_equity_fundamentals for F / SOFI / SPY).
 const calendarRow=(symbol:string,date:string,timing:"am"|"pm"|null,verified=false)=>({symbol,year:2026,quarter:3,eps:{estimate:"0.170000",actual:null},report:{date,timing,verified}});
 const noDividend={dividend_yield:null,dividend_per_share:null,distribution_frequency:null,payable_date:null,ex_dividend_date:null,record_date:null};
 const fundamentals={
  F:{symbol:"F",market_cap:"45000000000",pe_ratio:"11.2",dividend_yield:"4.294918",dividend_per_share:"0.150000",distribution_frequency:"Quarterly",payable_date:"2026-09-01",ex_dividend_date:"2026-08-11",record_date:"2026-08-11"},
  SOFI:{symbol:"SOFI",market_cap:"30000000000",pe_ratio:"48.1",...noDividend},
  SPY:{symbol:"SPY",dividend_yield:"1.1",dividend_per_share:"1.750000",distribution_frequency:"Quarterly",payable_date:"2026-10-31",ex_dividend_date:"2026-09-18",record_date:"2026-09-18"},
 };
 const page1=[calendarRow("NOTUS","2026-10-01","pm",true),calendarRow("F","2026-10-14","pm",true)], page2=[calendarRow("SOFI","2026-10-27","am"),calendarRow("F","2026-10-28","pm",true)];
 type Page={input:Record<string,unknown>;data:Record<string,unknown>};
 const build=(sofiFundamentals:unknown,pages:Page[]=[{input:{days:31},data:{results:page1}},{input:{start_date:"2026-10-16",days:31},data:{results:page2}}],fundKey="results")=>[
  {message:{content:[use("h","get_equity_historicals"),...pages.map((p,i)=>use(`e${i}`,"get_earnings_calendar",p.input)),use("f","get_equity_fundamentals",{symbols:["F","SOFI","SPY"]})]}},
  {message:{content:[res("h",{results:["F","SOFI","SPY"].map(symbol=>({symbol,interval:"day",bounds:"regular",bars}))})]}},
  {message:{content:pages.map((p,i)=>res(`e${i}`,p.data))}},
  {message:{content:[res("f",{[fundKey]:[fundamentals.F,sofiFundamentals,fundamentals.SPY]})]}},
 ].map(l=>JSON.stringify(l)).join("\n");
 const r=parseRobinhoodResearchEvents(build(fundamentals.SOFI),"2026-09-15T21:30:00Z");
 assert.deepEqual(r.events,{
  F:{earningsAt:"2026-10-14",earningsTiming:"pm",calendarThrough:"2026-11-15",exDivAt:"2026-11-10",exDivSource:"projected",dividendAmount:0.15,at:"2026-09-15T21:30:00Z"},   // earliest of two; last ex-date Aug 11 + 91d
  SOFI:{earningsAt:"2026-10-27",earningsTiming:"am",calendarThrough:"2026-11-15",exDivAt:null,dividendAmount:null,at:"2026-09-15T21:30:00Z"},                          // tentative counts; no dividend
  SPY:{earningsAt:null,earningsTiming:null,calendarThrough:"2026-11-15",exDivAt:"2026-09-18",exDivSource:"scheduled",dividendAmount:1.75,at:"2026-09-15T21:30:00Z"},  // absent from both pages = none through Nov 15
 });
 assert.equal(isOptionsResearch(r),true);
 // Coverage is proven per page: one page → through day 31 only; an empty page or a paginated one proves nothing; a gap ends the run.
 const one=parseRobinhoodResearchEvents(build(fundamentals.SOFI,[{input:{days:31},data:{results:page1}}]),"2026-09-15T21:30:00Z");
 assert.equal(one.events!.SPY.calendarThrough,"2026-10-15");
 assert.equal(spansEarnings("SPY","2026-10-16",one.events,Date.parse("2026-09-15T21:30:00Z")).permitted,true);     // ETF: exempt regardless
 assert.equal(spansEarnings("SOFI","2026-10-15",one.events,Date.parse("2026-09-15T21:30:00Z")).permitted,true);
 const past=spansEarnings("SOFI","2026-10-16",one.events,Date.parse("2026-09-15T21:30:00Z"));
 assert.equal(past.permitted,false); assert.equal(past.earningsClass,"unknown"); assert.match(past.note,/proven only through 2026-10-15; expiry 2026-10-16 is beyond it/);
 const empty=parseRobinhoodResearchEvents(build(fundamentals.SOFI,[{input:{days:31},data:{results:[]}}]),"2026-09-15T21:30:00Z");
 assert.equal(empty.events,undefined); assert.ok(empty.errors.some(e=>/page from 2026-09-15 proves no coverage \(empty\)/.test(e)));
 const paged=parseRobinhoodResearchEvents(build(fundamentals.SOFI,[{input:{days:31},data:{results:page1,next:"cursor-2"}}]),"2026-09-15T21:30:00Z");
 assert.equal(paged.events,undefined); assert.ok(paged.errors.some(e=>/proves no coverage \(paginated\)/.test(e)));
 const gap=parseRobinhoodResearchEvents(build(fundamentals.SOFI,[{input:{days:31},data:{results:page1}},{input:{start_date:"2026-10-20",days:31},data:{results:page2}}]),"2026-09-15T21:30:00Z");
 assert.equal(gap.events!.SOFI.calendarThrough,"2026-10-15");
 const late=parseRobinhoodResearchEvents(build(fundamentals.SOFI,[{input:{start_date:"2026-10-16",days:31},data:{results:page2}}]),"2026-09-15T21:30:00Z");
 assert.equal(late.events,undefined);
 // A past ex-date with an unknown frequency cannot be projected → the ex-dividend key stays absent (spreads refused), and the parser says so.
 const odd=parseRobinhoodResearchEvents(build({...fundamentals.F,symbol:"SOFI",distribution_frequency:"Irregular"}),"2026-09-15T21:30:00Z");
 assert.equal("exDivAt" in odd.events!.SOFI,false); assert.ok(odd.errors.some(e=>/SOFI: next ex-dividend cannot be placed \(last 2026-08-11, Irregular\)/.test(e)));
 // A fundamentals row without the dividend fields, or a calendar row without a report object, is not the broker's shape → error, nothing recorded.
 const noFields=parseRobinhoodResearchEvents(build({symbol:"SOFI",pe_ratio:"12"}),"2026-09-15T21:30:00Z");
 assert.equal(noFields.events!.SPY.exDivAt,undefined); assert.ok(noFields.errors.some(e=>/get_equity_fundamentals: unrecognized shape/.test(e)));
 const badCal=parseRobinhoodResearchEvents(build(fundamentals.SOFI,[{input:{days:31},data:{stuff:page1}}]),"2026-09-15T21:30:00Z");
 assert.equal(badCal.events,undefined); assert.ok(badCal.errors.some(e=>/get_earnings_calendar: unrecognized shape/.test(e))); assert.ok(badCal.errors.some(e=>/earnings calendar not read/.test(e)));
 // Stored snapshots written before events existed still load; a malformed row does not.
 assert.equal(isOptionsResearch({...research(),events:undefined}),true);
 assert.equal(isOptionsResearch({...research(),events:{TEST:{earningsAt:"soon",earningsTiming:null,calendarThrough:"2026-11-11",at:"2026-09-12T21:30:00Z"}}}),false);
 assert.equal(isOptionsResearch({...research(),events:{TEST:{earningsAt:null,earningsTiming:null,at:"2026-09-12T21:30:00Z"}}}),false);   // no proven coverage is not a row
 assert.equal(isOptionsResearch({...research(),events:{TEST:{earningsAt:null,earningsTiming:null,calendarThrough:"2026-11-11",exDivAt:"2026-10-01",exDivSource:"guessed",at:"2026-09-12T21:30:00Z"}}}),false);
 // Merge carries a prior row forward with its original clock when the run lacks one; a fresh row wins.
 const prior={...research(),events:{TEST:{earningsAt:null,earningsTiming:null,calendarThrough:"2026-11-09",exDivAt:null,dividendAmount:null,at:"2026-09-10T21:30:00Z"}}};
 assert.equal(mergeResearchSnapshot(prior,{...research(),events:undefined}).events?.TEST.at,"2026-09-10T21:30:00Z");
 assert.equal(mergeResearchSnapshot(prior,research()).events?.TEST.at,new Date(now).toISOString());
});

test("earnings on or before expiry is an EARNINGS TRADE: zero candidates and the note names the date; unknown or stale rows refuse a single name; index ETFs are exempt",()=>{
 const r=research(); r.events!.TEST.earningsAt="2026-10-14"; r.events!.TEST.earningsTiming="pm";
 assert.equal(screenResearchContracts(r,100,500,now).length,0);
 assert.match(noCandidateNote(r,100,now),/signal on TEST bullish but earnings 2026-10-14 falls before expiry 2026-10-16 \(1 refused by the earnings rule\)/);
 const after=research(); after.events!.TEST.earningsAt="2026-10-17";
 assert.equal(screenResearchContracts(after,100,500,now)[0].earningsAt,"2026-10-17"); assert.equal(screenResearchContracts(after,100,500,now)[0].earningsClass,"none");
 const none=research(); delete none.events;
 assert.equal(screenResearchContracts(none,100,500,now).length,0); assert.match(noCandidateNote(none,100,now),/earnings unknown — no calendar read for TEST/);
 const stale=research(); stale.events!.TEST.at=new Date(now-37*3600_000).toISOString();
 assert.equal(screenResearchContracts(stale,100,500,now).length,0); assert.match(noCandidateNote(stale,100,now),/earnings data for TEST is 37h old/);
 assert.equal(screenResearchContracts({...research(),events:{TEST:{...research().events!.TEST,at:new Date(now-35*3600_000).toISOString()}}},100,500,now).length,1);
 const etf=research(); etf.bars={SPY:etf.bars.TEST}; etf.contracts=[{...etf.contracts[0],symbol:"SPY"}]; delete etf.events;
 const spy=screenResearchContracts(etf,100,500,now); assert.equal(spy.length,1); assert.equal(spy[0].earningsClass,"none"); assert.equal(spy[0].exDivAt,null);
 assert.deepEqual(spansEarnings("QQQ","2026-10-16",undefined,now).permitted,true);
 assert.equal(spansEarnings("TEST","2026-10-16",{TEST:{earningsAt:"2026-09-01",earningsTiming:null,calendarThrough:"2026-11-11",at:new Date(now).toISOString()}},now).permitted,true); // already reported
});

test("ex-dividend: a call debit whose short call the expected move can reach before the ex-date is refused, a put debit is not; no fundamentals → spreads refused, single legs allowed",()=>{
 const base=research(); const c0=base.contracts[0];                                   // spot 105, ATM call 105 @ 0.90
 const put={...c0,id:"p",type:"put" as const,strike:105,bid:0.85,ask:0.9,delta:-0.5};
 const near={...c0,id:"near",strike:106,bid:0.5,ask:0.55,delta:0.45};                // reach = 105 × (1 + 1.75/105) = 106.75 ≥ 106
 base.contracts=[{...c0,iv:0.9},{...put,iv:0.9},{...near,iv:0.9}];
 const kinds=(r:OptionsResearch)=>screenResearchContracts(r,100,500,now).map(x=>x.kind);
 assert.deepEqual(kinds(base),["call_debit","long_call","long_call"]);                // both calls qualify as singles; the 105/106 spread leads
 const inside=structuredClone(base); inside.events!.TEST.exDivAt="2026-10-02";
 assert.deepEqual(kinds(inside),["long_call","long_call"]);                           // the spread is gone, both singles stay
 const outside=structuredClone(base); outside.events!.TEST.exDivAt="2026-10-20";
 assert.deepEqual(kinds(outside),["call_debit","long_call","long_call"]);             // ex-date after expiry: no hold spans it
 const unread=structuredClone(base); delete unread.events!.TEST.exDivAt;
 assert.deepEqual(kinds(unread),["long_call","long_call"]);                           // fundamentals never read → spreads refused
 assert.equal(screenResearchContracts(inside,100,500,now)[0].exDivAt,"2026-10-02");
 assert.equal(exDivRisk("call_debit",106,"call",105,1.67,"2026-10-02","2026-10-16",now).permitted,false);
 assert.equal(exDivRisk("call_debit",110,"call",105,1.67,"2026-10-02","2026-10-16",now).permitted,true);
 assert.equal(exDivRisk("call_debit",110,"call",105,null,"2026-10-02","2026-10-16",now).permitted,false);   // no expected move → cannot clear the short call
 assert.equal(exDivRisk("long_call",null,null,105,1.67,undefined,"2026-10-16",now).permitted,true);
 // Bearish twin: a 20-session breakdown with a put debit spread — the short put is not assigned for a dividend.
 const bear=research();
 bear.bars.TEST=Array.from({length:201},(_,i)=>{const c=300-i;return {day:bear.bars.TEST[i].day,open:c,high:c+1,low:i===200?97:c-1,close:i===200?98:c,volume:1000000};});
 const lp={...c0,id:"lp",type:"put" as const,strike:100,bid:0.85,ask:0.9,delta:-0.5},sp={...c0,id:"sp",type:"put" as const,strike:95,bid:0.3,ask:0.32,delta:-0.2},atmCall={...c0,id:"ac",strike:100,bid:0.85,ask:0.9};
 bear.contracts=[lp,sp,atmCall]; bear.events!.TEST.exDivAt="2026-10-02";
 assert.ok(screenResearchContracts(bear,100,500,now).map(x=>x.kind).includes("put_debit"));
});

test("nextExDiv: no dividend → null; upcoming ex-date → scheduled; past ex-date + known frequency → projected forward; past + unknown frequency → unknown",()=>{
 const today="2026-09-15";
 assert.deepEqual(nextExDiv({dividend_yield:null,dividend_per_share:null,distribution_frequency:null,payable_date:null,ex_dividend_date:null,record_date:null},today),{known:true,exDivAt:null,source:null,amount:null});
 assert.deepEqual(nextExDiv({dividend_yield:"1.1",dividend_per_share:"1.750000",distribution_frequency:"Quarterly",payable_date:"2026-10-31",ex_dividend_date:"2026-09-18",record_date:"2026-09-18"},today),{known:true,exDivAt:"2026-09-18",source:"scheduled",amount:1.75});
 assert.deepEqual(nextExDiv({dividend_yield:"4.294918",dividend_per_share:"0.150000",distribution_frequency:"Quarterly",payable_date:"2026-09-01",ex_dividend_date:"2026-08-11",record_date:"2026-08-11"},today),{known:true,exDivAt:"2026-11-10",source:"projected",amount:0.15});
 assert.equal(nextExDiv({dividend_per_share:"0.05",distribution_frequency:"Monthly",ex_dividend_date:"2026-09-01"},today).exDivAt,"2026-10-01");
 assert.equal(nextExDiv({dividend_per_share:"0.5",distribution_frequency:"Quarterly",ex_dividend_date:"2025-12-10"},today).exDivAt,"2026-12-09");   // stale: rolled forward four periods until past today
 assert.deepEqual(nextExDiv({dividend_yield:"2",dividend_per_share:"0.3",distribution_frequency:"Irregular",payable_date:null,ex_dividend_date:"2026-08-11",record_date:null},today),{known:false,exDivAt:null,source:null,amount:0.3});
 assert.equal(nextExDiv({dividend_yield:"2",ex_dividend_date:null},today).known,false);   // a payer with no ex-date at all
 assert.equal(nextExDiv({dividend_per_share:"0.05",distribution_frequency:"Monthly",ex_dividend_date:"2023-01-01"},today).known,false);   // too stale to roll forward honestly
 assert.equal(nextExDiv({ex_dividend_date:today,distribution_frequency:"Quarterly"},today).source,"scheduled");
 // A projected date is a ±7-day window for the spread rule: Nov 10 ± 7 = Nov 3..17 overlaps an Nov 6 expiry, not an Oct 30 one.
 assert.equal(exDivRisk("call_debit",106,"call",105,1.67,"2026-11-10","2026-11-06",Date.parse("2026-09-15T16:00:00Z"),"projected").permitted,false);
 assert.equal(exDivRisk("call_debit",106,"call",105,1.67,"2026-11-10","2026-10-30",Date.parse("2026-09-15T16:00:00Z"),"projected").permitted,true);
 assert.equal(exDivRisk("call_debit",106,"call",105,1.67,"2026-11-10","2026-11-06",Date.parse("2026-09-15T16:00:00Z"),"scheduled").permitted,true);   // the same date scheduled is after expiry
 assert.match(exDivRisk("call_debit",106,"call",105,1.67,"2026-11-10","2026-11-06",Date.parse("2026-09-15T16:00:00Z"),"projected").note,/projected ex-dividend 2026-11-10 \(±7d\)/);
});

test("DTE engine: 21 days is the floor (a 20-DTE contract is outside the window, 21 passes); buckets and the delta band stamp; ranking charges theta over min(10, dte−7) days and prefers the longer expiry when the drag flips the order",()=>{
 assert.equal(OPTIONS_DESK_RULES.minDte,21); assert.equal(OPTIONS_DESK_RULES.exitBeforeDte,7);
 const midnight=Date.parse("2026-09-12T00:00:00Z"), c0=research().contracts[0];
 assert.ok(contractQualityFailures({...c0,expiry:"2026-10-02",at:new Date(midnight).toISOString()},midnight).includes("Outside expiration window"));   // exactly 20 DTE
 assert.equal(contractQualityFailures({...c0,expiry:"2026-10-03",at:new Date(midnight).toISOString()},midnight).length,0);                             // exactly 21
 assert.deepEqual([dteBucketOf(21),dteBucketOf(29.9),dteBucketOf(30),dteBucketOf(44.9),dteBucketOf(45),dteBucketOf(60)],["21-30","21-30","30-45","30-45","45-60","45-60"]);
 assert.deepEqual([deltaBandOf(0.5),deltaBandOf(-0.7),deltaBandOf(0.4),deltaBandOf(0.39),deltaBandOf(0.71),deltaBandOf(null)],["prompt","prompt","prompt","outer","outer","outer"]);
 // Two expiries of the same ATM call on a $105 spot. Near (Oct 9, 26.7 DTE): straddle 2.375 → worth $146.5 at the expected move for $91;
 // far (Nov 6, 54.7 DTE): straddle 1.80 → $84 for $96. Raw payoff per dollar prefers the near one (1.61 vs 0.88); charging theta over a
 // 10-day hold (near −0.08/day = $80, far −0.01/day = $10) flips it: (146.5−80)/91 = 0.73 < (84−10)/96 = 0.77.
 const r=research(); const rv=realizedVol20(r.bars.TEST)!, iv=rv*1.1;
 const near={...c0,id:"nc",expiry:"2026-10-09",iv,theta:-0.08}, nearPut={...c0,id:"np",type:"put" as const,bid:1.45,ask:1.55,delta:-0.5,iv,theta:-0.08,expiry:"2026-10-09"};
 const far={...c0,id:"fc",expiry:"2026-11-06",bid:0.9,ask:0.95,iv,theta:-0.01}, farPut={...c0,id:"fp",type:"put" as const,bid:0.85,ask:0.9,delta:-0.5,iv,theta:-0.01,expiry:"2026-11-06"};
 r.contracts=[near,nearPut,far,farPut];
 const ranked=screenResearchContracts(r,100,500,now).filter(c=>c.kind==="long_call");
 assert.deepEqual(ranked.map(c=>c.expiry),["2026-11-06","2026-10-09"]);
 const [f,n]=ranked;
 assert.deepEqual([f.dteBucket,n.dteBucket],["45-60","21-30"]); assert.deepEqual([f.expectedHoldDays,n.expectedHoldDays],[10,10]);
 assert.deepEqual([f.thetaDragUsd,n.thetaDragUsd],[10,80]); assert.deepEqual([f.payoffAtMoveUsd,n.payoffAtMoveUsd],[84,146.5]);
 assert.equal(f.deltaBand,"prompt"); assert.equal(f.atmIv,Math.round(iv*10000)/10000);
 assert.equal(f.chase,Math.round(5/(iv/Math.sqrt(252)*100)*100)/100);   // the signal day closed 105 on a 100 prior close: +5% ÷ the implied daily move
 // Without broker theta there is no charge and no invented number: the raw order returns and thetaDragUsd is null.
 const blind=structuredClone(r); for(const x of blind.contracts)x.theta=null;
 const raw=screenResearchContracts(blind,100,500,now).filter(c=>c.kind==="long_call");
 assert.deepEqual(raw.map(c=>c.expiry),["2026-10-09","2026-11-06"]); assert.equal(raw[0].thetaDragUsd,null);
 // A short leg without theta also leaves the spread uncharged. The hold is min(10, dte−7): inside the 21–60 window that is always 10 (it would only shrink under 17 DTE, which the window refuses).
 const short={...far,id:"fs",strike:110,bid:0.28,ask:0.3,delta:0.35,theta:null};
 const spread=screenResearchContracts({...r,contracts:[far,farPut,short]},100,500,now).find(c=>c.kind==="call_debit")!;
 assert.equal(spread.thetaDragUsd,null); assert.equal(spread.deltaBand,"prompt");
 const soon=screenResearchContracts({...r,contracts:[{...near,expiry:"2026-10-06"},{...nearPut,expiry:"2026-10-06"}]},100,500,now)[0];   // 23.3 DTE → 21-30, hold 10
 assert.equal(soon.dteBucket,"21-30"); assert.equal(soon.expectedHoldDays,10);
});
