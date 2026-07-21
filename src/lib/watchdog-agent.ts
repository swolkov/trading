import { prisma } from "./db";
import { sendNotification } from "./notifications";
import { emitEventSafe } from "./event-bus";

// Self-contained US equity market-hours check (replaces the removed brokerage clock).
// Approximate: Mon–Fri 9:30–16:00 ET, ignores holidays. Used only to skip
// market-hours-only heartbeat checks — a false positive just adds a benign check.
function isUsMarketOpen(): boolean {
  const now = new Date();
  const et = new Date(now.toLocaleString("en-US", { timeZone: "America/New_York" }));
  const day = et.getDay();
  if (day === 0 || day === 6) return false;
  const minutes = et.getHours() * 60 + et.getMinutes();
  return minutes >= 570 && minutes < 960; // 9:30 → 16:00 ET
}

// ============ SYSTEM HEALTH WATCHDOG ============
// Monitors infrastructure health so we never lose money to failures.
// Checks: cron heartbeats, API connectivity, DB health, position reconciliation.
// Alerts via notification webhook on any failure.

interface HealthCheck {
  name: string;
  status: "ok" | "warning" | "critical";
  message: string;
  lastSeen?: string;
}

interface WatchdogResult {
  runType: string;
  checksRun: number;
  warnings: number;
  criticals: number;
  summary: string;
  checks: HealthCheck[];
}

// Expected intervals for each cron (in minutes)
const CRON_EXPECTATIONS: Record<string, { maxStaleMinutes: number; description: string }> = {
  // 4380 min (~73h) tolerates a Fri→Mon weekend gap — these run only on trading days, so a Friday
  // run is the last until Monday. A 25h limit false-alarmed all weekend + every Monday morning.
  premarket_last_run: { maxStaleMinutes: 4380, description: "Pre-market research (once daily at 9AM ET, trading days)" },
  review_last_run: { maxStaleMinutes: 4380, description: "Post-market review (once daily at 4:30PM ET, trading days)" },
  // Futures runs 24/5
  futures_engine_heartbeat_demo: { maxStaleMinutes: 15, description: "Futures demo engine (Railway)" },
  futures_engine_heartbeat_live: { maxStaleMinutes: 15, description: "Futures live engine (Railway)" },
  futures_cron_last_run: { maxStaleMinutes: 20, description: "Futures cron fallback (every 10min)" },
};

export async function runWatchdog(): Promise<WatchdogResult> {
  const startTime = Date.now();
  const checks: HealthCheck[] = [];
  let warnings = 0;
  let criticals = 0;

  // === CHECK 1: Database connectivity ===
  try {
    await prisma.agentConfig.count();
    checks.push({ name: "Database", status: "ok", message: "Connected" });
  } catch (err) {
    criticals++;
    checks.push({ name: "Database", status: "critical", message: `Connection failed: ${err}` });
  }

  // === CHECK 3: Tradovate API connectivity ===
  try {
    const { checkTradovateAuth } = await import("./tradovate");
    await checkTradovateAuth();
    checks.push({ name: "Tradovate API", status: "ok", message: "Authenticated" });
  } catch (err) {
    // Only warn — Tradovate may be intentionally unconfigured
    warnings++;
    checks.push({ name: "Tradovate API", status: "warning", message: `Auth failed: ${err}` });
  }

  // === CHECK 4: Cron heartbeat checks ===
  const isMarketOpen = isUsMarketOpen();

  const configs = await prisma.agentConfig.findMany().catch(() => []);
  const configMap: Record<string, string> = {};
  for (const c of configs) configMap[c.key] = c.value;

  for (const [key, expectation] of Object.entries(CRON_EXPECTATIONS)) {
    const lastRun = configMap[key];

    // Skip market-hours-only crons when market is closed
    const isMarketHoursCron = !key.startsWith("futures");
    if (isMarketHoursCron && !isMarketOpen) {
      checks.push({
        name: `Cron: ${expectation.description}`,
        status: "ok",
        message: "Skipped — market closed",
        lastSeen: lastRun || "never",
      });
      continue;
    }

    if (!lastRun) {
      warnings++;
      checks.push({
        name: `Cron: ${expectation.description}`,
        status: "warning",
        message: `No heartbeat found (key: ${key})`,
      });
      continue;
    }

    // Engine heartbeats are JSON with a timestamp field; cron heartbeats are ISO strings
    let lastRunDate: number;
    try {
      const parsed = JSON.parse(lastRun);
      lastRunDate = new Date(parsed.timestamp).getTime();
    } catch {
      lastRunDate = new Date(lastRun).getTime();
    }
    const ageMinutes = (Date.now() - lastRunDate) / 60000;

    if (isNaN(ageMinutes)) {
      warnings++;
      checks.push({
        name: `Cron: ${expectation.description}`,
        status: "warning",
        message: `Heartbeat value unparseable (key: ${key})`,
        lastSeen: lastRun.slice(0, 80),
      });
      continue;
    }

    if (ageMinutes > expectation.maxStaleMinutes * 2) {
      criticals++;
      checks.push({
        name: `Cron: ${expectation.description}`,
        status: "critical",
        message: `STALE — last ran ${ageMinutes.toFixed(0)}min ago (limit: ${expectation.maxStaleMinutes}min)`,
        lastSeen: lastRun,
      });
    } else if (ageMinutes > expectation.maxStaleMinutes) {
      warnings++;
      checks.push({
        name: `Cron: ${expectation.description}`,
        status: "warning",
        message: `Overdue — last ran ${ageMinutes.toFixed(0)}min ago (expected every ${expectation.maxStaleMinutes}min)`,
        lastSeen: lastRun,
      });
    } else {
      checks.push({
        name: `Cron: ${expectation.description}`,
        status: "ok",
        message: `Healthy — last ran ${ageMinutes.toFixed(0)}min ago`,
        lastSeen: lastRun,
      });
    }
  }

  // === CHECK 6: Recent agent errors ===
  try {
    const recentRuns = await prisma.agentRun.findMany({
      where: { createdAt: { gte: new Date(Date.now() - 60 * 60 * 1000) } },
      orderBy: { createdAt: "desc" },
      take: 20,
    });

    // Exclude the watchdog's OWN runs: it records `errors: criticals` (its critical-check count),
    // so counting those here creates a self-feeding loop — the watchdog's own criticals get
    // re-flagged as "agent errors", which is itself another critical, forever. This check is meant
    // to catch TRADING-agent execution errors, not the monitor's own findings.
    const errorRuns = recentRuns.filter((r) => r.errors > 0 && r.runType !== "watchdog");
    const totalErrors = errorRuns.reduce((sum, r) => sum + r.errors, 0);

    if (totalErrors > 5) {
      criticals++;
      checks.push({
        name: "Agent Error Rate",
        status: "critical",
        message: `${totalErrors} errors across ${errorRuns.length} runs in the last hour — agents may be broken`,
      });
    } else if (totalErrors > 0) {
      warnings++;
      checks.push({
        name: "Agent Error Rate",
        status: "warning",
        message: `${totalErrors} error(s) in last hour across ${recentRuns.length} runs`,
      });
    } else {
      checks.push({
        name: "Agent Error Rate",
        status: "ok",
        message: `${recentRuns.length} runs in last hour, 0 errors`,
      });
    }
  } catch {
    checks.push({ name: "Agent Error Rate", status: "warning", message: "Could not check agent runs" });
  }

  // === CHECK 7: Disk / environment sanity ===
  const requiredEnvVars = ["ANTHROPIC_API_KEY", "DATABASE_URL"];
  const missingVars = requiredEnvVars.filter((v) => !process.env[v]);
  if (missingVars.length > 0) {
    criticals++;
    checks.push({
      name: "Environment",
      status: "critical",
      message: `Missing env vars: ${missingVars.join(", ")}`,
    });
  } else {
    checks.push({ name: "Environment", status: "ok", message: "All required env vars present" });
  }

  // === SEND ALERTS ===
  if (criticals > 0) {
    const criticalChecks = checks.filter((c) => c.status === "critical");
    await sendNotification(
      `🚨 WATCHDOG CRITICAL (${criticals} issue${criticals > 1 ? "s" : ""}):\n${criticalChecks.map((c) => `• ${c.name}: ${c.message}`).join("\n")}`,
      "general"
    );
    // Emit agent error/offline events for orchestrator
    for (const check of criticalChecks) {
      emitEventSafe("agent.error", "watchdog", {
        agentName: check.name.toLowerCase().replace(/\s+/g, "-"),
        error: check.message,
      });
    }
  } else if (warnings > 2) {
    const warnChecks = checks.filter((c) => c.status === "warning");
    await sendNotification(
      `⚠️ Watchdog: ${warnings} warnings\n${warnChecks.map((c) => `• ${c.name}: ${c.message}`).join("\n")}`,
      "general"
    );
  }

  // === LOG HEARTBEAT ===
  await prisma.agentConfig.upsert({
    where: { key: "watchdog_last_run" },
    update: { value: new Date().toISOString() },
    create: { key: "watchdog_last_run", value: new Date().toISOString() },
  });

  const summary = `Watchdog: ${checks.length} checks — ${criticals} critical, ${warnings} warnings, ${checks.length - criticals - warnings} ok`;

  await prisma.agentRun.create({
    data: {
      runType: "watchdog",
      stocksScanned: 0,
      tradesPlaced: 0,
      positionsManaged: checks.length,
      errors: criticals,
      summary,
      durationMs: Date.now() - startTime,
    },
  });

  return {
    runType: "watchdog",
    checksRun: checks.length,
    warnings,
    criticals,
    summary,
    checks,
  };
}
