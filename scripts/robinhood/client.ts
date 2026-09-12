// Official Robinhood MCP connection. This boundary currently permits reads only.
// Credentials stay on this Mac, outside the repository and database.
import { mkdir, readFile, writeFile, rename, open, unlink } from "node:fs/promises";
import { timingSafeEqual } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
export const RESOURCE="https://agent.robinhood.com/mcp/trading";
export const AUTH_DIR=join(homedir(),".config","esbueno-robinhood");
export const AUTH_FILE=join(AUTH_DIR,"oauth.json");
export interface Credentials {clientId:string;accessToken:string;refreshToken:string;expiresAt:number}
export async function saveCredentials(value:Credentials){
  await mkdir(AUTH_DIR,{recursive:true,mode:0o700});
  const path=join(AUTH_DIR,`oauth-${process.pid}.tmp`);
  await writeFile(path,JSON.stringify(value),{mode:0o600});await rename(path,AUTH_FILE);
}
export async function withCredentialLock<T>(fn:()=>Promise<T>):Promise<T>{
  await mkdir(AUTH_DIR,{recursive:true,mode:0o700});const path=join(AUTH_DIR,"session.lock");
  const lock=await open(path,"wx",0o600).catch(()=>{throw Error("Another Robinhood session owns the credential lock. Do not run overlapping sessions.");});
  await lock.writeFile(String(process.pid));try{return await fn();}finally{await lock.close();await unlink(path);}
}
async function accessToken(){
  let c:Credentials;try{c=JSON.parse(await readFile(AUTH_FILE,"utf8"));}catch{throw Error("Robinhood direct connection is not authorized. Run scripts/robinhood/connect.ts");}
  if(!c.clientId||!c.accessToken||!c.refreshToken||!Number.isFinite(c.expiresAt))throw Error("Invalid Robinhood credential file");
  if(c.expiresAt>Date.now()+60000)return c.accessToken;
  const r=await fetch("https://api.robinhood.com/oauth2/token/",{method:"POST",redirect:"error",headers:{"Content-Type":"application/x-www-form-urlencoded"},body:new URLSearchParams({grant_type:"refresh_token",refresh_token:c.refreshToken,client_id:c.clientId,resource:RESOURCE}),signal:AbortSignal.timeout(15000)});
  if(!r.ok)throw Error(`Robinhood refresh failed (${r.status}); reconnect required`);
  const data=await r.json();if(typeof data.access_token!=="string"||typeof data.refresh_token!=="string"||!Number.isFinite(Number(data.expires_in)))throw Error("Unrecognized token response");
  c={...c,accessToken:data.access_token,refreshToken:data.refresh_token,expiresAt:Date.now()+Number(data.expires_in)*1000};await saveCredentials(c);return c.accessToken;
}
export function parseRpcResponse(body:string,id:number):unknown{
  const events=body.trim().startsWith("{")?[JSON.parse(body)]:body.split(/\r?\n\r?\n/).flatMap(block=>{
    const data=block.split(/\r?\n/).filter(l=>l.startsWith("data:")).map(l=>l.slice(5).trimStart()).join("\n");return data?[JSON.parse(data)]:[];
  });
  const matches=events.filter(e=>e.id===id);if(matches.length!==1||matches[0].error)throw Error("Robinhood MCP returned an error or ambiguous response");return matches[0].result;
}
const READ_TOOLS=new Set(["get_accounts","get_portfolio","get_equity_positions","get_equity_orders","get_option_positions","get_option_orders","get_option_chains","get_option_instruments","get_option_quotes","get_equity_quotes","get_equity_historicals","get_earnings_results","get_earnings_calendar","get_scans","get_scanner_filter_specs","run_scan","get_realized_pnl","get_pnl_trade_history"]);
export class RobinhoodReadClient{
  private sequence=0;private session:string|null=null;private token="";
  async connect(){this.token=await accessToken();await this.rpc("initialize",{protocolVersion:"2025-06-18",capabilities:{},clientInfo:{name:"Esbueno Options Desk",version:"1.0.0"}});await this.rpc("notifications/initialized",undefined,true);}
  private async rpc(method:string,params?:unknown,notification=false):Promise<unknown>{
    const id=++this.sequence;
    const r=await fetch(RESOURCE,{method:"POST",redirect:"error",headers:{Authorization:`Bearer ${this.token}`,"Content-Type":"application/json",Accept:"application/json, text/event-stream","MCP-Protocol-Version":"2025-06-18",...(this.session?{"Mcp-Session-Id":this.session}:{})},body:JSON.stringify({jsonrpc:"2.0",...(notification?{}:{id}),method,...(params?{params}:{})}),signal:AbortSignal.timeout(25000)});
    if(!r.ok)throw Error(`Robinhood MCP HTTP ${r.status}`);
    this.session=r.headers.get("Mcp-Session-Id")??this.session;
    if(notification)return null;
    return parseRpcResponse(await r.text(),id);
  }
  async listTools(){return this.rpc("tools/list",{});}
  async call(name:string,args:Record<string,unknown>){
    if(!READ_TOOLS.has(name))throw Error("This connection is read-only; broker mutations are not installed");
    if(args.account_number&&args.account_number!=="685528705")throw Error("Wrong account");
    return this.rpc("tools/call",{name,arguments:args});
  }
}

export function validOAuthState(returned:string,expected:string):boolean{
  const a=Buffer.from(returned),b=Buffer.from(expected);
  return a.length===b.length&&timingSafeEqual(a,b);
}
