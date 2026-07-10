// Anatomy of a whale: reconstruct a wallet's recent round-trips (coin, position size, hold time, result)
// to SHOW how they actually trade — size + speed — and why it can't be copied on small money.
// Run: HELIUS_API_KEY=... npx tsx scripts/meme-whale-anatomy.ts <WALLET>
const KEY = process.env.HELIUS_API_KEY;
const WSOL = "So11111111111111111111111111111111111111112";
const ADDR = process.argv[2] || "2cP8Zk5WhY1nm5Jrck8aK6qTKrN8SKSei4wdmvczdqj1";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function solUsd(): Promise<number> {
  try { const r = await fetch("https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd", { signal: AbortSignal.timeout(8000) }); return Number((await r.json())?.solana?.usd) || 0; } catch { return 0; }
}

interface Leg { mint: string; solOut: number; solIn: number; firstTs: number; lastTs: number; nBuy: number; nSell: number }

(async () => {
  if (!KEY) { console.error("no HELIUS_API_KEY"); process.exit(1); }
  const px = await solUsd();
  const legs = new Map<string, Leg>();
  let before: string | undefined; let pages = 0;
  while (pages < 6) {
    const url = `https://api.helius.xyz/v0/addresses/${ADDR}/transactions?api-key=${KEY}&type=SWAP&limit=100${before ? `&before=${before}` : ""}`;
    let txs: any[] = [];
    try { const r = await fetch(url, { signal: AbortSignal.timeout(25000) }); if (r.status === 429) { await sleep(2500); continue; } if (!r.ok) break; txs = await r.json(); } catch { break; }
    if (!Array.isArray(txs) || txs.length === 0) break;
    for (const t of txs) {
      const ts = Number(t.timestamp) || 0;
      let solIn = 0, solOut = 0, mint = "";
      for (const x of (t.tokenTransfers || [])) {
        if (x.mint === WSOL) { if (x.toUserAccount === ADDR) solIn += Number(x.tokenAmount) || 0; if (x.fromUserAccount === ADDR) solOut += Number(x.tokenAmount) || 0; }
        else if (x.mint) mint = x.mint;
      }
      if (!mint) continue;
      const g = legs.get(mint) || { mint, solOut: 0, solIn: 0, firstTs: ts, lastTs: ts, nBuy: 0, nSell: 0 };
      g.solOut += solOut; g.solIn += solIn;
      if (solOut > 0) g.nBuy++; if (solIn > 0) g.nSell++;
      g.firstTs = Math.min(g.firstTs || ts, ts); g.lastTs = Math.max(g.lastTs, ts);
      legs.set(mint, g);
    }
    before = txs[txs.length - 1]?.signature; pages++; await sleep(280);
  }
  const rows = [...legs.values()].filter((l) => l.solOut > 0.05 || l.solIn > 0.05);
  rows.sort((a, b) => (b.solIn - b.solOut) - (a.solIn - a.solOut));
  const u = (s: number) => (px ? `$${Math.round(s * px).toLocaleString()}` : `${s.toFixed(1)}◎`);
  const hold = (l: Leg) => { const m = Math.max(0, (l.lastTs - l.firstTs) / 60); return m < 60 ? `${Math.round(m)}m` : m < 1440 ? `${(m / 60).toFixed(1)}h` : `${(m / 1440).toFixed(1)}d`; };
  console.log(`WHALE ${ADDR}\nSOL=$${px} | ${rows.length} coins traded in sampled history\n`);
  console.log("coin(mint)     position(bought)   returned    net       hold    buys/sells");
  for (const l of rows.slice(0, 18)) {
    const net = l.solIn - l.solOut;
    console.log(`${l.mint.slice(0, 10)}..  ${u(l.solOut).padStart(9)}  ${u(l.solIn).padStart(9)}  ${(net >= 0 ? "+" : "") + u(net)}`.padEnd(58) + `  ${hold(l).padStart(5)}  ${l.nBuy}b/${l.nSell}s`);
  }
  const totOut = rows.reduce((s, l) => s + l.solOut, 0), totIn = rows.reduce((s, l) => s + l.solIn, 0);
  const avgPos = rows.length ? totOut / rows.length : 0;
  console.log(`\nTOTAL bought ${u(totOut)} | returned ${u(totIn)} | net ${u(totIn - totOut)} | avg position ${u(avgPos)} across ${rows.length} coins`);
  process.exit(0);
})().catch((e) => { console.error("ERR:", e.message); process.exit(1); });
