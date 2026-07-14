import { runFuturesAgent } from "@/lib/futures-agent";
import { checkTradovateAuth } from "@/lib/tradovate";
import { reconcileFills } from "@/lib/fill-reconciliation";
import { prisma } from "@/lib/db";
import { getETHour, isWeekend as isWeekendET } from "@/lib/session-time";

export const maxDuration = 300;

// Futures agent cron — SAFETY NET for TWO Railway engines (demo + live).
// Checks both heartbeats independently. Fill reconciliation ALWAYS runs for both.

// Helper: check if a heartbeat is stale or stalled
async function checkEngine(mode: "demo" | "live"): Promise<{
  alive: boolean;
  reason: string;
  tickCount: number | null;
  mdHealth: string | null;
}> {
  const heartbeatKey = `futures_engine_heartbeat_${mode}`;
  const tickCountKey = `futures_cron_last_tick_count_${mode}`;

  const heartbeat = await prisma.agentConfig.findUnique({ where: { key: heartbeatKey } });

  if (!heartbeat?.value) {
    return { alive: false, reason: `No heartbeat found for ${mode} engine`, tickCount: null, mdHealth: null };
  }

  let lastBeat: number;
  let currentTickCount: number | null = null;
  let mdHealth: string | null = null;

  try {
    const parsed = JSON.parse(heartbeat.value);
    lastBeat = new Date(parsed.timestamp).getTime();
    currentTickCount = parsed.tickCount ?? null;
    mdHealth = parsed.mdHealth ?? null;
  } catch {
    lastBeat = new Date(heartbeat.value).getTime();
  }

  if (isNaN(lastBeat)) {
    return { alive: false, reason: `${mode} heartbeat corrupted (NaN)`, tickCount: currentTickCount, mdHealth };
  }

  const ageMinutes = (Date.now() - lastBeat) / 60000;

  if (ageMinutes >= 5) {
    console.log(`[cron/futures] ${mode} engine heartbeat stale (${ageMinutes.toFixed(0)} min). Taking over.`);
    return { alive: false, reason: `Heartbeat stale (${ageMinutes.toFixed(0)} min)`, tickCount: currentTickCount, mdHealth };
  }

  // Fresh heartbeat — check for stall (tick count unchanged)
  if (currentTickCount !== null) {
    const prevTickRecord = await prisma.agentConfig.findUnique({ where: { key: tickCountKey } });

    if (prevTickRecord?.value) {
      const prevTickCount = parseInt(prevTickRecord.value, 10);
      if (currentTickCount <= prevTickCount) {
        console.log(`[cron/futures] ${mode} engine STALLED: tickCount ${currentTickCount} unchanged. Taking over.`);
        await prisma.agentConfig.upsert({
          where: { key: tickCountKey },
          update: { value: String(currentTickCount) },
          create: { key: tickCountKey, value: String(currentTickCount) },
        });
        return { alive: false, reason: `Stalled (tickCount ${currentTickCount} unchanged)`, tickCount: currentTickCount, mdHealth };
      }
    }

    await prisma.agentConfig.upsert({
      where: { key: tickCountKey },
      update: { value: String(currentTickCount) },
      create: { key: tickCountKey, value: String(currentTickCount) },
    });
  }

  return {
    alive: true,
    reason: `Alive (heartbeat ${ageMinutes.toFixed(1)} min ago, ticks: ${currentTickCount ?? "?"}, md: ${mdHealth ?? "?"})`,
    tickCount: currentTickCount,
    mdHealth,
  };
}

export async function GET(request: Request) {
  const authHeader = request.headers.get("authorization");
  if (!process.env.CRON_SECRET || authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    // Write heartbeat so watchdog knows cron ran
    try {
      await prisma.agentConfig.upsert({
        where: { key: "futures_cron_last_run" },
        update: { value: new Date().toISOString() },
        create: { key: "futures_cron_last_run", value: new Date().toISOString() },
      });
    } catch {}

    const auth = await checkTradovateAuth();
    if (!auth.authenticated) {
      return Response.json({ status: "skipped", reason: "Tradovate not connected" });
    }

    // ALWAYS run fill reconciliation for both demo and live
    let demoReconciliation, liveReconciliation;
    try {
      // Explicit "paper": a mode-less call resolves to trading_mode_futures (= live since Jul 7),
      // which made this "demo" pass fetch LIVE fills and backfill them as futures_* rows —
      // the shadow-duplicate bug that double-counted every live trade.
      demoReconciliation = await reconcileFills("paper");
      if (demoReconciliation.backfilled > 0 || demoReconciliation.pnlCorrections > 0) {
        console.log(`[cron/futures] Demo reconciliation: ${demoReconciliation.backfilled} backfilled, ${demoReconciliation.pnlCorrections} P&L corrected`);
      }
    } catch (err) {
      console.error("[cron/futures] Demo reconciliation error:", err);
      demoReconciliation = { error: String(err) };
    }

    try {
      liveReconciliation = await reconcileFills("live");
      if (typeof liveReconciliation === "object" && "backfilled" in liveReconciliation && (liveReconciliation.backfilled > 0 || liveReconciliation.pnlCorrections > 0)) {
        console.log(`[cron/futures] Live reconciliation: ${liveReconciliation.backfilled} backfilled, ${liveReconciliation.pnlCorrections} P&L corrected`);
      }
    } catch (err) {
      console.error("[cron/futures] Live reconciliation error:", err);
      liveReconciliation = { error: String(err) };
    }

    // ALWAYS run the registry-only path — fires crypto/NR4 strategies that the realtime engine
    // doesn't know about. Safe to run alongside healthy realtime engine because registry-only
    // mode filters to symbols the realtime engine never trades (MBT/MET/BFF/MXR/MSL).
    let registryResult: { trades: unknown[]; managed: number; details: string[] } | null = null;
    try {
      registryResult = await runFuturesAgent({ registryOnly: true });
      if (registryResult && registryResult.trades.length > 0) {
        console.log(`[cron/futures] Registry strategies fired ${registryResult.trades.length} trades`);
      }
    } catch (err) {
      console.error("[cron/futures] Registry-only path error:", err);
    }

    // Check both engine heartbeats
    const demoStatus = await checkEngine("demo");
    const liveStatus = await checkEngine("live");

    // Determine if we should run the fallback agent
    const etH = getETHour();
    const isRTH = !isWeekendET() && etH >= 9.5 && etH < 16;

    let fallbackResult = null;

    if (!demoStatus.alive) {
      console.log(`[cron/futures] Demo engine down — running fallback agent`);

      // If demo engine is stale AND no shared token exists, create one so Railway can recover
      try {
        const demoToken = await prisma.agentConfig.findUnique({ where: { key: "tradovate_demo_shared_token" } });
        if (!demoToken?.value && process.env.TRADOVATE_USERNAME && process.env.TRADOVATE_PASSWORD) {
          console.log("[cron/futures] No demo shared token — refreshing for Railway recovery");
          const res = await fetch("https://demo.tradovateapi.com/v1/auth/accesstokenrequest", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              name: process.env.TRADOVATE_USERNAME,
              password: process.env.TRADOVATE_PASSWORD,
              appId: process.env.TRADOVATE_APP_ID || "esbueno",
              appVersion: process.env.TRADOVATE_APP_VERSION || "1.0",
              deviceId: "esbueno-vercel-cron-recovery",
              cid: parseInt(process.env.TRADOVATE_CID || "0"),
              sec: process.env.TRADOVATE_SEC || "",
            }),
          });
          if (res.ok) {
            const data = await res.json() as { accessToken: string };
            const acctRes = await fetch("https://demo.tradovateapi.com/v1/account/list", {
              headers: { Authorization: `Bearer ${data.accessToken}` },
            });
            const accounts = await acctRes.json() as { id: number; name: string; active: boolean }[];
            const active = accounts.find(a => a.active) || accounts[0];
            await prisma.agentConfig.upsert({
              where: { key: "tradovate_demo_shared_token" },
              update: { value: JSON.stringify({ token: data.accessToken, expires: new Date(Date.now() + 23 * 3600000).toISOString(), accountId: active?.id || 0, accountName: active?.name || "" }) },
              create: { key: "tradovate_demo_shared_token", value: JSON.stringify({ token: data.accessToken, expires: new Date(Date.now() + 23 * 3600000).toISOString(), accountId: active?.id || 0, accountName: active?.name || "" }) },
            });
            console.log(`[cron/futures] Demo token created for ${active?.name} — Railway will recover on next poll`);
          }
        }
      } catch (err) {
        console.error("[cron/futures] Demo token recovery failed:", err);
      }

      try {
        fallbackResult = await runFuturesAgent();
      } catch (err) {
        console.error("[cron/futures] Fallback agent error:", err);
        fallbackResult = { error: String(err) };
      }
    }

    // Run the live fallback whenever the live engine is down — NOT just during RTH. The live account
    // can hold a gold micro through the evening/overnight session, so if the engine dies then, an open
    // position would otherwise get NO aggregate-drawdown-kill or stop management from the cron until
    // 9:30am. runFuturesAgent ALWAYS manages/protects existing positions; new-entry scanning stays
    // internally session-gated (live only opens during RTH prime), so this can't open off-hours trades.
    if (!liveStatus.alive) {
      console.log(`[cron/futures] Live engine down (RTH=${isRTH}) — running fallback agent to protect any open position`);
      if (!fallbackResult) {
        try {
          fallbackResult = await runFuturesAgent();
        } catch (err) {
          console.error("[cron/futures] Live fallback agent error:", err);
        }
      }
    }

    // Defer only when BOTH engines are alive — if either is down we must run the fallback (above),
    // at any hour, so a dead engine never leaves an open position unprotected.
    if (demoStatus.alive && liveStatus.alive) {
      return Response.json({
        status: "deferred",
        demo: demoStatus.reason,
        live: liveStatus.reason,
        reconciliation: { demo: demoReconciliation, live: liveReconciliation },
      });
    }

    return Response.json({
      status: fallbackResult ? "fallback_ran" : "deferred",
      demo: demoStatus.reason,
      live: liveStatus.reason,
      fallback: fallbackResult,
      reconciliation: { demo: demoReconciliation, live: liveReconciliation },
    });
  } catch (error) {
    console.error("[/api/cron/futures]", error);
    try {
      const { sendNotification } = await import("@/lib/notifications");
      await sendNotification(`CRON CRASH: /api/cron/futures — ${String(error).slice(0, 200)}`, "general");
    } catch {}
    return Response.json({ error: String(error) }, { status: 500 });
  }
}
