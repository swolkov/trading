import { prisma } from "./db";
import { OPTIONS_MAX_LOSS_KEY, parseOptionsMaxLoss } from "./options-operation";
import type { OptionsLivePolicy } from "./options-live-policy";
// A timestamp from the account snapshot collector is never a guardian check.
export async function readOptionsExecutionPolicy():Promise<OptionsLivePolicy>{
  const keys=[OPTIONS_MAX_LOSS_KEY,"options_live_armed","options_live_verified_fee_reserve_usd","options_live_guardian_ok_at","options_live_integration_verified"];
  const rows=await prisma.agentConfig.findMany({where:{key:{in:keys}}});const c=Object.fromEntries(rows.map(r=>[r.key,r.value]));
  const at=Date.parse(c.options_live_guardian_ok_at??"");
  return {armed:c.options_live_armed==="true"&&c.options_live_integration_verified==="true",maxLossUsd:parseOptionsMaxLoss(c[OPTIONS_MAX_LOSS_KEY]),feeBudgetUsd:parseOptionsMaxLoss(c.options_live_verified_fee_reserve_usd),guardianHealthyAtMs:Number.isFinite(at)?at:null};
}
