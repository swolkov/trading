import { prisma } from "../src/lib/db";
(async()=>{
  const start=JSON.parse((await prisma.agentConfig.findUnique({where:{key:"futures_engine_heartbeat_live"}}))?.value||"{}").tickCount||999999;
  for(let i=0;i<20;i++){
    const hb=JSON.parse((await prisma.agentConfig.findUnique({where:{key:"futures_engine_heartbeat_live"}}))?.value||"{}");
    if(hb.tickCount!=null && hb.tickCount < start-50){  // tickCount dropped = restarted with new code
      console.log(`✅ ENGINE REDEPLOYED — tickCount reset to ${hb.tickCount} (was ${start}). Overnight code is now LIVE.`);
      process.exit(0);
    }
    await new Promise(r=>setTimeout(r,60000));
  }
  console.log("engine still on old code after ~20m — Railway may not have auto-deployed; needs a manual redeploy"); process.exit(2);
})().catch(e=>{console.error(e);process.exit(1)});
