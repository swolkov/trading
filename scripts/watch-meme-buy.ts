import { prisma } from "../src/lib/db";
async function get(k:string){return (await prisma.agentConfig.findUnique({where:{key:k}}))?.value;}
(async()=>{
  for(let i=0;i<35;i++){    // ~35 min
    const open = JSON.parse((await get("meme_live_open"))||"[]");
    if(open.length>0){
      const p=open[open.length-1];
      console.log(`✅ REAL BUY EXECUTED: ${p.name} $${p.sizeUsd} (conv ${p.conviction}) ${p.isPumpGraduate?"🎓":""}`);
      console.log(`   tx:    https://solscan.io/tx/${p.buyTx||"?"}`);
      console.log(`   token: https://solscan.io/token/${p.mint||"?"}`);
      console.log(`   thesis: ${p.thesis||""}`);
      process.exit(0);
    }
    const lr=JSON.parse((await get("meme_scan_last_run"))||"{}");
    const fail=(lr.details||[]).find((d:string)=>/BUY FAILED/.test(d));
    if(fail){ console.log(`❌ BUY FAILED (likely RPC): ${fail}`); process.exit(3); }
    await new Promise(r=>setTimeout(r,60000));
  }
  console.log("no buy or failure within ~35m — AI may still be scoring below 25"); process.exit(2);
})().catch(e=>{console.error(e);process.exit(1)});
