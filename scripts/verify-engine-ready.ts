/**
 * Post-deploy Railway engine gate.
 * Proves that the newly-started binary completed initialization and published a healthy heartbeat.
 */
import pg from "pg";
import { REALTIME_EDGES } from "../src/lib/realtime-edges";
import { FUTURES_STRATEGY_VERSION } from "../src/lib/strategy-version";

const mode = process.env.ENGINE_MODE === "demo" ? "demo" : process.env.ENGINE_MODE === "live" ? "live" : null;
if (!mode) throw new Error("ENGINE_MODE must be live or demo");

const deployStartedAt = Date.parse(process.env.DEPLOY_STARTED_AT || "");
if (!Number.isFinite(deployStartedAt)) throw new Error("DEPLOY_STARTED_AT must be an ISO timestamp");
const expectedDeploymentId = process.env.EXPECTED_DEPLOYMENT_ID;
if (!expectedDeploymentId) throw new Error("EXPECTED_DEPLOYMENT_ID is required");

const EXPECT_LIVE_ARMED = process.env.EXPECT_LIVE_ARMED === "true";
const REQUIRE_LIVE_EDGES_OFF = process.env.REQUIRE_LIVE_EDGES_OFF === "true";
const TIMEOUT_MS = 8 * 60_000;
const OBSERVE_MS = 70_000;
const POLL_MS = 5_000;
const MAX_HEARTBEAT_AGE_MS = 90_000;
const key = `futures_engine_heartbeat_${mode}`;
const databaseUrl = process.env.DATABASE_URL || process.env.POSTGRES_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required");
const client = new pg.Client({
  connectionString: databaseUrl,
  ssl: /localhost|127\.0\.0\.1/.test(databaseUrl) ? undefined : { rejectUnauthorized: false },
});

type EngineHeartbeat = {
  timestamp?: string;
  startedAt?: string;
  strategyVersion?: string;
  deploymentId?: string | null;
  ready?: boolean;
  mode?: string;
  tickCount?: number;
  liveTradingArmed?: boolean;
  riskConfigHealthy?: boolean;
  mdHealth?: string;
  equity?: number;
  sizingEquity?: number;
  registeredEdges?: number;
  enabledEdges?: string[];
};

function assertHealthy(heartbeat: EngineHeartbeat): void {
  const heartbeatAt = Date.parse(heartbeat.timestamp || "");
  const startedAt = Date.parse(heartbeat.startedAt || "");
  const age = Date.now() - heartbeatAt;
  if (heartbeat.mode !== mode) throw new Error(`mode is ${heartbeat.mode || "missing"}, expected ${mode}`);
  if (!heartbeat.ready) throw new Error("engine has not completed initialization");
  if (heartbeat.strategyVersion !== FUTURES_STRATEGY_VERSION) {
    throw new Error(`strategy version is ${heartbeat.strategyVersion || "missing"}, expected ${FUTURES_STRATEGY_VERSION}`);
  }
  if (heartbeat.deploymentId !== expectedDeploymentId) {
    throw new Error(`deployment id is ${heartbeat.deploymentId || "missing"}, expected ${expectedDeploymentId}`);
  }
  if (!Number.isFinite(heartbeatAt) || age < 0 || age >= MAX_HEARTBEAT_AGE_MS) {
    throw new Error(`heartbeat age is ${age}ms`);
  }
  if (!Number.isFinite(startedAt) || startedAt < deployStartedAt) {
    throw new Error("heartbeat belongs to the pre-deploy engine process");
  }
  if (!(Number(heartbeat.tickCount) > 0)) throw new Error("engine has not processed a market-data tick");
  if (!heartbeat.riskConfigHealthy) throw new Error("risk configuration did not load successfully");
  if (!["databento", "websocket"].includes(heartbeat.mdHealth || "")) {
    throw new Error(`market-data source is ${heartbeat.mdHealth || "missing"}`);
  }
  if (!(Number(heartbeat.equity) > 0) || !(Number(heartbeat.sizingEquity) > 0)) {
    throw new Error("broker or sizing equity is unavailable");
  }
  if (heartbeat.registeredEdges !== REALTIME_EDGES.length) {
    throw new Error(`registered edge count is ${heartbeat.registeredEdges ?? "missing"}, expected ${REALTIME_EDGES.length}`);
  }
  if (!Array.isArray(heartbeat.enabledEdges)) throw new Error("enabled edge telemetry is missing");
  if (mode === "live" && heartbeat.liveTradingArmed !== EXPECT_LIVE_ARMED) {
    throw new Error(`live arm is ${String(heartbeat.liveTradingArmed)}, expected ${EXPECT_LIVE_ARMED}`);
  }
  if (mode === "live" && REQUIRE_LIVE_EDGES_OFF && heartbeat.enabledEdges.length > 0) {
    throw new Error(`live edges unexpectedly enabled: ${heartbeat.enabledEdges.join(", ")}`);
  }
}

async function readHeartbeat(): Promise<EngineHeartbeat> {
  const result = await client.query<{ value: string }>(
    `SELECT value FROM "AgentConfig" WHERE key = $1 LIMIT 1`,
    [key],
  );
  if (!result.rows[0]?.value) throw new Error(`${key} is missing`);
  return JSON.parse(result.rows[0].value) as EngineHeartbeat;
}

async function main(): Promise<void> {
  await client.connect();
  const deadline = Date.now() + TIMEOUT_MS;
  let healthySince = 0;
  let observationTickCount = 0;
  let observationHeartbeatAt = 0;
  let observationProcess = "";
  let lastError = "waiting for first heartbeat";
  while (Date.now() < deadline) {
    try {
      const heartbeat = await readHeartbeat();
      assertHealthy(heartbeat);
      const heartbeatProcess = `${heartbeat.deploymentId}:${heartbeat.startedAt}`;
      if (!healthySince || heartbeatProcess !== observationProcess) {
        healthySince = Date.now();
        observationTickCount = Number(heartbeat.tickCount);
        observationHeartbeatAt = Date.parse(heartbeat.timestamp || "");
        observationProcess = heartbeatProcess;
      }
      if (Date.now() - healthySince >= OBSERVE_MS) {
        if (Number(heartbeat.tickCount) <= observationTickCount) {
          throw new Error("market-data tick count did not advance during observation");
        }
        if (Date.parse(heartbeat.timestamp || "") <= observationHeartbeatAt) {
          throw new Error("engine heartbeat did not advance during observation");
        }
        console.log(`${mode} engine gate passed: deployment ${heartbeat.deploymentId} stayed ready on ${heartbeat.mdHealth} with strategy ${heartbeat.strategyVersion}.`);
        return;
      }
    } catch (error) {
      healthySince = 0;
      observationTickCount = 0;
      observationHeartbeatAt = 0;
      observationProcess = "";
      lastError = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
  throw new Error(`${mode} engine gate timed out: ${lastError}`);
}

main()
  .finally(() => client.end())
  .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
