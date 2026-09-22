/**
 * ARM THE OPTIONS LIVE DESK at the ladder's current ceiling — the same thing the Arm button on
 * /options does, for when the admin page is not to hand. Spencer runs this himself; it is the one
 * step that must be a human's, because it is what lets real orders be placed at a new size.
 *
 *   railway run --service futures-engine -- sh -c 'cd /Users/user/trading-wt/retire-kraken && npx tsx scripts/arm-options.ts'
 *
 * The ceiling is READ FROM THE LADDER, never typed: Strong's rung normally, A+'s once the 0-100
 * score has been promoted. That is why raising the ladder and re-arming are two separate acts —
 * the code decides the number, the human decides whether to accept it.
 */
import { prisma } from "../src/lib/db";
import { OPTIONS_LADDER } from "../src/lib/options-risk-ladder";
import { OPTIONS_MAX_LOSS_KEY } from "../src/lib/options-operation";
import { sendNotification } from "../src/lib/notifications";

const PROMOTED_KEY = "options_score_promoted";
const DEFAULT_FEE_RESERVE_USD = 2;
const set = (key: string, value: string) => prisma.agentConfig.upsert({ where: { key }, update: { value }, create: { key, value } });

async function main() {
  const promoted = (await prisma.agentConfig.findUnique({ where: { key: PROMOTED_KEY } }))?.value === "true";
  const ceiling = promoted ? OPTIONS_LADDER["A+"].usd : OPTIONS_LADDER.Strong.usd;
  const before = (await prisma.agentConfig.findUnique({ where: { key: OPTIONS_MAX_LOSS_KEY } }))?.value ?? "unset";
  if (!(ceiling > 0) || !Number.isFinite(ceiling)) throw new Error(`refusing to arm: the ladder gave a ceiling of ${ceiling}`);

  await set(OPTIONS_MAX_LOSS_KEY, String(ceiling));
  const fee = (await prisma.agentConfig.findUnique({ where: { key: "options_live_verified_fee_reserve_usd" } }))?.value;
  if (!fee) await set("options_live_verified_fee_reserve_usd", String(DEFAULT_FEE_RESERVE_USD));
  await set("options_live_armed", "true");

  const L = OPTIONS_LADDER;
  const line = `ARMED from the command line: ceiling $${ceiling} (was $${before}); per trade by grade Normal $${L.Normal.usd} / Strong $${L.Strong.usd} / A+ ${promoted ? `$${L["A+"].usd}` : "locked"}; × drawdown tier`;
  const log = JSON.parse((await prisma.agentConfig.findUnique({ where: { key: "options_live_arm_log" } }))?.value ?? "[]") as string[];
  await set("options_live_arm_log", JSON.stringify([...log, `${new Date().toISOString()} ${line}`].slice(-50)));
  await sendNotification(`🔴 Options live desk ARMED: real money, ceiling $${ceiling} per trade including fees (was $${before}) — Normal $${L.Normal.usd} / Strong $${L.Strong.usd} / A+ ${promoted ? `$${L["A+"].usd}` : "locked"} by grade, × the drawdown tier.`, "options").catch(() => {});

  console.log(line);
  console.log(`verify: options_live_max_loss_usd = ${(await prisma.agentConfig.findUnique({ where: { key: OPTIONS_MAX_LOSS_KEY } }))?.value}`);
  await prisma.$disconnect();
}
main().catch((e) => { console.error(String(e).slice(0, 300)); process.exitCode = 1; });
