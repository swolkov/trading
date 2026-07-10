// One-shot recovery: mint a LIVE Tradovate access token and inject it into the DB bootstrap key so the
// rate-limited (429) live engine can resume WITHOUT hitting the auth endpoint. Run via:
//   railway run -s futures-engine-live -- npx tsx scripts/mint-live-token.ts
// (railway run injects the live service's TRADOVATE_* creds + DATABASE_URL — nothing secret is printed.)
import { prisma } from "../src/lib/db";

const LIVE_API = "https://live.tradovateapi.com/v1";

async function authOnce(pTicket?: string) {
  const body: Record<string, unknown> = {
    name: process.env.TRADOVATE_USERNAME || "",
    password: process.env.TRADOVATE_PASSWORD || "",
    appId: process.env.TRADOVATE_APP_ID || "",
    appVersion: process.env.TRADOVATE_APP_VERSION || "1.0",
    deviceId: "esbueno-live-engine",
    cid: parseInt(process.env.TRADOVATE_CID || "0"),
    sec: process.env.TRADOVATE_SEC || "",
  };
  if (pTicket) body["p-ticket"] = pTicket;
  const res = await fetch(`${LIVE_API}/auth/accesstokenrequest`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return res;
}

(async () => {
  if (!process.env.TRADOVATE_USERNAME || !process.env.TRADOVATE_PASSWORD) {
    console.error("❌ No TRADOVATE creds in env — run this via: railway run -s futures-engine-live -- npx tsx scripts/mint-live-token.ts");
    process.exit(1);
  }
  let res = await authOnce();
  let data = await res.json();

  // Handle Tradovate penalty response (rate limit gives p-ticket + p-time seconds to wait)
  if (res.status === 429 || data["p-ticket"]) {
    const pTime = Number(data["p-time"]) || 0;
    const captcha = !!data["p-captcha"];
    if (captcha) {
      console.error(`❌ Rate limited AND captcha required — cannot mint headlessly. Wait for the penalty to fully clear (usually ~1hr) and retry, or log into the Tradovate web/app once to clear it.`);
      process.exit(2);
    }
    const waitMs = Math.min((pTime + 2) * 1000, 130_000);
    console.log(`⏳ Rate limited — penalty ${pTime}s. Waiting ${Math.round(waitMs / 1000)}s then retrying with p-ticket...`);
    await new Promise((r) => setTimeout(r, waitMs));
    res = await authOnce(String(data["p-ticket"]));
    data = await res.json();
  }

  if (!data.accessToken) {
    console.error(`❌ Auth did not return a token (status ${res.status}). Response keys: ${Object.keys(data).join(", ")}. If still rate-limited, wait ~30-60min and retry.`);
    process.exit(3);
  }

  const token = data.accessToken as string;
  const expires = data.expirationTime || new Date(Date.now() + 23 * 3600 * 1000).toISOString();
  const payload = JSON.stringify({ token, expires });

  // Write BOTH bootstrap (consumed once, resumes a 429'd engine) and shared (reused across restarts so we
  // don't re-auth-storm) — this also prevents recurrence: future restarts reuse the shared token silently.
  for (const key of ["tradovate_live_bootstrap_token", "tradovate_live_shared_token"]) {
    await prisma.agentConfig.upsert({ where: { key }, update: { value: payload }, create: { key, value: payload } });
  }
  const mins = Math.round((new Date(expires).getTime() - Date.now()) / 60000);
  console.log(`✅ Live token minted + injected (bootstrap + shared). Valid ~${mins} min. The live engine will pick it up on its next restart (≤6 min) and resume — no auth call, no 429.`);
  process.exit(0);
})().catch((e) => { console.error("❌", e?.message || e); process.exit(1); });
