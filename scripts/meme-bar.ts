// Set the Meme Lab LIVE conviction bar (how good a coin must score for the bot to buy it real money).
// Usage:  npx tsx scripts/meme-bar.ts <0-100>
//   Lower number  = trades MORE often, on WEAKER coins (faster bleed).
//   Higher number = pickier, trades rarely.
// The AI currently scores most memes ~18-28, so ~25 will start catching the least-bad ones.
// Loads the DB connection from .env.local automatically — just run it.
import * as fs from "fs";

for (const line of fs.readFileSync(".env.local", "utf8").split("\n")) {
  const m = line.match(/^\s*(DATABASE_URL|POSTGRES_URL)\s*=\s*(.+)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
}

(async () => {
  const bar = parseInt(process.argv[2], 10);
  if (!(bar >= 0 && bar <= 100)) { console.error("Usage: npx tsx scripts/meme-bar.ts <0-100>"); process.exit(1); }
  const { prisma } = await import("../src/lib/db");
  await prisma.agentConfig.upsert({
    where: { key: "meme_live_min_conviction" },
    update: { value: String(bar) },
    create: { key: "meme_live_min_conviction", value: String(bar) },
  });
  console.log(`✅ Meme Lab conviction bar set to ${bar}.`);
  console.log(`   Lower = more trades on weaker coins. The next scan (within ~10 min) applies it.`);
  console.log(`   It's LIVE, so this WILL spend real money ($20/trade) once a coin clears ${bar}.`);
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
