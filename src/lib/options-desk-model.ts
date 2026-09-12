// Research uses broker prices. It never simulates fills or authorizes an order.
export const OPTIONS_RESEARCH_KEY = "options_desk_research_v1";
export const OPTIONS_WATCHLIST = ["SPY", "QQQ", "IWM", "AAPL", "AMD", "NVDA"];
export const OPTIONS_DESK_RULES = {
  maxContracts: 1, maxPositions: 1, maxEntriesPerDay: 1,
  minDte: 21, maxDte: 60, exitBeforeDte: 7,
  minOpenInterest: 500, minVolume: 100, maxSpreadPct: 10,
  feeReservePerContract: 1, // Screening allowance per contract for the round trip, not a broker fee quote.
};
export interface ResearchBar { day: string; open: number; high: number; low: number; close: number; volume: number }
export interface ResearchContract {
  id: string; symbol: string; type: "call" | "put"; strike: number; expiry: string;
  multiplier: number; bid: number; ask: number; bidSize: number; askSize: number;
  at: string; delta: number | null; iv: number | null; theta: number | null;
  volume: number; openInterest: number; selloutAt: string | null;
}
export interface NativeScan { id: string; name: string; filters: unknown; symbols: string[]; resultCount: number | null; at: string | null }
export interface OptionsResearch {
  capturedAt: string; source: "Robinhood MCP"; bars: Record<string, ResearchBar[]>;
  contracts: ResearchContract[]; scans: NativeScan[]; errors: string[];
}
export interface StrategySignal { symbol: string; direction: "bullish" | "bearish" | "neutral"; setup: string; close: number; day: string; relativeVolume: number | null; reason: string }
export interface ResearchCandidate {
  symbol: string; kind: string; expiry: string; legs: string[]; strikes: number[];
  quantity: 1; limit: number; plannedLoss: number; feeReserve: number; maxProfit: number | null;
  quoteAt: string; quoteFresh: boolean; reason: string;
}
const mean = (xs: number[]) => xs.reduce((a,b)=>a+b,0)/xs.length;
export function researchSignals(bars: OptionsResearch["bars"], now=Date.now()): StrategySignal[] {
  return Object.entries(bars).flatMap(([symbol, rows]) => {
    if (rows.length < 201) return [];
    const last=rows.at(-1)!;
    if(now-Date.parse(last.day+"T21:00:00Z")>4*86400000||Date.parse(last.day)>now)return [];
    const prior=rows.slice(-21,-1);
    const sma50=mean(rows.slice(-50).map(b=>b.close)), sma200=mean(rows.slice(-200).map(b=>b.close));
    const vol=mean(prior.map(b=>b.volume)); const relativeVolume=vol>0?last.volume/vol:null;
    const bull=last.close>sma50&&sma50>sma200, bear=last.close<sma50&&sma50<sma200;
    const breakout=bull&&last.close>Math.max(...prior.map(b=>b.high));
    const breakdown=bear&&last.close<Math.min(...prior.map(b=>b.low));
    return [{symbol, direction:bull?"bullish" as const:bear?"bearish" as const:"neutral" as const,
      setup:breakout?"20-session breakout":breakdown?"20-session breakdown":bull||bear?"Trend watch":"No directional setup",
      close:last.close,day:last.day,relativeVolume,
      reason:breakout||breakdown?"Price cleared the prior 20-session range with the 50/200-day trend aligned.":"Watchlist only. A trend alone is not an entry signal."}];
  });
}
// Shared by screening and diagnostics so admin explains the actual research gates.
export function contractQualityFailures(c: ResearchContract, now = Date.now()): string[] {
  const r = OPTIONS_DESK_RULES, failures: string[] = [];
  const dte = (Date.parse(c.expiry + "T00:00:00Z") - now) / 86400000;
  const mid = (c.bid + c.ask) / 2;
  if (c.multiplier !== 100) failures.push("Nonstandard contract");
  if (!(c.bid > 0 && c.ask >= c.bid && c.bidSize >= 1 && c.askSize >= 1)) failures.push("No usable two-sided market");
  if (c.openInterest < r.minOpenInterest || c.volume < r.minVolume) failures.push("Insufficient liquidity");
  if (!(mid > 0) || (c.ask - c.bid) / mid * 100 > r.maxSpreadPct) failures.push("Bid/ask spread too wide");
  if (!(dte >= r.minDte && dte <= r.maxDte)) failures.push("Outside expiration window");
  if (!Number.isFinite(Date.parse(c.at)) || Date.parse(c.at) > now) failures.push("Invalid quote timestamp");
  return failures;
}
export function screenResearchContracts(data: OptionsResearch, cap: number, buyingPower: number, now=Date.now()): ResearchCandidate[] {
  if (!Number.isFinite(cap)||cap<=0||!Number.isFinite(buyingPower)||buyingPower<=0) return [];
  const rules=OPTIONS_DESK_RULES, signals=researchSignals(data.bars,now), result: ResearchCandidate[]=[];
  const good=data.contracts.filter(c=>contractQualityFailures(c,now).length===0);
  for (const signal of signals.filter(s=>["20-session breakout","20-session breakdown"].includes(s.setup))) {
    const bull=signal.direction==="bullish", cs=good.filter(c=>c.symbol===signal.symbol);
    const push=(kind:string,long:ResearchContract,short?:ResearchContract)=>{
      const credit=kind.endsWith("credit"), fee=rules.feeReservePerContract*(short?2:1);
      const width=short?Math.abs(long.strike-short.strike):0;
      const rawPrice=short?(credit?short.bid-long.ask:long.ask-short.bid):long.ask;
      const price=(credit?Math.floor(rawPrice*100+1e-8):Math.ceil(rawPrice*100-1e-8))/100;
      if (price<=0||(short&&price>=width))return;
      const loss=(credit?width-price:price)*100+fee;
      const maxProfit=short?(credit?price:width-price)*100-fee:long.type==="put"?(long.strike-price)*100-fee:null;
      if(loss>Math.min(cap,buyingPower)||loss<=fee||(maxProfit!=null&&maxProfit<=0))return;
      const at=short&&Date.parse(short.at)<Date.parse(long.at)?short.at:long.at;
      if(short&&Math.abs(Date.parse(short.at)-Date.parse(long.at))>15000)return;
      result.push({symbol:signal.symbol,kind,expiry:long.expiry,legs:[long.id,...(short?[short.id]:[])],strikes:[long.strike,...(short?[short.strike]:[])],quantity:1,
        limit:Math.round(price*100)/100,plannedLoss:Math.round(loss*100)/100,feeReserve:fee,maxProfit:maxProfit==null?null:Math.round(maxProfit*100)/100,
        quoteAt:at,quoteFresh:now-Date.parse(at)<=15000,reason:signal.setup+". Research only; fresh broker review and operational checks required."});
    };
    for(const long of cs){
      const delta=long.delta==null?null:Math.abs(long.delta);
      if(long.type===(bull?"call":"put")&&delta!=null&&delta>=0.35&&delta<=0.75)push(`long_${long.type}`,long);
      for(const short of cs){
        if(long.id===short.id||long.type!==short.type||long.expiry!==short.expiry)continue;
        if(long.type==="call"&&long.strike<short.strike&&bull)push("call_debit",long,short);
        if(long.type==="put"&&long.strike>short.strike&&!bull)push("put_debit",long,short);
        // Credit spreads require the short leg to be outside the money; avoid inverted directional exposure.
        if(long.type==="put"&&long.strike<short.strike&&bull&&short.strike<signal.close)push("put_credit",long,short);
        if(long.type==="call"&&long.strike>short.strike&&!bull&&short.strike>signal.close)push("call_credit",long,short);
      }
    }
  }
  return result.sort((a,b)=>a.plannedLoss-b.plannedLoss).slice(0,24);
}

export function isOptionsResearch(value:unknown):value is OptionsResearch{
  if(!value||typeof value!=="object")return false;
  const r=value as OptionsResearch;
  return r.source==="Robinhood MCP"&&typeof r.capturedAt==="string"&&Number.isFinite(Date.parse(r.capturedAt))
    &&r.bars!==null&&typeof r.bars==="object"&&!Array.isArray(r.bars)&&Object.values(r.bars).every(bs=>Array.isArray(bs)&&bs.every(b=>b&&typeof b.day==="string"&&[b.open,b.high,b.low,b.close,b.volume].every(Number.isFinite)))
    &&Array.isArray(r.contracts)&&r.contracts.every(c=>c&&typeof c.id==="string"&&typeof c.symbol==="string"&&["call","put"].includes(c.type)&&Number.isFinite(Date.parse(c.at))&&Number.isFinite(Date.parse(c.expiry))&&[c.bid,c.ask,c.strike,c.multiplier,c.bidSize,c.askSize,c.openInterest,c.volume].every(Number.isFinite))
    &&Array.isArray(r.scans)&&r.scans.every(s=>s&&typeof s.id==="string"&&typeof s.name==="string"&&Array.isArray(s.symbols)&&s.symbols.every(x=>typeof x==="string"))
    &&Array.isArray(r.errors)&&r.errors.every(e=>typeof e==="string");
}
