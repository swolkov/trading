// Research uses broker prices. It never simulates fills or authorizes an order.
import { exDivRisk, spansEarnings, type EarningsClass, type ResearchEvents } from "./options-events";
import { chaseRatio, directionOfKind, marketState, marketVeto, type MarketStamp } from "./options-market-state";
import { dteOf } from "./options-live-guardian";   // ONE DTE convention (expiry at 20:00Z, the close) shared with the guardian
export const OPTIONS_RESEARCH_KEY = "options_desk_research_v1";
// The base research list, in two SLICES (Sep 15 2026) because one run cannot read it all: 28 base +
// ≤6 discovery names × 2 expiries × 5 strikes × 2 types = 680 contracts, and the broker's instrument
// reads already flaked past ~100 per run. Each slice is ≤360 contracts. The research job picks the
// slice by ET hour (10:15 and 17:45 → A; 12:15 and 15:15 → B) unless RESEARCH_SLICE says otherwise;
// the merge keeps the other slice's bars, contracts and events, so the screen always sees all 28.
//   A — the six index/mega names (the desk's regime read) + the AFFORDABLE CORE (Sep 14 2026): at a
//       $100 max loss a single contract on a $300+ stock never fits, so $11–$30 names with deep,
//       tight option markets are where the live desk can actually buy delta. 18 names × 20 = 360.
//   B — ten large caps (Sep 15 2026): at their prices only a $2.5–5-wide debit spread fits the cap;
//       the screen enforces that by price, nothing special-cases them. Discovery names (≤6 from the
//       broker scanners) ride in this slice only. (10 + 6) × 20 = 320.
// The screen still applies every quality gate; a name on this list earns nothing by being here.
// For D4's cluster map: RIOT, MARA, COIN and MSTR are one `crypto-proxy` bet, not four.
export const OPTIONS_WATCHLIST_SLICES = {
  A: ["SPY", "QQQ", "IWM", "AAPL", "AMD", "NVDA", "F", "AAL", "T", "PFE", "CCL", "NCLH", "WBD", "DKNG", "RIOT", "SOFI", "MARA", "RIVN"],
  B: ["TSLA", "MSFT", "AMZN", "META", "GOOGL", "AVGO", "NFLX", "PLTR", "COIN", "MSTR"],
} as const satisfies Record<string, readonly string[]>;
export type ResearchSlice = keyof typeof OPTIONS_WATCHLIST_SLICES;
export const OPTIONS_WATCHLIST: string[] = [...OPTIONS_WATCHLIST_SLICES.A, ...OPTIONS_WATCHLIST_SLICES.B];
export const OPTIONS_DESK_RULES = {
  maxContracts: 1, maxPositions: 1, maxEntriesPerDay: 1,
  // DTE ENGINE (Sep 15 2026): research pulls TWO expiries per name — the nearest ≥21 and the nearest
  // ≥35 days out, both ≤60 — and the ranking below charges each structure its theta over the expected
  // hold, so the longer expiry wins whenever the decay saved outweighs the extra premium. At-the-money
  // decay per day as a share of premium (the theta table the 21-day floor is set against):
  //   45 DTE ≈1.1%/day · 35 ≈1.4% · 28 ≈1.8% · 21 ≈2.4% · 14 ≈3.5% · 7 ≈7% · 0–1 DTE 36% or worse.
  // 7–14 DTE and 0–1 DTE are deliberately not offered: at $100 a contract the friction alone is
  // 15–30% a side and a flat week is the stop. Out at 7 either way.
  minDte: 21, maxDte: 60, exitBeforeDte: 7,
  // The hold the theta charge is computed over: a breakout pays inside two weeks or it does not, and the
  // position is out 7 days before expiry regardless — so min(10, dte − exitBeforeDte).
  expectedHoldDaysMax: 10,
  minOpenInterest: 500, minVolume: 100, maxSpreadPct: 10,
  // Single leg vs spread (Sep 14 2026): a long call/put is preferred only when the market is not
  // charging more than ~15% over what the stock has actually been doing (ATM implied vol ÷ 20-day
  // realized). Above that the option is rich and the spread sells the richness back.
  singleLegMaxIvToRealized: 1.15,
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
  /** Earnings and ex-dividend rows per researched symbol (Sep 15 2026). Absent on snapshots written before the calendar was collected. */
  events?: ResearchEvents;
}
export interface StrategySignal { symbol: string; direction: "bullish" | "bearish" | "neutral"; setup: string; close: number; day: string; relativeVolume: number | null; reason: string }
export interface ResearchCandidate {
  symbol: string; kind: string; expiry: string; legs: string[]; strikes: number[];
  quantity: 1; limit: number; plannedLoss: number; feeReserve: number; maxProfit: number | null;
  quoteAt: string; quoteFresh: boolean; reason: string;
  /** Market-implied move to expiry (ATM straddle ÷ spot), the yardstick every structure is ranked on. */
  expectedMovePct: number | null;
  /** P&L in dollars if the underlying settles exactly the expected move in the signal's direction. */
  payoffAtMoveUsd: number | null;
  /** ATM implied vol ÷ 20-day realized vol — ≤ singleLegMaxIvToRealized prefers a single leg. */
  ivToRealized: number | null;
  /** Earnings verdict for this expiry: "none" (permitted), never "EARNINGS TRADE"/"unknown" here — those are dropped, not ranked. */
  earningsClass: EarningsClass; earningsAt: string | null; exDivAt: string | null;
  /** Where SPY/QQQ sat on the signal day and whether this direction is aligned — a stamp; the live veto is applied by the desk. */
  market: MarketStamp & { aligned: boolean | null };
  /** ATM implied vol on this expiry (annualized decimal) — the yardstick the live chase check divides today's move by. */
  atmIv: number | null;
  /** The signal day's close-to-close move as a multiple of the implied daily move (chaseRatio). A stamp; the desk re-computes it live. */
  chase: number | null;
  /** DTE engine stamps: which expiry shelf, the hold the theta charge assumes, and the charge itself (null when a leg has no theta). */
  dteBucket: DteBucket; expectedHoldDays: number; thetaDragUsd: number | null;
  /** Strike-window slice for D7: "prompt" = the long leg's |delta| in [0.40, 0.70]; "outer" = the rest of the 0.35–0.75 window (or no delta). */
  deltaBand: "prompt" | "outer";
}
export type DteBucket = "21-30" | "30-45" | "45-60";
export const dteBucketOf = (dte: number): DteBucket => (dte < 30 ? "21-30" : dte < 45 ? "30-45" : "45-60");
export const deltaBandOf = (delta: number | null): "prompt" | "outer" => (delta != null && Math.abs(delta) >= 0.4 && Math.abs(delta) <= 0.7 ? "prompt" : "outer");
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
  const dte = dteOf(c.expiry, now);
  const mid = (c.bid + c.ask) / 2;
  if (c.multiplier !== 100) failures.push("Nonstandard contract");
  if (!(c.bid > 0 && c.ask >= c.bid && c.bidSize >= 1 && c.askSize >= 1)) failures.push("No usable two-sided market");
  if (c.openInterest < r.minOpenInterest || c.volume < r.minVolume) failures.push("Insufficient liquidity");
  if (!(mid > 0) || (c.ask - c.bid) / mid * 100 > r.maxSpreadPct) failures.push("Bid/ask spread too wide");
  if (!(dte >= r.minDte && dte <= r.maxDte)) failures.push("Outside expiration window");
  if (!Number.isFinite(Date.parse(c.at)) || Date.parse(c.at) > now) failures.push("Invalid quote timestamp");
  return failures;
}
/** 20-session close-to-close realized volatility, annualized. What implied vol is judged against. */
export function realizedVol20(bars: ResearchBar[]): number | null {
  const closes = bars.slice(-21).map(b => b.close);
  if (closes.length < 21 || closes.some(c => !(c > 0))) return null;
  const rets = closes.slice(1).map((c, i) => Math.log(c / closes[i]));
  const m = mean(rets), v = rets.reduce((a, r) => a + (r - m) ** 2, 0) / (rets.length - 1);
  return Number.isFinite(v) && v > 0 ? Math.sqrt(v * 252) : null;
}
function atmContract(cs: ResearchContract[], type: "call" | "put", expiry: string, spot: number): ResearchContract | undefined {
  return cs.filter(c => c.type === type && c.expiry === expiry).sort((a, b) => Math.abs(a.strike - spot) - Math.abs(b.strike - spot))[0];
}
/** Market-implied move to `expiry` as a fraction of spot: ATM call mid + ATM put mid, over spot. A quoted number, not a forecast. */
export function impliedMoveFrac(cs: ResearchContract[], expiry: string, spot: number): number | null {
  const call = atmContract(cs, "call", expiry, spot), put = atmContract(cs, "put", expiry, spot);
  if (!call || !put || !(spot > 0)) return null;
  const straddle = (call.bid + call.ask) / 2 + (put.bid + put.ask) / 2;
  return straddle > 0 ? straddle / spot : null;
}
/** ATM implied vol on one expiry (annualized decimal): the mean of the broker's ATM call and put IVs. */
export function atmImpliedVol(cs: ResearchContract[], expiry: string, spot: number): number | null {
  const ivs = [atmContract(cs, "call", expiry, spot), atmContract(cs, "put", expiry, spot)].map(c => c?.iv).filter((v): v is number => typeof v === "number" && v > 0);
  return ivs.length ? mean(ivs) : null;
}
/** P&L in dollars for one contract if the underlying settles at `S` at expiry, fees included. `price` is the entry debit (or credit). */
export function payoffAtUsd(kind: string, long: ResearchContract, short: ResearchContract | undefined, S: number, price: number, fee: number): number {
  const intrinsic = (c: ResearchContract) => c.type === "call" ? Math.max(0, S - c.strike) : Math.max(0, c.strike - S);
  const value = short ? intrinsic(long) - intrinsic(short) : intrinsic(long);
  return (kind.endsWith("credit") ? price + value : value - price) * 100 - fee;
}
export function screenResearchContracts(data: OptionsResearch, cap: number, buyingPower: number, now=Date.now(), opts: { vix?: number | null } = {}): ResearchCandidate[] {
  if (!Number.isFinite(cap)||cap<=0||!Number.isFinite(buyingPower)||buyingPower<=0) return [];
  const rules=OPTIONS_DESK_RULES, signals=researchSignals(data.bars,now), result: ResearchCandidate[]=[];
  const market=marketState({SPY:data.bars.SPY,QQQ:data.bars.QQQ},opts.vix??null,now), stamp:MarketStamp={spy:market.spy,qqq:market.qqq,vix:market.vix};
  const good=data.contracts.filter(c=>contractQualityFailures(c,now).length===0);
  for (const signal of signals.filter(s=>["20-session breakout","20-session breakdown"].includes(s.setup))) {
    const bull=signal.direction==="bullish", cs=good.filter(c=>c.symbol===signal.symbol);
    const rv=realizedVol20(data.bars[signal.symbol]??[]);
    const prevClose=data.bars[signal.symbol]?.at(-2)?.close, dayMovePct=prevClose!=null&&prevClose>0?(signal.close/prevClose-1)*100:null;
    const push=(kind:string,long:ResearchContract,short?:ResearchContract)=>{
      // Earnings on or before expiry (or no fresh calendar row) is an earnings trade the rule never asked for — dropped, not ranked.
      const earnings=spansEarnings(signal.symbol,long.expiry,data.events,now);
      if(!earnings.permitted)return;
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
      // The market's own yardstick: what is this worth if the stock moves exactly what the options
      // market is pricing, in the signal's direction? Worth nothing there = paying for a bigger move
      // than the market expects — a lottery ticket, and lottery tickets are the one corner of this
      // market that reliably loses. Rejected.
      const em=impliedMoveFrac(cs,long.expiry,signal.close);
      const payoff=em==null?null:Math.round(payoffAtUsd(kind,long,short,signal.close*(1+(bull?em:-em)),price,fee)*100)/100;
      if(payoff!=null&&payoff<=0)return;
      const emPct=em==null?null:Math.round(em*10000)/100;
      const exDiv=exDivRisk(kind,short?.strike??null,short?.type??null,signal.close,emPct,data.events?.[signal.symbol]?.exDivAt,long.expiry,now,data.events?.[signal.symbol]?.exDivSource);
      if(!exDiv.permitted)return;
      const iv=atmImpliedVol(cs,long.expiry,signal.close);
      const ivToRealized=iv!=null&&rv!=null?Math.round(iv/rv*100)/100:null;
      // DTE engine: the hold the theta charge assumes, and the charge — net theta (long − short, per share per day) × 100 × days.
      // A leg without a broker theta charges nothing and says so (thetaDragUsd null) rather than inventing a number.
      const dte=dteOf(long.expiry,now), expectedHoldDays=Math.max(0,Math.min(rules.expectedHoldDaysMax,dte-rules.exitBeforeDte));
      const netTheta=long.theta==null||(short&&short.theta==null)?null:long.theta-(short?.theta??0);
      const thetaDragUsd=netTheta==null?null:Math.round(-netTheta*100*expectedHoldDays*100)/100;
      // A structure the hold's decay eats whole is a lottery ticket with extra steps. Heuristic: at-expiry payoff minus a 10-day charge.
      if(thetaDragUsd!=null&&payoff!=null&&payoff-thetaDragUsd<=0)return;
      const single=!short, singlePreferred=ivToRealized!=null&&ivToRealized<=rules.singleLegMaxIvToRealized;
      const volNote=ivToRealized==null?"implied vs realized vol unavailable → spreads preferred":`implied vol ${(iv!*100).toFixed(0)}% vs realized ${(rv!*100).toFixed(0)}% (${ivToRealized}×) → ${singlePreferred?"single leg preferred":"spread preferred"}${single===singlePreferred?"":" (this is the other family)"}`;
      const moveNote=em==null?"expected move unavailable":`worth $${payoff} at the market's expected ±${(em*100).toFixed(1)}% move`;
      result.push({symbol:signal.symbol,kind,expiry:long.expiry,legs:[long.id,...(short?[short.id]:[])],strikes:[long.strike,...(short?[short.strike]:[])],quantity:1,
        limit:Math.round(price*100)/100,plannedLoss:Math.round(loss*100)/100,feeReserve:fee,maxProfit:maxProfit==null?null:Math.round(maxProfit*100)/100,
        quoteAt:at,quoteFresh:now-Date.parse(at)<=15000,expectedMovePct:emPct,payoffAtMoveUsd:payoff,ivToRealized,
        earningsClass:earnings.earningsClass,earningsAt:earnings.earningsAt,exDivAt:data.events?.[signal.symbol]?.exDivAt??null,
        market:{...stamp,aligned:marketVeto(stamp,directionOfKind(kind),signal.symbol).aligned},
        atmIv:iv==null?null:Math.round(iv*10000)/10000,chase:chaseRatio(dayMovePct,iv),dteBucket:dteBucketOf(dte),expectedHoldDays:Math.round(expectedHoldDays*100)/100,thetaDragUsd,deltaBand:deltaBandOf(long.delta),
        reason:`${signal.setup}. ${volNote}. ${moveNote}. Research only; fresh broker review and operational checks required.`});
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
  // Order: the preferred family (single leg when vol is fair, spread when it is rich) first; within it,
  // the most payoff per dollar at risk at the market's expected move AFTER the theta the expected hold
  // costs — so of two expiries the longer wins whenever the decay it saves outweighs its extra premium;
  // then the cheapest. No opinions.
  const family=(c:ResearchCandidate)=>((c.legs.length===1)===(c.ivToRealized!=null&&c.ivToRealized<=rules.singleLegMaxIvToRealized))?0:1;
  const score=(c:ResearchCandidate)=>c.payoffAtMoveUsd==null?-Infinity:(c.payoffAtMoveUsd-(c.thetaDragUsd??0))/c.plannedLoss;
  return result.sort((a,b)=>family(a)-family(b)||score(b)-score(a)||a.plannedLoss-b.plannedLoss).slice(0,24);
}

export function isOptionsResearch(value:unknown):value is OptionsResearch{
  if(!value||typeof value!=="object")return false;
  const r=value as OptionsResearch;
  return r.source==="Robinhood MCP"&&typeof r.capturedAt==="string"&&Number.isFinite(Date.parse(r.capturedAt))
    &&r.bars!==null&&typeof r.bars==="object"&&!Array.isArray(r.bars)&&Object.values(r.bars).every(bs=>Array.isArray(bs)&&bs.every(b=>b&&typeof b.day==="string"&&[b.open,b.high,b.low,b.close,b.volume].every(Number.isFinite)))
    &&Array.isArray(r.contracts)&&r.contracts.every(c=>c&&typeof c.id==="string"&&typeof c.symbol==="string"&&["call","put"].includes(c.type)&&Number.isFinite(Date.parse(c.at))&&Number.isFinite(Date.parse(c.expiry))&&[c.bid,c.ask,c.strike,c.multiplier,c.bidSize,c.askSize,c.openInterest,c.volume].every(Number.isFinite))
    &&Array.isArray(r.scans)&&r.scans.every(s=>s&&typeof s.id==="string"&&typeof s.name==="string"&&Array.isArray(s.symbols)&&s.symbols.every(x=>typeof x==="string"))
    &&Array.isArray(r.errors)&&r.errors.every(e=>typeof e==="string")
    &&(r.events===undefined||isResearchEvents(r.events));
}
const dayOrNull=(x:unknown)=>x===null||typeof x==="string"&&/^\d{4}-\d{2}-\d{2}/.test(x)&&Number.isFinite(Date.parse(x.slice(0,10)));
export function isResearchEvents(value:unknown):value is ResearchEvents{
  if(!value||typeof value!=="object"||Array.isArray(value))return false;
  return Object.values(value as Record<string,unknown>).every(e=>{
    if(!e||typeof e!=="object")return false;
    const r=e as Record<string,unknown>;
    return dayOrNull(r.earningsAt)&&(r.earningsTiming===null||r.earningsTiming==="am"||r.earningsTiming==="pm")&&typeof r.calendarThrough==="string"&&dayOrNull(r.calendarThrough)
      &&(r.exDivAt===undefined||dayOrNull(r.exDivAt))&&(r.exDivSource===undefined||r.exDivSource==="scheduled"||r.exDivSource==="projected")&&(r.dividendAmount===undefined||r.dividendAmount===null||typeof r.dividendAmount==="number"&&Number.isFinite(r.dividendAmount))
      &&typeof r.at==="string"&&Number.isFinite(Date.parse(r.at));
  });
}

/** Says WHICH gate left the live desk empty-handed, so "no trade" reads as a fact and not a mystery:
 *  no 20-session breakout among the researched names, or a breakout nothing under the cap could express. */
export function noCandidateNote(data: OptionsResearch, cap: number, now = Date.now()): string {
  const names = Object.keys(data.bars).length;
  const breaks = researchSignals(data.bars, now).filter((s) => s.setup === "20-session breakout" || s.setup === "20-session breakdown");
  if (!breaks.length) return `no entry: no 20-session breakout or breakdown among the ${names} researched names (cap $${cap})`;
  // A signal whose every researched expiry spans earnings (or has no fresh calendar row) was refused before the cap was ever consulted.
  const refused = breaks.flatMap((s) => {
    const expiries = [...new Set(data.contracts.filter((c) => c.symbol === s.symbol).map((c) => c.expiry))].sort();
    const verdicts = expiries.map((e) => spansEarnings(s.symbol, e, data.events, now));
    if (!expiries.length || verdicts.some((v) => v.permitted)) return [];
    const v = verdicts[0];
    return [`${s.symbol} ${s.direction} but ${v.earningsClass === "EARNINGS TRADE" ? `earnings ${v.earningsAt} falls before expiry ${expiries[0]}` : v.note}`];
  });
  const rest = breaks.filter((s) => !refused.some((r) => r.startsWith(`${s.symbol} `)));
  const parts = [
    ...(refused.length ? [`signal on ${refused.join("; ")} (${refused.length} refused by the earnings rule)`] : []),
    ...(rest.length ? [`signal on ${rest.map((s) => `${s.symbol} ${s.direction}`).join(", ")} but no long call/put or debit spread fits the $${cap} cap`] : []),
  ];
  return `no entry: ${parts.join("; ")}`;
}
