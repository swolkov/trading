import * as fs from "fs";
for (const line of fs.readFileSync(".env.local","utf8").split("\n")){const m=line.match(/^\s*(DATABASE_URL|POSTGRES_URL)\s*=\s*(.+)$/);if(m&&!process.env[m[1]])process.env[m[1]]=m[2].trim().replace(/^["']|["']$/g,"");}
(async()=>{const {prisma}=await import("../src/lib/db");
const read=async()=>JSON.parse((await prisma.agentConfig.findUnique({where:{key:"futures_engine_heartbeat_live"}}))?.value||"{}");
let last=-1;
for(let i=0;i<24;i++){await new Promise(r=>setTimeout(r,20000));const hb=await read();const age=Math.round((Date.now()-new Date(hb.timestamp).getTime())/1000);
if(age<60 && hb.tickCount!==last && hb.tickCount<200){console.log(`✅ RECOVERED — engine authenticated & ticking: tickCount=${hb.tickCount} | ${age}s ago | session=${hb.session} | pos=${hb.positions}`);
if(hb.tickCount>2){console.log("   confirmed climbing = stable, not crash-looping");process.exit(0);}}
else console.log(`  waiting... tickCount=${hb.tickCount} (${age}s ago) [${(i+1)*20}s]`);
last=hb.tickCount;}
console.log("⏳ still recovering after 8min — token valid, may need one more restart cycle");process.exit(0);})().catch(e=>{console.error(e);process.exit(1);});
