import { readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { prisma } from "../src/lib/db";
import { parseRobinhoodResearchEvents, mergeResearchSnapshot, discoverySymbols } from "../src/lib/options-research-ingest";
import { OPTIONS_RESEARCH_KEY, isOptionsResearch, type OptionsResearch } from "../src/lib/options-desk-model";
import { readAccountSnapshot } from "../src/lib/options-quote-store";
import { OPTIONS_MAX_LOSS_KEY, parseOptionsMaxLoss } from "../src/lib/options-operation";
import { buildOptionsObservation } from "../src/lib/options-evidence-model";
import { saveOptionsObservation } from "../src/lib/options-evidence-store";
async function main(){
  const file=process.argv[2];if(!file)throw Error("Supply a captured broker stream JSONL file");
  const rawCapture=readFileSync(file,"utf8");
  const events=rawCapture.split("\n").filter(Boolean).map(line=>JSON.parse(line));
  // Claude stores oversized real broker responses in its dedicated tool-results folder.
  // Resolve only that exact directory and market-data filenames, never arbitrary paths.
  const roots=[join(homedir(),".claude/projects/-Users-user-trading-rh-options/"),join(homedir(),".claude/projects/"+process.cwd().replace(/[^a-zA-Z0-9]/g,"-")+"/")];
  for(const event of events)for(const block of event.message?.content??[]){
    if(block.type!=="tool_result"||typeof block.content!=="string"||!block.content.startsWith("Error: result"))continue;
    const path=block.content.match(/Output has been saved to (.+\.txt)\./)?.[1];
    const root=path?roots.find(r=>path.startsWith(r)):undefined;
    if(!path||!root||!/^[-a-f0-9]{36}\/tool-results\/mcp-robinhood-trading-(run_scan|get_equity_historicals|create_scan|get_scans)-[0-9]+\.txt$/.test(path.slice(root.length)))continue;
    if(realpathSync(path)!==path||statSync(path).size>5_000_000)continue;
    block.content=readFileSync(path,"utf8");block.is_error=false;
  }
  const next=parseRobinhoodResearchEvents(events.map(event=>JSON.stringify(event)).join("\n"),statSync(file).mtime.toISOString());
  if(process.argv.includes("--discovery-symbols")){
    console.log(discoverySymbols(next.scans).join(","));
    return;
  }
  if(!Object.keys(next.bars).length&&!next.contracts.length&&!next.scans.length)throw Error("No verified broker research in capture; previous research retained");
  const previous=await prisma.agentConfig.findUnique({where:{key:OPTIONS_RESEARCH_KEY}});
  let prior:OptionsResearch|null=null;
  try { const parsed=previous?JSON.parse(previous.value):null; if(isOptionsResearch(parsed))prior=parsed; } catch {}
  const merged=mergeResearchSnapshot(prior,next);
  if(!isOptionsResearch(merged))throw Error("Invalid combined broker research");
  const [account,risk]=await Promise.all([readAccountSnapshot(),prisma.agentConfig.findUnique({where:{key:OPTIONS_MAX_LOSS_KEY}})]);
  await saveOptionsObservation(buildOptionsObservation(next,parseOptionsMaxLoss(risk?.value),account),rawCapture);
  await prisma.agentConfig.upsert({where:{key:OPTIONS_RESEARCH_KEY},create:{key:OPTIONS_RESEARCH_KEY,value:JSON.stringify(merged)},update:{value:JSON.stringify(merged)}});
  console.log(JSON.stringify({stored:true,symbols:Object.keys(merged.bars),contracts:merged.contracts.length,scans:merged.scans.length,errors:merged.errors}));
}
main().finally(()=>prisma.$disconnect()).catch(e=>{console.error(e.message);process.exitCode=1});
