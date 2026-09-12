// News is context, never a buy/sell command. Provider failure is distinct from no events.
export interface NewsItem { headline: string; source: string; url: string; at: string }
export interface OptionsNews { at: string; available: boolean; error: string | null; headlines: NewsItem[]; earningsAvailable: boolean; macroAvailable: boolean; earnings: {symbol:string;date:string;hour:string}[]; macro: {event:string;time:string;impact:string}[] }
const object=(x:unknown):x is Record<string,unknown>=>typeof x==="object"&&x!==null&&!Array.isArray(x);
const BASE="https://finnhub.io/api/v1";
export async function loadOptionsNews(now=new Date()):Promise<OptionsNews>{
  const result:OptionsNews={at:now.toISOString(),available:false,error:null,headlines:[],earningsAvailable:false,macroAvailable:false,earnings:[],macro:[]};
  const key=process.env.FINNHUB_API_KEY;
  if(!key){result.error="News provider is not configured";return result;}
  const from=now.toISOString().slice(0,10),to=new Date(+now+14*86400000).toISOString().slice(0,10);
  const get=async(path:string)=>{const r=await fetch(BASE+path,{headers:{"X-Finnhub-Token":key},signal:AbortSignal.timeout(8000),cache:"no-store"});if(!r.ok)throw Error(`Provider HTTP ${r.status}`);return r.json();};
  const responses=await Promise.allSettled([get("/news?category=general"),get(`/calendar/earnings?from=${from}&to=${to}`),get(`/calendar/economic?from=${from}&to=${to}`)]);
  const errors:string[]=[];
  const [news,earnings,macro]=responses;
  if(news.status==="fulfilled"&&Array.isArray(news.value)&&news.value.every(x=>object(x)&&typeof x.headline==="string"&&typeof x.source==="string"&&typeof x.url==="string"&&typeof x.datetime==="number")){
    result.available=true;result.headlines=news.value.filter(x=>object(x)&&typeof x.headline==="string"&&typeof x.source==="string"&&typeof x.url==="string"&&/^https:\/\//.test(x.url)&&typeof x.datetime==="number"&&Number.isFinite(x.datetime)&&x.datetime*1000<=+now&&+now-x.datetime*1000<3*86400000).slice(0,12).map(x=>({headline:x.headline,source:x.source,url:x.url,at:new Date(x.datetime*1000).toISOString()}));
  }else errors.push("Headlines unavailable");
  if(earnings.status==="fulfilled"&&object(earnings.value)&&Array.isArray(earnings.value.earningsCalendar)){
    const rows=earnings.value.earningsCalendar;
    result.earningsAvailable=rows.every((x:Record<string,unknown>)=>object(x)&&typeof x.symbol==="string"&&typeof x.date==="string");
    if(result.earningsAvailable)result.earnings=rows.map((x:Record<string,string>)=>({symbol:x.symbol,date:x.date,hour:x.hour??"unknown"}));
  }else errors.push("Earnings calendar unavailable");
  if(macro.status==="fulfilled"&&object(macro.value)&&Array.isArray(macro.value.economicCalendar)){
    const rows=macro.value.economicCalendar;
    result.macroAvailable=rows.every((x:Record<string,unknown>)=>object(x)&&typeof x.country==="string"&&typeof x.event==="string"&&typeof x.time==="string"&&typeof x.impact==="string");
    if(result.macroAvailable)result.macro=rows.filter((x:Record<string,string>)=>x.country==="US").map((x:Record<string,string>)=>({event:x.event,time:x.time,impact:x.impact}));
  }else errors.push("Economic calendar unavailable");
  result.error=errors.length?errors.join("; "):null;return result;
}
