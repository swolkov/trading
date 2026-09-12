// Switch the ARMED live sleeve — the same writes as the arm route's "switch-source" action
// (kraken_margin_live_sources only; arm log; Slack), for when the admin page cannot be used.
// Usage: node --env-file=.env.local --import tsx scripts/switch-live-sleeve.ts swing-wide
import { PrismaClient } from "../src/generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { liveContainerFor, ARM_SOURCE_RE } from "../src/lib/margin-live-risk";
import { RETIRED_AUTO_SOURCES } from "../src/lib/margin-auto-plans";
import { readRoundTrip } from "../src/lib/margin-round-trip";
import { sendNotification } from "../src/lib/notifications";

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }) } as never);
async function get(key: string): Promise<string | null> { return (await prisma.agentConfig.findUnique({ where: { key } }))?.value ?? null; }
async function set(key: string, value: string): Promise<void> { await prisma.agentConfig.upsert({ where: { key }, update: { value }, create: { key, value } }); }

async function main() {
  const to = String(process.argv[2] ?? "").trim().toLowerCase();
  if (!ARM_SOURCE_RE.test(to) || RETIRED_AUTO_SOURCES.has(to)) throw new Error(`source "${to}" cannot be armed`);
  const c = liveContainerFor(to);
  if (!c) throw new Error(`source "${to}" has no live container`);
  const [auto, validate, srcRaw, risk, slots, perDay, rt] = await Promise.all([
    get("kraken_margin_auto"), get("kraken_margin_validate_only"), get("kraken_margin_live_sources"),
    get("kraken_margin_live_max_risk_pct"), get("kraken_margin_max_positions"), get("kraken_margin_max_trades_per_day"), readRoundTrip(),
  ]);
  if (!(auto === "true" && validate === "false")) throw new Error("not armed — arm the sleeve you want instead of switching");
  if (rt && ["entering", "open", "closing"].includes(rt.stage)) throw new Error("a round trip is running — wait for it");
  const sources = (srcRaw ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const from = sources.join(",") || "(none)";
  if (sources.length === 1 && sources[0] === to) throw new Error(`${to} is already the armed sleeve`);
  const riskPct = parseFloat(risk ?? "3") || 3;

  await set("kraken_margin_live_sources", to);
  const logRaw = await get("kraken_margin_arm_log");
  const log: string[] = logRaw ? (JSON.parse(logRaw) as string[]) : [];
  log.push(`${new Date().toISOString()} SWITCHED live sleeve ${from} → ${to} (kraken_margin_live_sources only; risk ${riskPct}% base, ${slots} slot(s), ${perDay}/day unchanged) — ${c.stopPct}% stop, ${c.trailR}R trail, ${c.maxHoldH}h hold; open positions keep the trail they were opened under — scripts/switch-live-sleeve.ts on Spencer's instruction`);
  await set("kraken_margin_arm_log", JSON.stringify(log.slice(-50)));
  await sendNotification(`🔁 Kraken margin live sleeve SWITCHED ${from} → ${to} (Spencer, via script). Sizing untouched (${riskPct}% base, ${riskPct * 2}% high conviction, ${slots} slot(s)). New entries: ${c.stopPct}% stop, trail ${c.trailR}R behind the peak, ${c.maxHoldH / 24}-day hold. Anything already open keeps the trail it was opened under.`, "margin_live").catch((e) => console.error("slack:", String(e)));
  console.log(`switched ${from} → ${to}; kraken_margin_live_sources now = ${await get("kraken_margin_live_sources")}`);
  await prisma.$disconnect();
}
main().catch((e) => { console.error(String(e)); process.exit(1); });
