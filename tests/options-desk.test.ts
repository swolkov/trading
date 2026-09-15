import test from "node:test";
import assert from "node:assert/strict";
import { parseRobinhoodResearchEvents } from "../src/lib/options-research-ingest";
import { isOptionsResearch, noCandidateNote, screenResearchContracts, realizedVol20, impliedMoveFrac, payoffAtUsd, type OptionsResearch, type ResearchContract } from "../src/lib/options-desk-model";
import { mergeResearchSnapshot } from "../src/lib/options-research-ingest";
import { exDivRisk, spansEarnings } from "../src/lib/options-events";
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
 return {source:"Robinhood MCP",capturedAt:new Date(now).toISOString(),bars:{TEST:bars},contracts:[c],scans:[],errors:[],events:{TEST:{earningsAt:null,earningsTiming:null,exDivAt:null,dividendAmount:null,at:new Date(now).toISOString()}}};
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
 const build=(sofiFundamentals:unknown,calendarKey="results")=>[
  {message:{content:[use("h","get_equity_historicals"),use("e","get_earnings_calendar",{}),use("f","get_equity_fundamentals",{symbols:["SOFI","SPY"]})]}},
  {message:{content:[res("h",{results:[{symbol:"SOFI",interval:"day",bounds:"regular",bars},{symbol:"SPY",interval:"day",bounds:"regular",bars}]})]}},
  {message:{content:[res("e",{[calendarKey]:[{symbol:"SOFI",report:{date:"2026-10-28",timing:"pm"}},{symbol:"SOFI",report:{date:"2027-01-27",timing:"am"}},{symbol:"NOTUS",date:"2026-10-01"}]})]}},
  {message:{content:[res("f",{results:[sofiFundamentals,{symbol:"SPY",dividend:{ex_dividend_date:"2026-09-18T00:00:00Z",amount:"1.75"}}]})]}},
 ].map(l=>JSON.stringify(l)).join("\n");
 const r=parseRobinhoodResearchEvents(build({symbol:"SOFI",dividend_yield:null}),"2026-09-12T21:30:00Z");
 assert.deepEqual(r.events,{SOFI:{earningsAt:"2026-10-28",earningsTiming:"pm",exDivAt:null,dividendAmount:null,at:"2026-09-12T21:30:00Z"},SPY:{earningsAt:null,earningsTiming:null,exDivAt:"2026-09-18",dividendAmount:1.75,at:"2026-09-12T21:30:00Z"}});
 assert.equal(isOptionsResearch(r),true);
 // Fundamentals without any dividend field → the ex-dividend key stays absent (spreads refused), and the parser says so.
 const noDiv=parseRobinhoodResearchEvents(build({symbol:"SOFI",pe_ratio:"12"}),"2026-09-12T21:30:00Z");
 assert.equal("exDivAt" in noDiv.events!.SOFI,false); assert.ok(noDiv.errors.some(e=>/SOFI: fundamentals carry no dividend fields/.test(e)));
 // Calendar in an unrecognized shape → no event rows at all, an error naming the tool, and the desk refuses single names.
 const odd=parseRobinhoodResearchEvents(build({symbol:"SOFI",dividend_yield:null},"stuff"),"2026-09-12T21:30:00Z");
 assert.equal(odd.events,undefined); assert.ok(odd.errors.some(e=>/get_earnings_calendar: unrecognized shape/.test(e))); assert.ok(odd.errors.some(e=>/earnings calendar not read/.test(e)));
 // Stored snapshots written before events existed still load; a malformed row does not.
 assert.equal(isOptionsResearch({...research(),events:undefined}),true);
 assert.equal(isOptionsResearch({...research(),events:{TEST:{earningsAt:"soon",earningsTiming:null,at:"2026-09-12T21:30:00Z"}}}),false);
 // Merge carries a prior row forward with its original clock when the run lacks one; a fresh row wins.
 const prior={...research(),events:{TEST:{earningsAt:null,earningsTiming:null,exDivAt:null,dividendAmount:null,at:"2026-09-10T21:30:00Z"}}};
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
 assert.equal(spansEarnings("TEST","2026-10-16",{TEST:{earningsAt:"2026-09-01",earningsTiming:null,at:new Date(now).toISOString()}},now).permitted,true); // already reported
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
