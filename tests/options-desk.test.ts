import test from "node:test";
import assert from "node:assert/strict";
import { parseRobinhoodResearchEvents } from "../src/lib/options-research-ingest";
import { isOptionsResearch, screenResearchContracts, type OptionsResearch, type ResearchContract } from "../src/lib/options-desk-model";
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
 return {source:"Robinhood MCP",capturedAt:new Date(now).toISOString(),bars:{TEST:bars},contracts:[c],scans:[],errors:[]};
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
