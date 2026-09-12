import { prisma } from "@/lib/db";
import { readAccountSnapshot } from "@/lib/options-quote-store";
import { isOptionsResearch, OPTIONS_RESEARCH_KEY, OPTIONS_DESK_RULES, OPTIONS_WATCHLIST, researchSignals, screenResearchContracts, type OptionsResearch } from "@/lib/options-desk-model";
import { OPTIONS_MAX_LOSS_KEY, parseOptionsMaxLoss } from "@/lib/options-operation";
import { loadOptionsNews, type OptionsNews } from "@/lib/options-news";
export const dynamic="force-dynamic";
// Shared five-minute news cache. Errors remain visible and are retried; no empty-success fallback.
let newsCache:{expires:number;promise:Promise<OptionsNews>}|null=null;
function news(){if(!newsCache||Date.now()>newsCache.expires)newsCache={expires:Date.now()+300000,promise:loadOptionsNews().catch(e=>{newsCache=null;throw e;})};return newsCache.promise;}
export async function GET(){
  const [rows,account,context]=await Promise.all([
    prisma.agentConfig.findMany({where:{key:{in:[OPTIONS_RESEARCH_KEY,OPTIONS_MAX_LOSS_KEY,"options_live_armed"]}}}),readAccountSnapshot(),news()]);
  const values=Object.fromEntries(rows.map(r=>[r.key,r.value]));
  let research:OptionsResearch|null=null;try{research=values[OPTIONS_RESEARCH_KEY]?JSON.parse(values[OPTIONS_RESEARCH_KEY]):null;if(!isOptionsResearch(research))research=null;}catch{}
  const watchlist=[...new Set([...OPTIONS_WATCHLIST,...Object.keys(research?.bars??{}),...(research?.contracts??[]).map(c=>c.symbol)])];
  const maxLoss=parseOptionsMaxLoss(values[OPTIONS_MAX_LOSS_KEY]);
  const blockers=["Direct broker execution is not connected and verified","Fill recovery and automatic position exits are not operational"];
  if(!context.earningsAvailable)blockers.push("Earnings calendar unavailable");
  if(!context.macroAvailable)blockers.push("Economic calendar unavailable");
  if(!research)blockers.push("Waiting for broker research collection");
  else if(!research.contracts.some(c=>Date.now()-Date.parse(c.at)<=15000&&Date.parse(c.at)<=Date.now()))blockers.push("No executable option quotes within 15 seconds");
  return Response.json({at:new Date().toISOString(),execution:{armed:values.options_live_armed==="true",canPlaceOrders:false,blockers},maxLoss,riskPct:account&&maxLoss?maxLoss/account.totalValue*100:null,rules:OPTIONS_DESK_RULES,watchlist,
    research:research?{capturedAt:research.capturedAt,source:research.source,contractCount:research.contracts.length,scans:research.scans,errors:research.errors}:null,
    signals:research?researchSignals(research.bars):[],candidates:research&&maxLoss?screenResearchContracts(research,maxLoss,account?.buyingPower??0):[],news:{...context,earnings:context.earnings.filter(e=>watchlist.includes(e.symbol))},
    strategies:[{name:"Bullish breakout",structures:"Long call or call debit spread",rule:"20-session breakout with price above the 50/200-day trend"},{name:"Bearish breakdown",structures:"Long put or put debit spread",rule:"20-session breakdown with price below the 50/200-day trend"},{name:"Defined-risk credit",structures:"Put credit in bullish trends; call credit in bearish trends",rule:"Out-of-the-money short leg with same-expiry protective leg; event and assignment review required"}],
  });
}
