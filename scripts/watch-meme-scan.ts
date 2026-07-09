import { prisma } from "../src/lib/db";
async function get(k:string){return (await prisma.agentConfig.findUnique({where:{key:k}}))?.value;}
(async()=>{
  const baseline = await get("meme_scan_cron_last_run") || "";
  for(let i=0;i<20;i++){    // ~20 min at 60s
    const cur = await get("meme_scan_cron_last_run") || "";
    if(cur && cur !== baseline){
      const lr = await get("meme_scan_last_run");
      const v = lr?JSON.parse(lr):{};
      console.log(`SCAN RAN ${cur} — scanned ${v.scanned}, entered ${v.entered}`);
      for(const d of (v.details||[])) console.log("  ", d);
      const open=JSON.parse((await get("meme_live_open"))||"[]");
      console.log(`open positions: ${open.length}`);
      process.exit(0);
    }
    await new Promise(r=>setTimeout(r,60000));
  }
  console.log("no new scan within ~20m"); process.exit(2);
})().catch(e=>{console.error(e);process.exit(1)});
