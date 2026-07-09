import { prisma } from "../src/lib/db";
(async()=>{
  // wait for a DEPLOYED cron run that actually enters a fresh position, then check its thesis
  for(let i=0;i<50;i++){
    const op=await prisma.agentConfig.findUnique({where:{key:"meme_paper_open"}});
    const open=op?.value?JSON.parse(op.value):[];
    const scored=open.filter((p:any)=>p.thesis);
    const realAI=open.find((p:any)=>p.thesis && !/no AI key|neutral|error/i.test(p.thesis));
    if(realAI){
      console.log("✓ DEPLOYED CRON ENTERED WITH REAL AI:");
      for(const p of open.slice(0,6))console.log(`  ${(p.name||"").slice(0,16).padEnd(16)} conv ${p.conviction} lp ${Math.round(p.lpLocked||0)}% smart ${p.smartCount} | ${(p.thesis||"").slice(0,75)}`);
      console.log("\n>>> REAL AI SCORING IN PROD: YES ✓"); process.exit(0);
    }
    if(scored.length && scored.every((p:any)=>/no AI key/i.test(p.thesis))){
      // only if these are NOT ours — but after reset any entry is from deployed cron
      console.log("⚠ deployed cron entered but thesis='no AI key' — runtime key issue:");
      for(const p of open.slice(0,4))console.log(`  ${p.name} | ${p.thesis}`);
      process.exit(3);
    }
    await new Promise(r=>setTimeout(r,30000));
  }
  console.log("timeout — no deployed entry yet"); process.exit(2);
})().catch(e=>{console.error(e);process.exit(1)});
