import { createServer } from "node:http";
import { randomBytes,createHash } from "node:crypto";
import { RESOURCE,saveCredentials,withCredentialLock,validOAuthState } from "./client";
async function connect(){
  const redirect="http://127.0.0.1:8766/callback";
  const metadata=await fetch("https://agent.robinhood.com/.well-known/oauth-authorization-server",{redirect:"error",signal:AbortSignal.timeout(15000)}).then(r=>r.json());
  if(metadata.registration_endpoint!=="https://agent.robinhood.com/oauth/trading/register"||metadata.authorization_endpoint!=="https://robinhood.com/oauth"||metadata.token_endpoint!=="https://api.robinhood.com/oauth2/token/")throw Error("OAuth endpoint mismatch");
  const response=await fetch(metadata.registration_endpoint,{method:"POST",redirect:"error",headers:{"Content-Type":"application/json"},body:JSON.stringify({client_name:"Esbueno Options Desk",redirect_uris:[redirect],grant_types:["authorization_code","refresh_token"],response_types:["code"],token_endpoint_auth_method:"none"}),signal:AbortSignal.timeout(15000)});
  if(!response.ok)throw Error(`Robinhood client registration refused (${response.status})`);
  const client=await response.json();if(typeof client.client_id!=="string")throw Error("Registration returned no client identity");
  const state=randomBytes(32).toString("base64url"),verifier=randomBytes(32).toString("base64url");
  const url=new URL(metadata.authorization_endpoint);
  url.search=new URLSearchParams({response_type:"code",client_id:client.client_id,redirect_uri:redirect,scope:"internal",state,code_challenge:createHash("sha256").update(verifier).digest("base64url"),code_challenge_method:"S256",resource:RESOURCE}).toString();
  await new Promise<void>((resolve,reject)=>{
    let used=false;
    const server=createServer(async(req,res)=>{
      let incoming:URL;try{incoming=new URL(req.url??"/",redirect);}catch{res.writeHead(400).end();return;}
      if(incoming.pathname!=="/callback"){res.writeHead(404).end();return;}
      if(used||!validOAuthState(incoming.searchParams.get("state")??"",state)){res.writeHead(400).end("Invalid authorization state");return;}
      used=true;clearTimeout(timer);
      try{
        const code=incoming.searchParams.get("code");if(!code)throw Error("Authorization not granted");
        const r=await fetch(metadata.token_endpoint,{method:"POST",redirect:"error",headers:{"Content-Type":"application/x-www-form-urlencoded"},body:new URLSearchParams({grant_type:"authorization_code",client_id:client.client_id,code,redirect_uri:redirect,code_verifier:verifier,resource:RESOURCE}),signal:AbortSignal.timeout(15000)});
        if(!r.ok)throw Error(`Token exchange refused (${r.status})`);
        const t=await r.json();if(typeof t.access_token!=="string"||typeof t.refresh_token!=="string"||!Number.isFinite(Number(t.expires_in)))throw Error("Unrecognized token response");
        await saveCredentials({clientId:client.client_id,accessToken:t.access_token,refreshToken:t.refresh_token,expiresAt:Date.now()+Number(t.expires_in)*1000});
        res.writeHead(200,{"Content-Type":"text/plain","Cache-Control":"no-store"}).end("Robinhood connected to Esbueno. Live order execution remains disabled pending verification.");
        console.log("Robinhood connection saved. No order submitted.");resolve();
      }catch(e){res.writeHead(400,{"Content-Type":"text/plain"}).end("Connection failed. No trading enabled.");reject(e);}finally{clearTimeout(timer);server.close();}
    });
    server.on("error",(e)=>{clearTimeout(timer);server.close();reject(e);});
    const timer=setTimeout(()=>{server.close();reject(Error("Authorization window expired; rerun connection setup"));},15*60*1000);
    server.listen(8766,"127.0.0.1",()=>console.log("Complete Robinhood authorization in your browser:\n"+url.toString()));
  });
}
withCredentialLock(connect).catch(e=>{console.error(e.message);process.exitCode=1});
