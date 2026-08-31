import { prisma } from "@/lib/db";
import { sendNotification } from "@/lib/notifications";
import { scanUniverse, signalKey, type ScanSignal } from "@/lib/margin-scanner";

// The margin opportunity scanner — every 15 minutes (vercel.json), 24/7. Watches every
// liquid margin coin across 15m/1h/4h/daily and pushes NEW notable technical events to
// Slack + a log the cockpit reads. Awareness only: it never places an order.
export const maxDuration = 300;
export const dynamic = "force-dynamic";

const STATE_KEY = "margin_scan_state";
const TABLE_SQL = `CREATE TABLE IF NOT EXISTS margin_scan_signals (
  id serial PRIMARY KEY,
  ts timestamptz DEFAULT now(),
  coin text,
  timeframe text,
  kind text,
  detail text,
  price double precision
)`;

interface State { fired: Record<string, string> }

async function loadState(): Promise<State> {
  try {
    const row = await prisma.agentConfig.findUnique({ where: { key: STATE_KEY } });
    if (row?.value) return JSON.parse(row.value) as State;
  } catch { /* fresh */ }
  return { fired: {} };
}

async function saveState(state: State): Promise<void> {
  // Prune entries older than 3 days so the map can't grow without bound.
  const cutoff = Date.now() - 3 * 24 * 3600_000;
  for (const [k, v] of Object.entries(state.fired)) {
    if (new Date(v).getTime() < cutoff) delete state.fired[k];
  }
  const value = JSON.stringify(state);
  await prisma.agentConfig.upsert({
    where: { key: STATE_KEY },
    update: { value },
    create: { key: STATE_KEY, value },
  }).catch(() => {});
}

export async function GET(request: Request) {
  const authHeader = request.headers.get("authorization");
  if (!process.env.CRON_SECRET || authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  await prisma.agentConfig.upsert({
    where: { key: "margin_scan_last_run" },
    update: { value: new Date().toISOString() },
    create: { key: "margin_scan_last_run", value: new Date().toISOString() },
  }).catch(() => {});

  const state = await loadState();
  const { signals, errors } = await scanUniverse();

  // Keep only signals whose exact (coin, timeframe, kind) has not fired inside its
  // re-alert window — so a persistent condition pings once, not every 15 minutes.
  const fresh: ScanSignal[] = [];
  for (const s of signals) {
    const key = signalKey(s);
    const last = state.fired[key];
    if (!last || Date.now() - new Date(last).getTime() > s.realertMs) {
      fresh.push(s);
      state.fired[key] = new Date().toISOString();
    }
  }

  // Log fresh signals for the cockpit.
  if (fresh.length) {
    try {
      await prisma.$executeRawUnsafe(TABLE_SQL);
      for (const s of fresh) {
        await prisma.$executeRawUnsafe(
          `INSERT INTO margin_scan_signals (coin, timeframe, kind, detail, price) VALUES ($1,$2,$3,$4,$5)`,
          s.coin, s.timeframe, s.kind, s.detail, s.price,
        );
      }
    } catch (e) {
      errors.push(`log: ${String(e).slice(0, 80)}`);
    }
  }

  // One batched Slack message per run, not one ping per signal.
  if (fresh.length) {
    const lines = fresh
      .slice(0, 20)
      .map((s) => `• ${s.coin} ${s.timeframe}: ${s.detail} ($${s.price.toLocaleString()})`)
      .join("\n");
    const more = fresh.length > 20 ? `\n…and ${fresh.length - 20} more` : "";
    await sendNotification(`🔎 Margin scan — ${fresh.length} new signal${fresh.length > 1 ? "s" : ""}:\n${lines}${more}`, "kraken");
  }

  await saveState(state);

  if (errors.length) console.error("[/api/cron/margin-scan]", errors.slice(0, 5));
  return Response.json({ ok: errors.length === 0, scanned: signals.length, fresh: fresh.length, errors: errors.slice(0, 5) });
}
