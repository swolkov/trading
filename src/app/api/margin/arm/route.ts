import { prisma } from "@/lib/db";
import { sendNotification } from "@/lib/notifications";
import { readRoundTrip, roundTripVerdict } from "@/lib/margin-round-trip";
import { RETIRED_AUTO_SOURCES } from "@/lib/margin-auto-plans";
import { STAGE3_KEY, readStage3, loadLiveFills, divergenceSummary } from "@/lib/margin-synthesis";

// THE ARM SWITCH — the one deliberate act that lets the executor place real orders.
// Owner-only (the proxy protects everything outside /api/cron and /api/webhook). Arming
// requires the typed word "ARM", a passed plumbing test, an untripped drawdown breaker and
// no round trip in flight; it sets the limits FIRST and kraken_margin_auto LAST, and every
// arm/disarm is appended to kraken_margin_arm_log and paged to Slack. Disarming needs no
// confirmation: it only ever reduces risk (kraken_margin_auto=false; the guardian keeps
// managing whatever is open).
export const dynamic = "force-dynamic";

const ARM_LOG = "kraken_margin_arm_log";
const DEFAULT_SOURCE = "selective";
// THE ONE SIZING RULE, shared by paper and live: base 3% of equity at risk per trade,
// scaled by conviction — high 2× (6%, the ceiling), medium 1×, low 0.5×. Paper's scoreboard
// ("at live sizing") is computed with exactly this rule, so live follows paper trade for
// trade. The live candidate only takes high-conviction setups, so its live trades are 6%;
// on a ~$5k account that is twice the account in size, and the executor fits the order to
// free margin (MARGIN_HEADROOM) instead of being rejected — realised risk a little under 6%
// until the 3× leverage rung at $10k. The daily loss cap is set to about two full losses.
const BASE_RISK_PCT = 3;
// Spencer's decision (Sep 6): the first 20 live trades run at HALF of paper's base (3% per
// high-conviction trade instead of 6%), then graduate automatically if live matches paper.
const STAGE3_TARGET = 20;
const START_BASE_PCT = BASE_RISK_PCT / 2;

async function setKey(key: string, value: string | null): Promise<void> {
  if (value == null) { await prisma.agentConfig.deleteMany({ where: { key } }); return; }
  await prisma.agentConfig.upsert({ where: { key }, update: { value }, create: { key, value } });
}
async function appendLog(line: string): Promise<void> {
  const row = await prisma.agentConfig.findUnique({ where: { key: ARM_LOG } }).catch(() => null);
  let list: string[] = [];
  try { list = row?.value ? (JSON.parse(row.value) as string[]) : []; } catch { list = []; }
  list.push(`${new Date().toISOString()} ${line}`);
  await setKey(ARM_LOG, JSON.stringify(list.slice(-50)));
}

async function status() {
  const keys = ["kraken_margin_auto", "kraken_margin_validate_only", "kraken_margin_live_sources", "kraken_margin_max_positions", "kraken_margin_max_trades_per_day", "kraken_margin_maker_entries", "kraken_margin_symbols", "kraken_margin_disarmed_dd", "kraken_margin_live_max_risk_pct", ARM_LOG];
  const rows = await prisma.agentConfig.findMany({ where: { key: { in: keys } } });
  const c: Record<string, string> = {};
  for (const r of rows) c[r.key] = r.value;
  const rt = await readRoundTrip();
  const rtPassed = rt?.stage === "done" && roundTripVerdict(rt.checks).allOk;
  const stage3 = await readStage3().catch(() => null);
  let stage3Done: number | null = null;
  if (stage3) { try { stage3Done = divergenceSummary(await loadLiveFills()).closed; } catch { stage3Done = stage3.done ?? null; } }
  let log: string[] = [];
  try { log = c[ARM_LOG] ? (JSON.parse(c[ARM_LOG]) as string[]) : []; } catch { log = []; }
  return {
    armed: c.kraken_margin_auto === "true" && c.kraken_margin_validate_only === "false",
    auto: c.kraken_margin_auto === "true",
    validateOnly: c.kraken_margin_validate_only !== "false",
    sources: (c.kraken_margin_live_sources ?? "").split(",").map((s) => s.trim()).filter(Boolean),
    maxPositions: parseInt(c.kraken_margin_max_positions ?? "3", 10) || 3,
    maxTradesPerDay: parseInt(c.kraken_margin_max_trades_per_day ?? "6", 10) || 6,
    marketEntries: c.kraken_margin_maker_entries === "false",
    symbols: c.kraken_margin_symbols ?? null,
    riskPct: parseFloat(c.kraken_margin_live_max_risk_pct ?? "3") || 3,
    ddTripped: c.kraken_margin_disarmed_dd === "true",
    roundTripPassed: rtPassed,
    roundTripRunning: rt != null && ["entering", "open", "closing"].includes(rt.stage),
    stage3: stage3 ? { ...stage3, done: stage3Done ?? stage3.done ?? 0 } : null,
    log: log.slice(-10).reverse(),
  };
}

export async function GET() {
  return Response.json(await status());
}

export async function POST(request: Request) {
  let body: { action?: string; confirm?: string; source?: string; maxPositions?: number; maxTradesPerDay?: number } = {};
  try { body = await request.json(); } catch { /* empty */ }
  const action = String(body.action ?? "");

  if (action === "disarm") {
    await setKey("kraken_margin_auto", "false");
    await appendLog("DISARMED (kraken_margin_auto=false) from the admin page");
    await sendNotification("⚪ Kraken margin executor DISARMED from the admin page. No new entries; the guardian keeps managing anything open.", "margin_urgent").catch(() => {});
    return Response.json({ ok: true, ...(await status()) });
  }

  if (action !== "arm") return Response.json({ error: "action must be arm | disarm" }, { status: 400 });
  if (String(body.confirm ?? "") !== "ARM") return Response.json({ error: 'type ARM to confirm', ...(await status()) }, { status: 400 });
  const source = String(body.source ?? DEFAULT_SOURCE).trim().toLowerCase();
  if (!/^[a-z0-9_-]{1,32}$/.test(source) || RETIRED_AUTO_SOURCES.has(source)) return Response.json({ error: `source "${source}" cannot be armed`, ...(await status()) }, { status: 400 });
  // One position at a time to start: a 3%-risk trade with a 3% stop is notional = equity =
  // 50% of the account as margin at 2×; a second one would use the other half exactly.
  const riskPct = START_BASE_PCT * 2;         // what the candidate's (high-conviction) trades risk at the start
  const basePct = String(START_BASE_PCT);
  const maxPositions = Math.min(3, Math.max(1, Math.round(Number(body.maxPositions ?? 1)) || 1));
  const maxTradesPerDay = Math.min(6, Math.max(1, Math.round(Number(body.maxTradesPerDay ?? 3)) || 3));

  const s = await status();
  if (!s.roundTripPassed) return Response.json({ error: "the plumbing test has not passed — run the $20 round trip first", ...s }, { status: 409 });
  if (s.roundTripRunning) return Response.json({ error: "a round trip is running — wait for it", ...s }, { status: 409 });
  if (s.ddTripped) return Response.json({ error: "the drawdown breaker is tripped (kraken_margin_disarmed_dd) — clear it deliberately first", ...s }, { status: 409 });

  // Limits first, the arm flag LAST, so no instant exists where the executor is on without them.
  let equity = 0;
  try { const st = (await prisma.agentConfig.findUnique({ where: { key: "margin_watch_state" } }))?.value; const p = st ? (JSON.parse(st) as { lastEquity?: number }) : null; equity = p?.lastEquity && p.lastEquity > 0 ? p.lastEquity : 0; } catch { equity = 0; }
  const dailyCap = Math.max(200, Math.round(equity * (riskPct / 100) * 2.2));   // ≈ two full losses incl. fees
  await setKey("kraken_margin_live_max_risk_pct", basePct);
  await setKey("kraken_margin_daily_loss_cap", String(dailyCap));
  await setKey(STAGE3_KEY, JSON.stringify({ status: "running", startedAt: new Date().toISOString(), target: STAGE3_TARGET, fromBase: START_BASE_PCT, toBase: BASE_RISK_PCT, done: 0 }));
  await setKey("kraken_margin_maker_entries", "false");        // MARKET entries: mirror the paper model
  await setKey("kraken_margin_max_positions", String(maxPositions));
  await setKey("kraken_margin_max_trades_per_day", String(maxTradesPerDay));
  await setKey("kraken_margin_symbols", null);                 // whole US universe (the scanner's)
  await setKey("kraken_margin_live_sources", source);
  await setKey("kraken_margin_validate_only", "false");
  await setKey("kraken_margin_auto", "true");
  await appendLog(`ARMED source=${source} base=${basePct}% (high conviction ${riskPct}%) for the first ${STAGE3_TARGET} live trades, then base ${BASE_RISK_PCT}% (paper's full rule) if live matches paper; dailyLossCap=$${dailyCap} maxPositions=${maxPositions} maxTradesPerDay=${maxTradesPerDay} marketEntries=true from the admin page`);
  await sendNotification(`🔴 Kraken margin executor ARMED from the admin page: source ${source}. Stage 3: the first ${STAGE3_TARGET} live trades at ${riskPct}% of equity per trade (base ${basePct}%, conviction scaling on), then paper's full rule (${BASE_RISK_PCT * 2}% on high conviction) automatically if real fills match paper. Daily loss cap $${dailyCap}, max ${maxPositions} position(s), ${maxTradesPerDay} trades/day, market entries, whole US universe. Disarm on /margin/paper or set kraken_margin_auto=false.`, "margin_live").catch(() => {});
  return Response.json({ ok: true, ...(await status()) });
}
