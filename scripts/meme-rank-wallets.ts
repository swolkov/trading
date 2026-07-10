// Rank candidate wallets by REAL realized SOL profit + win rate, using Helius Enhanced Transactions.
// Key insight: pump.fun/Meteora swaps do NOT populate events.swap OR nativeTransfers — the SOL moves as
// WRAPPED SOL inside tokenTransfers. So we reconstruct P&L from WSOL flow:
//   WSOL received by wallet = SOL out of a SELL ; WSOL sent by wallet = SOL into a BUY.
//   realized SOL = totalReceived - totalSpent  (understated for still-held bags; honest over a long window)
// Run: HELIUS_API_KEY=... npx tsx scripts/meme-rank-wallets.ts
const KEY = process.env.HELIUS_API_KEY;
const WSOL = "So11111111111111111111111111111111111111112";
const MAX_PAGES = 8;          // up to ~800 swaps/wallet
const PAGE_DELAY = 300;       // free-tier friendly

const CANDIDATES = [
  "HLnpSz9h2S4hiLQ43rnSD9XkcUThA7B8hQMKmDaiTLcC","FURrDAcbpHQVW3x4wzzNNKaJuQPqYN6aKHzbb211Dnzn",
  "7jUQAoDfjdqdMVSReQDc3CACWsaEjEuNz7g2VSB6FbHx","A7hAgCzFw14fejgCp387JUJRMNyz4j89JKnhtKU8piqW",
  "G5UZAVbAf46s7cKWoyKu8kYTip9DGTpbLZ2qa9Aq69dP","GQhp1metiEge237QfN6rLtFENiz9BW2RCV3s3KPEbWdJ",
  "FWsW1xNtWscwNmKv6wVsU1iTzRN6wmmk3MjxRP5tT7hz","7hTckgnGnLQR6sdH7YkqFTAA7VwTfYFaZ6EhEsU3saCX",
  "3BpXnfJaUTiwXnJNe7Ej1rcbzqTTQUvLShZaWazebsVR","62qc2CNXwrYqQScmEdiZFFAnJR262PxWEuNQtxfafNgV",
  "9rPYyANsfQZw3DnDmKE3YCQF5E8oD89UXoHn9JFEhJUz","GXPFM2caqTtQYC2cJ5yJRi9VDkpsYZXzYdwYpGnLmtDL",
  "JCRGumoE9Qi5BBgULTgdgTLjSgkCMSbF62ZZfGs84JeU","5eHhjP8JaYkz83CWwvGU2uMUXefd3AazWGx4gpcuEEYD",
  "5YxQFdt3Tr9zJLvkFccqXVUwhdTWJQc1fFg2YPbxvxeD","2edoJDYgHag5wNFLbRweDKCdnyEVMZJTDpZwExWyrXFo",
  "5cjcW9wExnJJiqgLjq7DEG75Pm6JBgE1hNv4B2vHXUW6","9M4giFFMxmFGXtc3feFzRai56WbBqehoSeRE5GK7gf7",
  "7VtfL8fvgNfhz17qKRMjzQEXgbdpnHHHQRh54R9jP2RJ","EHAAiTxcdDwQ3U4bU6YcMsQGaekdzLS3B5SmYo46kJtL",
  "LRpJE9eYzs5fsj9PZXBedcUPRCXaAC8jxbhshy5xQxc","AVmoTthdrX6tKt4nDjco2D775W2YK3sDhxPcMmzUAmTY",
  "FwiYAjHmzpH2twsMxTnkj4WDPrXFNYqTQMn8soTMYGGB",
];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function solUsd(): Promise<number> {
  try {
    const r = await fetch("https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd", { signal: AbortSignal.timeout(8000) });
    const d = await r.json();
    return Number(d?.solana?.usd) || 0;
  } catch { return 0; }
}

interface Prof { addr: string; realizedSol: number; deployedSol: number; trades: number; winRate: number; pages: number }

async function profile(addr: string): Promise<Prof> {
  let before: string | undefined;
  let spent = 0, recv = 0, pages = 0;
  const perToken = new Map<string, number>();
  while (pages < MAX_PAGES) {
    const url = `https://api.helius.xyz/v0/addresses/${addr}/transactions?api-key=${KEY}&type=SWAP&limit=100${before ? `&before=${before}` : ""}`;
    let txs: any[] = [];
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(25000) });
      if (r.status === 429) { await sleep(2500); continue; }
      if (!r.ok) break;
      txs = await r.json();
    } catch { break; }
    if (!Array.isArray(txs) || txs.length === 0) break;
    for (const t of txs) {
      const tt: any[] = t.tokenTransfers || [];
      let solIn = 0, solOut = 0;      // per-tx WSOL flow
      let mint = "";
      for (const x of tt) {
        if (x.mint === WSOL) {
          if (x.toUserAccount === addr) solIn += Number(x.tokenAmount) || 0;   // received SOL = a SELL
          if (x.fromUserAccount === addr) solOut += Number(x.tokenAmount) || 0; // spent SOL = a BUY
        } else if (x.mint) {
          mint = x.mint;
        }
      }
      recv += solIn; spent += solOut;
      if (mint) perToken.set(mint, (perToken.get(mint) || 0) + (solIn - solOut));
    }
    before = txs[txs.length - 1]?.signature;
    pages++;
    await sleep(PAGE_DELAY);
  }
  const toks = [...perToken.values()];
  const wins = toks.filter((v) => v > 0.01).length;
  return {
    addr, realizedSol: recv - spent, deployedSol: spent,
    trades: toks.length, winRate: toks.length ? wins / toks.length : 0, pages,
  };
}

(async () => {
  if (!KEY) { console.error("no HELIUS_API_KEY"); process.exit(1); }
  const px = await solUsd();
  console.log(`SOL/USD = $${px || "?"} | profiling ${CANDIDATES.length} wallets (up to ${MAX_PAGES} pages each)...\n`);
  const out: Prof[] = [];
  for (let i = 0; i < CANDIDATES.length; i++) {
    const p = await profile(CANDIDATES[i]);
    out.push(p);
    console.log(`[${i + 1}/${CANDIDATES.length}] ${p.addr.slice(0, 8)}  realized ${p.realizedSol.toFixed(1)} SOL${px ? ` ($${Math.round(p.realizedSol * px).toLocaleString()})` : ""}  deployed ${p.deployedSol.toFixed(0)} SOL  ${p.trades} tokens  ${(p.winRate * 100).toFixed(0)}% win  (${p.pages}p)`);
  }
  out.sort((a, b) => b.realizedSol - a.realizedSol);
  console.log("\n=== RANKED BY REALIZED SOL PROFIT ===");
  out.forEach((p, i) => console.log(`${String(i + 1).padStart(2)}. ${p.addr}  ${p.realizedSol >= 0 ? "+" : ""}${p.realizedSol.toFixed(1)} SOL${px ? ` ($${Math.round(p.realizedSol * px).toLocaleString()})` : ""}  ${(p.winRate * 100).toFixed(0)}%win  ${p.trades}tok`));
  const profitable = out.filter((p) => p.realizedSol > 0 && p.winRate >= 0.35 && p.trades >= 5);
  console.log(`\n=== PROFITABLE + DECENT WINRATE (${profitable.length}) — the vetted keep-list ===`);
  console.log(profitable.map((p) => p.addr).join(","));
  process.exit(0);
})().catch((e) => { console.error("ERR:", e.message); process.exit(1); });
