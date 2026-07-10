#!/usr/bin/env tsx
// Smart-money wallet discovery for Meme Lab — 100% free, derived from real on-chain data.
// Idea: pull recent Solana meme coins that ACTUALLY pumped and are still liquid (survivors, not rugs),
// look at who holds each one (Helius DAS getTokenAccounts), and surface wallets that appear as sizeable
// holders across MULTIPLE independent winners. A wallet that's early/large in several unrelated winners
// is far more likely to be skilled/insider than any single-coin holder. Recurrence is the signal.
// Output: a ranked list we can seed into `meme_smart_wallets`. Honest v1 heuristic — not gospel.
import { PrismaClient } from "../src/generated/prisma/client.js";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";

const HELIUS = process.env.HELIUS_API_KEY!;
const RPC = `https://mainnet.helius-rpc.com/?api-key=${HELIUS}`;
const GT = "https://api.geckoterminal.com/api/v2/networks/solana";

// Addresses that are NOT traders — pools, routers, program authorities, burn. Recurring by design; exclude.
const NON_TRADER = new Set<string>([
  "So11111111111111111111111111111111111111112",
  "11111111111111111111111111111111",
  "1nc1nerator11111111111111111111111111111111",
  "5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j",   // Raydium authority V4
  "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM",   // known market-maker/CEX hot
]);
// Heuristic filters for obvious non-trader owners by pattern (pools/vaults tend to hold near-total supply).

async function gt(path: string): Promise<any[]> {
  try { const r = await fetch(`${GT}${path}`, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(20000) }); if (!r.ok) return []; const d = await r.json(); return Array.isArray(d?.data) ? d.data : []; }
  catch { return []; }
}

// pull sustained winners: trending + top pools, keep meaningful h6/h24 gains that are still liquid
async function winnerMints(): Promise<{ mint: string; name: string; gain: number; liq: number }[]> {
  const paths = ["/trending_pools?page=1", "/trending_pools?page=2", "/pools?page=1", "/pools?page=2"];
  const pages = await Promise.all(paths.map((p) => gt(p)));
  const byMint = new Map<string, { mint: string; name: string; gain: number; liq: number }>();
  for (const p of pages.flat()) {
    const a = p?.attributes; if (!a) continue;
    const dex = String(p?.relationships?.dex?.data?.id || "");
    if (dex === "pump-fun") continue;                                    // bonding-curve, skip
    const mint = String(p?.relationships?.base_token?.data?.id || "").replace("solana_", "");
    if (!mint) continue;
    const liq = parseFloat(a.reserve_in_usd) || 0;
    const h6 = parseFloat(a.price_change_percentage?.h6) || 0;
    const h24 = parseFloat(a.price_change_percentage?.h24) || 0;
    const gain = Math.max(h6, h24);
    if (liq < 40000) continue;                                           // still liquid = survived (not a rug)
    if (gain < 40) continue;                                             // actually pumped
    if (!byMint.has(mint)) byMint.set(mint, { mint, name: a.name || "?", gain, liq });
  }
  return [...byMint.values()];
}

// Helius DAS: top holders of a mint (owner + amount). One paginated RPC call set.
async function topHolders(mint: string, take = 40): Promise<{ owner: string; amount: number }[]> {
  try {
    const r = await fetch(RPC, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: "h", method: "getTokenAccounts", params: { mint, limit: 200, page: 1 } }),
      signal: AbortSignal.timeout(20000),
    });
    if (!r.ok) return [];
    const d = await r.json();
    const accts = d?.result?.token_accounts || [];
    const byOwner = new Map<string, number>();
    for (const a of accts) { const o = a.owner as string; const amt = Number(a.amount) || 0; if (o) byOwner.set(o, (byOwner.get(o) || 0) + amt); }
    return [...byOwner.entries()].map(([owner, amount]) => ({ owner, amount })).sort((a, b) => b.amount - a.amount).slice(0, take);
  } catch { return []; }
}

async function main() {
  if (!HELIUS) { console.error("HELIUS_API_KEY not set"); process.exit(1); }
  const winners = await winnerMints();
  console.log(`Winners (pumped + still liquid): ${winners.length}`);
  winners.slice(0, 30).forEach((w) => console.log(`  ${w.name.padEnd(22)} +${w.gain.toFixed(0)}%  liq $${Math.round(w.liq / 1000)}k`));

  const walletHits = new Map<string, { count: number; coins: string[] }>();
  let scanned = 0;
  for (const w of winners.slice(0, 40)) {
    const holders = await topHolders(w.mint);
    // skip the mega-holders that are almost certainly the pool/dev (top 1-2 by a huge margin are usually LP)
    const traders = holders.slice(2, 40);                                // drop the top 2 (LP/dev heuristic)
    const seen = new Set<string>();
    for (const h of traders) {
      if (NON_TRADER.has(h.owner)) continue;
      if (seen.has(h.owner)) continue; seen.add(h.owner);
      const e = walletHits.get(h.owner) || { count: 0, coins: [] };
      e.count++; e.coins.push(w.name);
      walletHits.set(h.owner, e);
    }
    scanned++;
    await new Promise((r) => setTimeout(r, 120));                        // gentle on the RPC
  }
  console.log(`\nScanned ${scanned} winners' holder sets.`);

  const recurring = [...walletHits.entries()]
    .filter(([, e]) => e.count >= 2)                                     // appears across ≥2 independent winners
    .sort((a, b) => b[1].count - a[1].count);
  console.log(`\nRecurring holders (in ≥2 winners): ${recurring.length} — now vetting each one's REAL trading history…`);

  // STAGE 2 — vet each candidate against its actual swap history. Real smart money = an ACTIVE, DIVERSIFIED,
  // PROFITABLE trader. Vaults / bot-clusters / bag-holders fail this: they trade few tokens and don't sell
  // into profit. This is what turns "recurring holder" into "verified skilled wallet".
  const SOL_MINT = "So11111111111111111111111111111111111111112";
  const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
  interface Prof { wallet: string; winners: number; swaps: number; tokens: number; netSol: number; score: number }
  const profiled: Prof[] = [];
  for (const [wallet, e] of recurring) {
    let swaps = 0, solIn = 0, solOut = 0; const toks = new Set<string>();
    try {
      const r = await fetch(`https://api.helius.xyz/v0/addresses/${wallet}/transactions?api-key=${HELIUS}&type=SWAP&limit=100`, { signal: AbortSignal.timeout(20000) });
      if (r.ok) {
        const txns = await r.json();
        for (const t of Array.isArray(txns) ? txns : []) {
          if (t?.type !== "SWAP") continue;
          swaps++;
          // SOL legs come as wrapped-SOL tokenTransfers and/or nativeTransfers, keyed to this wallet
          for (const tt of t.tokenTransfers || []) {
            const m = tt.mint; const amt = Number(tt.tokenAmount) || 0;
            if (m === SOL_MINT) {
              if (tt.toUserAccount === wallet) solIn += amt;             // sold a token → received SOL
              if (tt.fromUserAccount === wallet) solOut += amt;          // spent SOL → bought a token
            } else if (m && m !== USDC_MINT && (tt.toUserAccount === wallet || tt.fromUserAccount === wallet)) {
              toks.add(m);                                               // a distinct token this wallet traded
            }
          }
          for (const nt of t.nativeTransfers || []) {
            const amt = (Number(nt.amount) || 0) / 1e9;
            if (amt < 0.001) continue;                                   // skip rent/fee dust
            if (nt.toUserAccount === wallet) solIn += amt;
            if (nt.fromUserAccount === wallet) solOut += amt;
          }
        }
      }
    } catch { /* skip */ }
    const netSol = solIn - solOut;
    // keep only genuine active traders: real volume of swaps AND a diversified book (kills vaults/clusters)
    const isTrader = swaps >= 15 && toks.size >= 8;
    // score: recurrence + diversity + activity + realized-profit tilt
    const score = e.count * 3 + Math.min(toks.size, 40) * 0.5 + Math.min(swaps, 100) * 0.1 + Math.max(-10, Math.min(20, netSol));
    if (isTrader) profiled.push({ wallet, winners: e.count, swaps, tokens: toks.size, netSol, score });
    await new Promise((r) => setTimeout(r, 120));
  }
  profiled.sort((a, b) => b.score - a.score);
  console.log(`\nVERIFIED smart wallets (active + diversified traders): ${profiled.length} of ${recurring.length}`);
  profiled.slice(0, 40).forEach((p) => console.log(`  ${p.wallet}  ${p.winners}w  ${p.swaps}sw  ${p.tokens}tok  netSOL ${p.netSol.toFixed(1)}  score ${p.score.toFixed(1)}`));

  const list = profiled.slice(0, 30).map((p) => p.wallet);
  console.log(`\n=== TOP ${list.length} WALLETS (comma-joined for meme_smart_wallets) ===`);
  console.log(list.join(","));

  if (process.argv.includes("--save") && list.length > 0) {
    const pool = new Pool({ connectionString: process.env.DATABASE_URL! });
    const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });
    await prisma.agentConfig.upsert({ where: { key: "meme_smart_wallets" }, update: { value: list.join(",") }, create: { key: "meme_smart_wallets", value: list.join(",") } });
    console.log(`\nSAVED ${list.length} wallets to meme_smart_wallets.`);
    await pool.end();
  } else {
    console.log(`\n(dry run — re-run with --save to write meme_smart_wallets)`);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
