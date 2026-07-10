// One-shot: write the discovered smart-money wallet list into meme_smart_wallets (prod DB),
// activating the Meme Lab smart-money signal. Wallets derived from scripts/meme-discover-wallets.ts
// (recurrence across 13 winning Solana meme coins, vetted for real active trading). Run via:
//   DOTENV_CONFIG_PATH=.env.local npx tsx -r dotenv/config scripts/meme-save-smart-wallets.ts
import { prisma } from "../src/lib/db";

const LIST = [
  "HLnpSz9h2S4hiLQ43rnSD9XkcUThA7B8hQMKmDaiTLcC",
  "FURrDAcbpHQVW3x4wzzNNKaJuQPqYN6aKHzbb211Dnzn",
  "7jUQAoDfjdqdMVSReQDc3CACWsaEjEuNz7g2VSB6FbHx",
  "A7hAgCzFw14fejgCp387JUJRMNyz4j89JKnhtKU8piqW",
  "G5UZAVbAf46s7cKWoyKu8kYTip9DGTpbLZ2qa9Aq69dP",
  "GQhp1metiEge237QfN6rLtFENiz9BW2RCV3s3KPEbWdJ",
  "FWsW1xNtWscwNmKv6wVsU1iTzRN6wmmk3MjxRP5tT7hz",
  "7hTckgnGnLQR6sdH7YkqFTAA7VwTfYFaZ6EhEsU3saCX",
  "3BpXnfJaUTiwXnJNe7Ej1rcbzqTTQUvLShZaWazebsVR",
  "62qc2CNXwrYqQScmEdiZFFAnJR262PxWEuNQtxfafNgV",
  "9rPYyANsfQZw3DnDmKE3YCQF5E8oD89UXoHn9JFEhJUz",
  "GXPFM2caqTtQYC2cJ5yJRi9VDkpsYZXzYdwYpGnLmtDL",
  "JCRGumoE9Qi5BBgULTgdgTLjSgkCMSbF62ZZfGs84JeU",
  "5eHhjP8JaYkz83CWwvGU2uMUXefd3AazWGx4gpcuEEYD",
  "5YxQFdt3Tr9zJLvkFccqXVUwhdTWJQc1fFg2YPbxvxeD",
  "2edoJDYgHag5wNFLbRweDKCdnyEVMZJTDpZwExWyrXFo",
  "5cjcW9wExnJJiqgLjq7DEG75Pm6JBgE1hNv4B2vHXUW6",
  "9M4giFFMxmFGXtc3feFzRai56WbBqehoSeRE5GK7gf7",
  "7VtfL8fvgNfhz17qKRMjzQEXgbdpnHHHQRh54R9jP2RJ",
  "EHAAiTxcdDwQ3U4bU6YcMsQGaekdzLS3B5SmYo46kJtL",
  "LRpJE9eYzs5fsj9PZXBedcUPRCXaAC8jxbhshy5xQxc",
  "AVmoTthdrX6tKt4nDjco2D775W2YK3sDhxPcMmzUAmTY",
  "FwiYAjHmzpH2twsMxTnkj4WDPrXFNYqTQMn8soTMYGGB",
];

(async () => {
  const wallets = LIST.map((s) => s.trim()).filter(Boolean);
  await prisma.agentConfig.upsert({
    where: { key: "meme_smart_wallets" },
    update: { value: wallets.join(",") },
    create: { key: "meme_smart_wallets", value: wallets.join(",") },
  });
  const back = await prisma.agentConfig.findUnique({ where: { key: "meme_smart_wallets" } });
  const readBack = (back?.value || "").split(",").filter(Boolean);
  console.log(`SAVED meme_smart_wallets: ${wallets.length} written, ${readBack.length} read back`);
  console.log(`verify: ${readBack.length === wallets.length ? "OK — smart-money signal is now LIVE" : "MISMATCH — do not trust"}`);
  process.exit(0);
})().catch((e) => { console.error("ERR:", e.message); process.exit(1); });
