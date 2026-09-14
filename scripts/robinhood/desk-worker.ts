// THE OPTIONS DESK WORKER — the long-lived process that replaces the Mac's launchd jobs (Sep 14 2026).
// Runs on Railway (service options-desk) with the Robinhood credential on a volume. Every minute it
// asks the schedule what is due and runs it in-process: the live desk's guard/entry ticks and the
// after-close account snapshot. One tick at a time; a tick that overruns simply delays the next.
//
// OPTIONS_DESK_WORKER=off keeps the container alive but idle — the state the service deploys in,
// so the cutover from the Mac is a deliberate switch, never an accident of a deploy.
import { runLiveDesk } from "./live-desk";
import { collectAndSave, recordCollectionFailure } from "./collect";
import { tickPlan } from "../../src/lib/options-desk-schedule";
import { prisma } from "../../src/lib/db";

const log = (s: string) => console.log(`${new Date().toISOString()} worker ${s}`);
let busy = false;
let lastKey = "";

async function tick(): Promise<void> {
  if (busy) return;
  const plan = tickPlan(Date.now());
  if (plan.etMinute === lastKey) return;   // one evaluation per ET minute
  lastKey = plan.etMinute;
  if (process.env.OPTIONS_DESK_WORKER !== "on") { if (plan.guard || plan.entry || plan.collect) log(`idle (OPTIONS_DESK_WORKER!=on) — skipped ${[plan.guard && "guard", plan.entry && "entry", plan.collect && "collect"].filter(Boolean).join("+")} at ${plan.etMinute} ET`); return; }
  busy = true;
  try {
    if (plan.entry) { log(`entry tick ${plan.etMinute} ET`); await runLiveDesk("entry"); }
    else if (plan.guard) { log(`guard tick ${plan.etMinute} ET`); await runLiveDesk("guard"); }
    if (plan.collect) { log(`account snapshot ${plan.etMinute} ET`); try { await collectAndSave(); } catch { await recordCollectionFailure(); } }
  } catch (e) {
    log(`tick failed: ${String(e).slice(0, 300)}`);
  } finally { busy = false; }
}

log(`started · OPTIONS_DESK_WORKER=${process.env.OPTIONS_DESK_WORKER ?? "unset"} · auth dir ${process.env.ROBINHOOD_AUTH_DIR ?? "(default)"} · db ${process.env.DATABASE_URL_UNPOOLED ? "unpooled" : "POOLED — the account lock needs a direct connection"}`);
void tick();
setInterval(() => { void tick(); }, 20_000);
for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => { log(`${sig}: stopping after the current tick`); const wait = () => { if (busy) setTimeout(wait, 500); else prisma.$disconnect().finally(() => process.exit(0)); }; wait(); });
