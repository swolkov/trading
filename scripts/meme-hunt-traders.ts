// HUNT for genuine profitable meme traders (not bots). Strategy:
//  A. Breadth — pull recent WINNING coins from GeckoTerminal (pumped + still liquid).
//  B. Seed — profile the one proven winner (HLnpSz9h, +$5k/70%), take the coins HE profited on.
//  C. Candidates — gather holders of (seed-winners ∪ breadth-winners); keep wallets recurring in >=2 coins.
//  D. Vet — realized-SOL P&L + win rate (WSOL-flow method; the one that works) on every candidate.
//  E. Keep only HUMAN-fingerprint profitable traders (real SOL deployed, decent win rate, sane token count).
// Run: HELIUS_API_KEY=... npx tsx scripts/meme-hunt-traders.ts
const KEY = process.env.HELIUS_API_KEY;
const WSOL = "So11111111111111111111111111111111111111112";
const SEED = "HLnpSz9h2S4hiLQ43rnSD9XkcUThA7B8hQMKmDaiTLcC";
const GT = "https://api.geckoterminal.com/api/v2/networks/solana";

// programs / routers / the 22 already-proven-bot wallets — don't re-surface
const EXCLUDE = new Set<string>([
  WSOL, "11111111111111111111111111111111", "1nc1nerator11111111111111111111111111111111",
  "5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j", "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM", SEED,
  "FURrDAcbpHQVW3x4wzzNNKaJuQPqYN6aKHzbb211Dnzn","7jUQAoDfjdqdMVSReQDc3CACWsaEjEuNz7g2VSB6FbHx",
  "A7hAgCzFw14fejgCp387JUJRMNyz4j89JKnhtKU8piqW","G5UZAVbAf46s7cKWoyKu8kYTip9DGTpbLZ2qa9Aq69dP",
  "GQhp1metiEge237QfN6rLtFENiz9BW2RCV3s3KPEbWdJ","FWsW1xNtWscwNmKv6wVsU1iTzRN6wmmk3MjxRP5tT7hz",
  "7hTckgnGnLQR6sdH7YkqFTAA7VwTfYFaZ6EhEsU3saCX","3BpXnfJaUTiwXnJNe7Ej1rcbzqTTQUvLShZaWazebsVR",
  "62qc2CNXwrYqQScmEdiZFFAnJR262PxWEuNQtxfafNgV","9rPYyANsfQZw3DnDmKE3YCQF5E8oD89UXoHn9JFEhJUz",
  "GXPFM2caqTtQYC2cJ5yJRi9VDkpsYZXzYdwYpGnLmtDL","JCRGumoE9Qi5BBgULTgdgTLjSgkCMSbF62ZZfGs84JeU",
  "5eHhjP8JaYkz83CWwvGU2uMUXefd3AazWGx4gpcuEEYD","5YxQFdt3Tr9zJLvkFccqXVUwhdTWJQc1fFg2YPbxvxeD",
  "2edoJDYgHag5wNFLbRweDKCdnyEVMZJTDpZwExWyrXFo","5cjcW9wExnJJiqgLjq7DEG75Pm6JBgE1hNv4B2vHXUW6",
  "9M4giFFMxmFGXtc3feFzRai56WbBqehoSeRE5GK7gf7","7VtfL8fvgNfhz17qKRMjzQEXgbdpnHHHQRh54R9jP2RJ",
  "EHAAiTxcdDwQ3U4bU6YcMsQGaekdzLS3B5SmYo46kJtL","LRpJE9eYzs5fsj9PZXBedcUPRCXaAC8jxbhshy5xQxc",
  "AVmoTthdrX6tKt4nDjco2D775W2YK3sDhxPcMmzUAmTY","FwiYAjHmzpH2twsMxTnkj4WDPrXFNYqTQMn8soTMYGGB",
]);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function solUsd(): Promise<number> {
  try { const r = await fetch("https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd", { signal: AbortSignal.timeout(8000) }); return Number((await r.json())?.solana?.usd) || 0; } catch { return 0; }
}
async function gt(path: string): Promise<any[]> {
  try { const r = await fetch(`${GT}${path}`, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(20000) }); if (!r.ok) return []; const d = await r.json(); return Array.isArray(d?.data) ? d.data : []; } catch { return []; }
}
async function holders(mint: string, limit = 80): Promise<string[]> {
  try {
    const r = await fetch(`https://mainnet.helius-rpc.com/?api-key=${KEY}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: "h", method: "getTokenAccounts", params: { mint, limit, page: 1 } }), signal: AbortSignal.timeout(15000) });
    if (!r.ok) return [];
    const d = await r.json();
    return (d?.result?.token_accounts || []).filter((a: any) => a.amount && a.amount > 0).map((a: any) => a.owner).filter(Boolean);
  } catch { return []; }
}

interface Prof { realizedSol: number; deployedSol: number; trades: number; winRate: number; mints: Map<string, number> }
async function profile(addr: string, maxPages: number): Promise<Prof> {
  let before: string | undefined; let spent = 0, recv = 0, pages = 0;
  const perToken = new Map<string, number>();
  while (pages < maxPages) {
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
      let solIn = 0, solOut = 0, mint = "";
      for (const x of (t.tokenTransfers || [])) {
        if (x.mint === WSOL) {
          if (x.toUserAccount === addr) solIn += Number(x.tokenAmount) || 0;
          if (x.fromUserAccount === addr) solOut += Number(x.tokenAmount) || 0;
        } else if (x.mint) { mint = x.mint; }
      }
      recv += solIn; spent += solOut;
      if (mint) perToken.set(mint, (perToken.get(mint) || 0) + (solIn - solOut));
    }
    before = txs[txs.length - 1]?.signature;
    pages++;
    await sleep(300);
  }
  const toks = [...perToken.values()];
  return { realizedSol: recv - spent, deployedSol: spent, trades: toks.length, winRate: toks.length ? toks.filter((v) => v > 0.01).length / toks.length : 0, mints: perToken };
}

(async () => {
  if (!KEY) { console.error("no HELIUS_API_KEY"); process.exit(1); }
  const px = await solUsd();
  const usd = (s: number) => (px ? `$${Math.round(s * px).toLocaleString()}` : `${s.toFixed(1)}SOL`);

  // A. breadth winners
  console.log("A. pulling winning coins from GeckoTerminal...");
  const pools = [...await gt("/trending_pools?page=1"), ...await gt("/trending_pools?page=2"), ...await gt("/pools?page=1"), ...await gt("/pools?page=2")];
  const winnerMints = new Set<string>();
  for (const p of pools) {
    const a = p.attributes || {}; const ch = Number(a.price_change_percentage?.h24 || 0); const liq = Number(a.reserve_in_usd || 0);
    const mint = String(p.relationships?.base_token?.data?.id || "").replace("solana_", "");
    if (ch >= 80 && liq >= 25000 && mint && mint !== WSOL) winnerMints.add(mint);
  }
  console.log(`   ${winnerMints.size} breadth winners`);

  // B. seed's winning coins
  console.log("B. profiling seed wallet's winners...");
  const seedProf = await profile(SEED, 8);
  const seedWinners = [...seedProf.mints.entries()].filter(([, v]) => v > 0.05).map(([m]) => m);
  console.log(`   seed realized ${usd(seedProf.realizedSol)} across ${seedProf.trades} tokens; ${seedWinners.length} winning coins`);

  // C. candidate generation — holders of the union, recurrence >= 2
  const coinSet = [...new Set([...seedWinners, ...winnerMints])].slice(0, 45);
  console.log(`C. gathering holders across ${coinSet.length} coins...`);
  const seen = new Map<string, number>();
  for (const mint of coinSet) { for (const o of await holders(mint)) if (!EXCLUDE.has(o)) seen.set(o, (seen.get(o) || 0) + 1); await sleep(220); }
  const candidates = [...seen.entries()].filter(([, c]) => c >= 2).sort((a, b) => b[1] - a[1]).map(([o]) => o).slice(0, 90);
  console.log(`   ${seen.size} unique holders → ${candidates.length} recurring candidates to vet`);

  // D. vet
  console.log("D. profit-vetting candidates (this is the slow part)...");
  const vetted: { addr: string; p: Prof; recur: number }[] = [];
  for (let i = 0; i < candidates.length; i++) {
    const p = await profile(candidates[i], 4);
    vetted.push({ addr: candidates[i], p, recur: seen.get(candidates[i]) || 0 });
    if (p.realizedSol > 1 && p.winRate >= 0.35) console.log(`   [${i + 1}/${candidates.length}] ${candidates[i].slice(0, 8)}  ${usd(p.realizedSol)}  ${(p.winRate * 100).toFixed(0)}%win  ${p.trades}tok  x${seen.get(candidates[i])}`);
  }

  // E. keep human-fingerprint profitable traders
  const good = vetted.filter((v) => v.p.realizedSol > 0.5 && v.p.winRate >= 0.4 && v.p.trades >= 6 && v.p.trades <= 250 && v.p.deployedSol >= 2).sort((a, b) => b.p.realizedSol - a.p.realizedSol);
  console.log(`\n=== VERIFIED PROFITABLE TRADERS (${good.length}) — incl. seed ===`);
  console.log(` *. ${SEED}  ${usd(seedProf.realizedSol)}  ${(seedProf.winRate * 100).toFixed(0)}%win  ${seedProf.trades}tok  (SEED)`);
  good.forEach((v, i) => console.log(`${String(i + 1).padStart(2)}. ${v.addr}  ${usd(v.p.realizedSol)}  ${(v.p.winRate * 100).toFixed(0)}%win  ${v.p.trades}tok  deployed ${usd(v.p.deployedSol)}  x${v.recur}`));
  console.log(`\n=== KEEP-LIST (comma-joined, seed first) ===`);
  console.log([SEED, ...good.map((v) => v.addr)].join(","));
  process.exit(0);
})().catch((e) => { console.error("ERR:", e.message); process.exit(1); });
