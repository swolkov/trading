#!/usr/bin/env npx tsx
// Bootstrap a Tradovate auth token and inject it into the production DB.
// Run from local machine to bypass Railway's poisoned rate limit (different IP).
//
// Usage:
//   npx tsx scripts/bootstrap-token.ts demo    # Bootstrap demo engine
//   npx tsx scripts/bootstrap-token.ts live    # Bootstrap live engine
//   npx tsx scripts/bootstrap-token.ts both    # Bootstrap both

import pg from "pg";

// ── Config ──────────────────────────────────────────────

const DEMO_URL = "https://demo.tradovateapi.com/v1";
const LIVE_URL = "https://live.tradovateapi.com/v1";

const DATABASE_URL = process.env.DATABASE_URL_UNPOOLED
  || process.env.DATABASE_URL
  || "postgresql://neondb_owner:npg_tkvK5BwNfp9D@ep-jolly-field-anjir64r.c-6.us-east-1.aws.neon.tech/neondb?sslmode=require";

// Tradovate creds — reads from env, or prompts
const USERNAME = process.env.TRADOVATE_USERNAME || "";
const PASSWORD = process.env.TRADOVATE_PASSWORD || "";
const CID = process.env.TRADOVATE_CID || "";
const SEC = process.env.TRADOVATE_SEC || "";
const APP_ID = process.env.TRADOVATE_APP_ID || "";
const APP_VERSION = process.env.TRADOVATE_APP_VERSION || "1.0";

// ── Auth ────────────────────────────────────────────────

async function authenticate(mode: "demo" | "live"): Promise<{
  token: string;
  expires: string;
  accountId: number;
  accountName: string;
}> {
  if (!USERNAME || !PASSWORD || !CID || !SEC) {
    console.error("Missing Tradovate credentials. Set env vars:");
    console.error("  TRADOVATE_USERNAME, TRADOVATE_PASSWORD, TRADOVATE_CID, TRADOVATE_SEC");
    process.exit(1);
  }

  const baseUrl = mode === "live" ? LIVE_URL : DEMO_URL;
  console.log(`[${mode}] Authenticating to ${baseUrl}...`);

  const res = await fetch(`${baseUrl}/auth/accesstokenrequest`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: USERNAME,
      password: PASSWORD,
      appId: APP_ID || "esbueno",
      appVersion: APP_VERSION,
      deviceId: `esbueno-bootstrap-${mode}`,
      cid: parseInt(CID) || 0,
      sec: SEC,
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    if (res.status === 429) {
      console.error(`[${mode}] RATE LIMITED (429). Tradovate is still angry.`);
      console.error(`[${mode}] Wait a few minutes and try again, or try from a different network.`);
    } else {
      console.error(`[${mode}] Auth failed (${res.status}): ${body}`);
    }
    throw new Error(`Auth failed: ${res.status}`);
  }

  const data = await res.json() as { accessToken: string; expirationTime: string };
  const token = data.accessToken;
  const expires = new Date(Date.now() + 23 * 60 * 60 * 1000).toISOString();

  // Get account info
  const acctRes = await fetch(`${baseUrl}/account/list`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const accounts = await acctRes.json() as { id: number; name: string; active: boolean }[];
  const active = accounts.find((a) => a.active) || accounts[0];

  console.log(`[${mode}] Authenticated as ${active?.name} (#${active?.id})`);

  return {
    token,
    expires,
    accountId: active?.id || 0,
    accountName: active?.name || "",
  };
}

// ── DB Inject ───────────────────────────────────────────

async function injectToken(mode: "demo" | "live", auth: {
  token: string;
  expires: string;
  accountId: number;
  accountName: string;
}) {
  const client = new pg.Client({ connectionString: DATABASE_URL, ssl: { rejectUnauthorized: false } });
  await client.connect();

  // Save as shared token (engine picks this up on every retry)
  const shareKey = mode === "live" ? "tradovate_live_shared_token" : "tradovate_demo_shared_token";
  const shareValue = JSON.stringify({
    token: auth.token,
    expires: auth.expires,
    accountId: auth.accountId,
    accountName: auth.accountName,
  });

  // Get next available ID
  const maxId = await client.query('SELECT COALESCE(MAX(id), 0) + 1 as next_id FROM "AgentConfig"');
  let nextId = maxId.rows[0].next_id;

  await client.query(
    `INSERT INTO "AgentConfig" (id, key, value) VALUES ($3, $1, $2)
     ON CONFLICT (key) DO UPDATE SET value = $2`,
    [shareKey, shareValue, nextId++]
  );
  console.log(`[${mode}] Saved shared token to DB (key: ${shareKey})`);

  // Also save as bootstrap token (one-time use, engine deletes after consuming)
  const bootstrapKey = mode === "live" ? "tradovate_live_bootstrap_token" : "tradovate_bootstrap_token";
  const bootstrapValue = JSON.stringify({ token: auth.token, expires: auth.expires });

  await client.query(
    `INSERT INTO "AgentConfig" (id, key, value) VALUES ($3, $1, $2)
     ON CONFLICT (key) DO UPDATE SET value = $2`,
    [bootstrapKey, bootstrapValue, nextId++]
  );
  console.log(`[${mode}] Saved bootstrap token to DB (key: ${bootstrapKey})`);

  await client.end();
}

// ── Main ────────────────────────────────────────────────

async function main() {
  const target = process.argv[2] || "demo";

  if (!["demo", "live", "both"].includes(target)) {
    console.error("Usage: npx tsx scripts/bootstrap-token.ts [demo|live|both]");
    process.exit(1);
  }

  const modes: ("demo" | "live")[] = target === "both" ? ["demo", "live"] : [target as "demo" | "live"];

  for (const mode of modes) {
    try {
      const auth = await authenticate(mode);
      await injectToken(mode, auth);
      console.log(`[${mode}] Done! Engine will pick up token within 2 minutes.`);
    } catch (err) {
      console.error(`[${mode}] Failed:`, err instanceof Error ? err.message : err);
      if (modes.length > 1) continue; // Try the other mode
      process.exit(1);
    }
  }

  console.log("\nAll done. Engines will authenticate on next DB poll cycle (<=2 min).");
}

main();
