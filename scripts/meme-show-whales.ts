// Surface real WHALE wallets + their actual realized P&L, DIY (free). Method:
//  1. pull recent BIG winners from GeckoTerminal (large % gain + real liquidity)
//  2. for each, get the largest holders (getTokenAccounts, sorted by balance) = whales by position
//  3. profile each wallet's realized SOL P&L + win rate (WSOL-flow method)
//  4. rank by realized profit — show the biggest real earners we can reach
// Run: HELIUS_API_KEY=... npx tsx scripts/meme-show-whales.ts
const KEY = process.env.HELIUS_API_KEY;
const WSOL = "So11111111111111111111111111111111111111112";
const GT = "https://api.geckoterminal.com/api/v2/networks/solana";
const EXCLUDE = new Set<string>([
  WSOL, "11111111111111111111111111111111", "1nc1nerator11111111111111111111111111111111",
  "5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j", "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM",
]);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function solUsd(): Promise<number> {
  try { const r = await fetch("https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd", { signal: AbortSignal.timeout(8000) }); return Number((await r.json())?.solana?.usd) || 0; } catch { return 0; }
}
async function gt(path: string): Promise<any[]> {
  try { const r = await fetch(`${GT}${path}`, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(20000) }); if (!r.ok) return []; const d = await r.json(); return Array.isArray(d?.data) ? d.data : []; } catch { return []; }
}
// largest holders of a mint (whales by position), sorted desc by amount
async function topHolders(mint: string, take = 30): Promise<string[]> {
  try {
    const r = await fetch(`https://mainnet.helius-rpc.com/?api-key=${KEY}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: "h", method: "getTokenAccounts", params: { mint, limit: 200, page: 1 } }), signal: AbortSignal.timeout(15000) });
    if (!r.ok) return [];
    const d = await r.json();
    const acc = (d?.result?.token_accounts || []).filter((a: any) => a.amount && a.amount > 0);
    acc.sort((a: any, b: any) => Number(b.amount) - Number(a.amount));
    return acc.map((a: any) => a.owner).filter((o: string) => o && !EXCLUDE.has(o)).slice(0, take);
  } catch { return []; }
}
interface Prof { realizedSol: number; deployedSol: number; trades: number; winRate: number }
async function profile(addr: string, maxPages = 5): Promise<Prof> {
  let before: string | undefined; let spent = 0, recv = 0, pages = 0;
  const perToken = new Map<string, number>();
  while (pages < maxPages) {
    const url = `https://api.helius.xyz/v0/addresses/${addr}/transactions?api-key=${KEY}&type=SWAP&limit=100${before ? `&before=${before}` : ""}`;
    let txs: any[] = [];
    try { const r = await fetch(url, { signal: AbortSignal.timeout(25000) }); if (r.status === 429) { await sleep(2500); continue; } if (!r.ok) break; txs = await r.json(); } catch { break; }
    if (!Array.isArray(txs) || txs.length === 0) break;
    for (const t of txs) {
      let solIn = 0, solOut = 0, mint = "";
      for (const x of (t.tokenTransfers || [])) {
        if (x.mint === WSOL) { if (x.toUserAccount === addr) solIn += Number(x.tokenAmount) || 0; if (x.fromUserAccount === addr) solOut += Number(x.tokenAmount) || 0; }
        else if (x.mint) mint = x.mint;
      }
      recv += solIn; spent += solOut;
      if (mint) perToken.set(mint, (perToken.get(mint) || 0) + (solIn - solOut));
    }
    before = txs[txs.length - 1]?.signature; pages++; await sleep(280);
  }
  const toks = [...perToken.values()];
  return { realizedSol: recv - spent, deployedSol: spent, trades: toks.length, winRate: toks.length ? toks.filter((v) => v > 0.01).length / toks.length : 0 };
}

(async () => {
  if (!KEY) { console.error("no HELIUS_API_KEY"); process.exit(1); }
  const px = await solUsd();
  const usd = (s: number) => (px ? `$${Math.round(s * px).toLocaleString()}` : `${s.toFixed(1)}SOL`);
  console.log(`SOL=$${px}. Finding big winners...`);
  const pools = [...await gt("/trending_pools?page=1"), ...await gt("/trending_pools?page=2"), ...await gt("/pools?page=1")];
  const coins: { mint: string; name: string; ch: number }[] = [];
  for (const p of pools) {
    const a = p.attributes || {}; const ch = Number(a.price_change_percentage?.h24 || 0); const liq = Number(a.reserve_in_usd || 0);
    const mint = String(p.relationships?.base_token?.data?.id || "").replace("solana_", "");
    if (ch >= 120 && liq >= 40000 && mint && mint !== WSOL) coins.push({ mint, name: String(a.name || "").split(" / ")[0], ch });
  }
  coins.sort((a, b) => b.ch - a.ch);
  const pick = coins.slice(0, 7);
  console.log(`Sampling largest wallets from ${pick.length} big winners: ${pick.map((c) => c.name + "(+" + Math.round(c.ch) + "%)").join(", ")}\n`);
  const cand = new Set<string>();
  for (const c of pick) { for (const o of await topHolders(c.mint, 28)) cand.add(o); await sleep(220); }
  const list = [...cand];
  console.log(`Profiling ${list.length} whale-sized wallets...`);
  const res: { addr: string; p: Prof }[] = [];
  for (let i = 0; i < list.length; i++) {
    const p = await profile(list[i], 5);
    res.push({ addr: list[i], p });
    if (p.realizedSol > 20) console.log(`  ${list[i].slice(0, 10)}  ${usd(p.realizedSol)}  ${(p.winRate * 100).toFixed(0)}%win  ${p.trades}tok`);
  }
  res.sort((a, b) => b.p.realizedSol - a.p.realizedSol);
  console.log(`\n=== TOP REAL WHALES BY REALIZED PROFIT (period sampled by history depth) ===`);
  res.slice(0, 20).forEach((r, i) => console.log(`${String(i + 1).padStart(2)}. ${r.addr}  ${usd(r.p.realizedSol)}  ${(r.p.winRate * 100).toFixed(0)}%win  ${r.p.trades}tok  deployed ${usd(r.p.deployedSol)}`));
  process.exit(0);
})().catch((e) => { console.error("ERR:", e.message); process.exit(1); });
