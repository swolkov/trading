import { prisma } from "./db";

// SLACK LANES for the two desks that exist (Sep 21 2026). The Kraken/margin/stock/prop/paper lanes went with
// their desks; their AgentConfig keys may linger in the database but nothing reads them.
//   futures      — Spencer's OWN live futures trading: the morning and Sunday cards, level breaks from the
//                  chart, event heads-ups, the trade meter (one line per closed trade + replay image),
//                  the loss line and the 4:30 flatten nudge. Falls back to general — never dropped.
//   options      — the Robinhood live desk: ARM/DISARM, adapter verification, entries, closes, the brief.
//                  Real money. Falls back to general — never dropped. (Until Sep 20 2026 it had no
//                  fallback and every options page was silently lost.)
//   general      — the catch-all channel.
export type NotifyChannel = "futures" | "options" | "general";

const CHANNEL_KEYS: Record<NotifyChannel, string> = {
  futures: "webhook_futures",
  options: "webhook_options",
  general: "webhook_general",
};

async function webhookFor(key: string): Promise<string | null> {
  const row = await prisma.agentConfig.findUnique({ where: { key } });
  return row?.value || null;
}

export async function getWebhook(channel: NotifyChannel): Promise<string | null> {
  const own = await webhookFor(CHANNEL_KEYS[channel]);
  if (own) return own;
  const gen = await webhookFor("webhook_general");
  if (gen) return gen;
  return webhookFor("notification_webhook");
}

/** Which lane resolves to which webhook — for System Health, so a missing channel is visible, not silent. */
export async function laneStatus(): Promise<{ channel: NotifyChannel; own: boolean; delivers: boolean }[]> {
  const out: { channel: NotifyChannel; own: boolean; delivers: boolean }[] = [];
  for (const channel of ["futures", "options", "general"] as NotifyChannel[]) {
    const own = !!(await webhookFor(CHANNEL_KEYS[channel]));
    out.push({ channel, own, delivers: own || !!(await getWebhook(channel)) });
  }
  return out;
}

/** Slack Block Kit blocks — used for the trade meter's replay image. Optional; plain text is the default. */
export type SlackBlock = Record<string, unknown>;

export async function sendNotification(message: string, channel: NotifyChannel = "general", blocks?: SlackBlock[]) {
  try {
    const webhook = await getWebhook(channel);
    if (!webhook) return;
    // 5s timeout: a hung Slack webhook must never stall a trading path.
    const res = await fetch(webhook, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(blocks ? { text: message, blocks } : { text: message }),
      signal: AbortSignal.timeout(5000),
    });
    // A REVOKED WEBHOOK IS A SUCCESSFUL FETCH (Slack answers 404 "no_service"), so the status is checked and
    // a failure leaves a mark that System Health can show.
    if (!res.ok) await recordNotifyFailure(channel, `HTTP ${res.status}`);
    else await clearNotifyFailure(channel);
  } catch (e) {
    // Best-effort by design: a Slack outage must never break a trading path. It can, however, leave a mark.
    await recordNotifyFailure(channel, String(e).slice(0, 120));
  }
}

const NOTIFY_FAIL_KEY = "notify_last_failure";
async function recordNotifyFailure(channel: NotifyChannel, why: string): Promise<void> {
  console.error(`[notify] ${channel} delivery FAILED: ${why}`);
  try {
    const value = JSON.stringify({ at: new Date().toISOString(), channel, why });
    await prisma.agentConfig.upsert({ where: { key: NOTIFY_FAIL_KEY }, update: { value }, create: { key: NOTIFY_FAIL_KEY, value } });
  } catch { /* recording a failure may not cause one */ }
}
async function clearNotifyFailure(channel: NotifyChannel): Promise<void> {
  try {
    const row = await prisma.agentConfig.findUnique({ where: { key: NOTIFY_FAIL_KEY } });
    if (!row) return;
    const last = JSON.parse(row.value) as { channel?: string };
    if (last.channel === channel) await prisma.agentConfig.deleteMany({ where: { key: NOTIFY_FAIL_KEY } });
  } catch { /* best effort */ }
}

/**
 * One page to #general when a scheduled job throws — at most once an hour per job, so a job that keeps failing
 * every 5 minutes does not turn the general lane into a siren. System Health still shows every failure.
 */
export async function pageCronCrash(job: string, err: unknown): Promise<void> {
  const key = `cron_crash_paged_${job}`;
  try {
    const last = await prisma.agentConfig.findUnique({ where: { key } });
    if (last && Date.now() - Date.parse(last.value) < 60 * 60_000) return;
    const value = new Date().toISOString();
    await prisma.agentConfig.upsert({ where: { key }, update: { value }, create: { key, value } });
  } catch { /* the page still goes out */ }
  await sendNotification(`🚨 CRON CRASH: ${job} — ${String(err).slice(0, 200)}. Check System Health.`, "general");
}
