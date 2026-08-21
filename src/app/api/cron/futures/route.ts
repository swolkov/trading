import { checkTradovateAuth } from "@/lib/tradovate";
import { reconcileFills } from "@/lib/fill-reconciliation";
import { prisma } from "@/lib/db";

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

  // A fresh heartbeat remains authoritative even when no new ticks arrived. Quiet sessions, the
  // daily maintenance break, and a temporary market-data interruption can all leave tickCount
  // unchanged. Starting the legacy manager while that process still owns its lease would create two
  // broker-mutating position managers. Record the observation, but only take over after heartbeat
  // staleness has revoked the realtime engine's mutation authority.
  let tickObservation = "";
  if (currentTickCount !== null) {
    const prevTickRecord = await prisma.agentConfig.findUnique({ where: { key: tickCountKey } });

    if (prevTickRecord?.value) {
      const prevTickCount = parseInt(prevTickRecord.value, 10);
      if (currentTickCount <= prevTickCount) {
        tickObservation = ", ticks unchanged";
        console.log(`[cron/futures] ${mode} tickCount ${currentTickCount} unchanged, but heartbeat is fresh; realtime engine retains authority.`);
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
    reason: `Alive (heartbeat ${ageMinutes.toFixed(1)} min ago, ticks: ${currentTickCount ?? "?"}${tickObservation}, md: ${mdHealth ?? "?"})`,
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

    const [demoAuth, liveAuth] = await Promise.all([
      checkTradovateAuth("paper"),
      checkTradovateAuth("live"),
    ]);
    if (!demoAuth.authenticated && !liveAuth.authenticated) {
      return Response.json({ status: "skipped", reason: "Neither Tradovate account is connected" });
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

    // Crypto registry execution is intentionally disabled. The corrected MBT study does not clear
    // the pre-committed demo-arm evidence bar, and this web cron must remain reconciliation and
    // recovery monitoring only. The Railway sidecar still collects crypto quotes for research.

    // Check both engine heartbeats
    const demoStatus = await checkEngine("demo");
    const liveStatus = await checkEngine("live");

    if (!demoStatus.alive) {
      console.log("[cron/futures] Demo engine down — recovery monitor active");

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

      // The legacy agent resolves the globally selected Tradovate account, which is live in
      // production. It must never pretend to take over demo or open differently-sized paper trades.
      // Demo keeps its broker brackets while Railway recovers from the refreshed shared token.
      console.log("[cron/futures] Demo fallback is recovery-only; no legacy demo orders will be submitted");
    }

    // Legacy order management is intentionally disabled for a stale live engine. Railway may recover
    // between this heartbeat read and any later broker request, which would create two position
    // managers without a shared fencing lease. Existing broker brackets and the realtime engine's
    // durable startup recovery remain authoritative.
    if (!liveStatus.alive) {
      console.log("[cron/futures] Live engine down — recovery monitor active; no legacy broker mutations");
    }

    // Defer only when both engines are alive. A stale engine remains recovery-only so the web cron
    // can never race Railway for broker mutation ownership.
    if (demoStatus.alive && liveStatus.alive) {
      return Response.json({
        status: "deferred",
        demo: demoStatus.reason,
        live: liveStatus.reason,
        reconciliation: { demo: demoReconciliation, live: liveReconciliation },
        cryptoRegistry: "observation_only",
      });
    }

    return Response.json({
      status: "engine_recovery_wait",
      demo: demoStatus.reason,
      live: liveStatus.reason,
      fallback: null,
      reconciliation: { demo: demoReconciliation, live: liveReconciliation },
      cryptoRegistry: "observation_only",
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
