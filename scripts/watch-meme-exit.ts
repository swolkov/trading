import { prisma } from "../src/lib/db";
async function get(k:string){return (await prisma.agentConfig.findUnique({where:{key:k}}))?.value;}
(async()=>{
  const startClosed = JSON.parse((await get("meme_live_closed"))||"[]").length;
  for(let i=0;i<60;i++){
    const closed = JSON.parse((await get("meme_live_closed"))||"[]");
    if(closed.length>startClosed){
      const p=closed[0];
      console.log(`POSITION CLOSED: ${p.name} ${(p.realizedPct*100).toFixed(0)}% ($${(p.realizedUsd||0).toFixed(2)}) via ${p.exitReason} after ${p.holdMin}m`);
      console.log(`   sell tx: https://solscan.io/tx/${p.sellTx||"?"}`);
      process.exit(0);
    }
    // also report live unrealized each ~5 checks
    if(i%5===0){const open=JSON.parse((await get("meme_live_open"))||"[]");if(open[0])console.log(`  …holding ${open[0].name}: ${(open[0].lastPnlPct*100).toFixed(0)}% unrealized`);}
    await new Promise(r=>setTimeout(r,60000));
  }
  console.log("still holding after ~60m"); process.exit(2);
})().catch(e=>{console.error(e);process.exit(1)});
