// Diagnostic: pull the same GeckoTerminal feed the bot scans, run the top candidates through the REAL
// gates (liquidity → anti-chase → safety → NEW concentration filter → Opus grader), and print WHY each
// is rejected. Shows the new anti-manipulation filter + grader in action. Read-only, no trades.
// Run: HELIUS_API_KEY=... ANTHROPIC_API_KEY=... npx tsx scripts/meme-scan-diagnose.ts
import { checkSafety, checkConcentration, scoreConviction } from "@/lib/meme-signals";
const GT = "https://api.geckoterminal.com/api/v2/networks/solana";
// mirror of live cfg defaults
const MIN_LIQ = 10000, MAX_H1 = 60, MAX_H6 = 120, MIN_HOLDERS = 15, MAX_TOP5 = 80, MIN_CONV = 70;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function gt(path: string): Promise<any[]> {
  try { const r = await fetch(`${GT}${path}`, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(20000) }); if (!r.ok) return []; const d = await r.json(); return Array.isArray(d?.data) ? d.data : []; } catch { return []; }
}
function norm(p: any, now: number) {
  const a = p?.attributes; if (!a) return null;
  const mint = String(p?.relationships?.base_token?.data?.id || "").replace("solana_", "");
  const dex = String(p?.relationships?.dex?.data?.id || "");
  const pc = a.price_change_percentage || {};
  const tx = a.transactions?.h1 || {};
  return {
    mint, dex, name: String(a.name || "?").split(" / ")[0],
    h1: Number(pc.h1) || 0, h6: Number(pc.h6) || 0, liq: Number(a.reserve_in_usd) || 0,
    ageMin: a.pool_created_at ? (now - new Date(a.pool_created_at).getTime()) / 60000 : 0,
    volH1: Number(a.volume_usd?.h1) || 0, buys: Number(tx.buys) || 0, sells: Number(tx.sells) || 0,
  };
}

(async () => {
  const now = Date.now();
  const pools = [...await gt("/new_pools?page=1"), ...await gt("/trending_pools?page=1"), ...await gt("/pools?page=1")];
  const seen = new Set<string>();
  const cands = pools.map((p) => norm(p, now)).filter((c): c is NonNullable<typeof c> => !!c && !!c.mint && c.liq > 0)
    .filter((c) => (seen.has(c.mint) ? false : (seen.add(c.mint), true)))
    .sort((a, b) => (b.buys - b.sells) - (a.buys - a.sells) || b.liq - a.liq)
    .slice(0, 14);
  console.log(`Evaluating ${cands.length} top candidates through the live gates:\n`);
  console.log("coin           h1%     h6%     liq      holders  top5%   VERDICT");
  for (const c of cands) {
    let verdict = "";
    if (c.liq < MIN_LIQ) verdict = `REJECT — thin liquidity ($${Math.round(c.liq)} < $${MIN_LIQ})`;
    else if (c.h1 > MAX_H1) verdict = `REJECT — anti-chase (h1 +${c.h1.toFixed(0)}% > ${MAX_H1}%)`;
    else if (c.h6 > MAX_H6) verdict = `REJECT — anti-chase (h6 +${c.h6.toFixed(0)}% > ${MAX_H6}%)`;
    let holders = "-", top5 = "-";
    if (!verdict) {
      const safety = await checkSafety(c.mint);
      if (!safety.ok) verdict = `REJECT — safety (${safety.reason})`;
      else {
        const conc = await checkConcentration(c.mint);
        holders = String(conc.holders); top5 = conc.top5Pct ? conc.top5Pct.toFixed(0) : "-";
        if (conc.holders >= 3 && conc.holders < MIN_HOLDERS) verdict = `REJECT — too few holders (${conc.holders} < ${MIN_HOLDERS}) [NEW]`;
        else if (conc.holders >= 3 && conc.top5Pct > MAX_TOP5) verdict = `REJECT — concentrated (top5 ${conc.top5Pct.toFixed(0)}% > ${MAX_TOP5}%) [NEW]`;
        else {
          const conv = await scoreConviction(c.name, `h1 +${c.h1.toFixed(0)}% h6 +${c.h6.toFixed(0)}% liq $${Math.round(c.liq)} buys ${c.buys}/sells ${c.sells}`, safety, { active: false, count: 0, hits: [] }, conc);
          verdict = conv.score < MIN_CONV ? `REJECT — low conviction (${conv.score} < ${MIN_CONV}) [OPUS]: ${conv.thesis}` : `✅ WOULD BUY (conv ${conv.score}): ${conv.thesis}`;
        }
      }
      await sleep(150);
    }
    console.log(`${c.name.slice(0, 12).padEnd(12)}  ${("+" + c.h1.toFixed(0)).padStart(6)}  ${("+" + c.h6.toFixed(0)).padStart(6)}  ${("$" + Math.round(c.liq)).padStart(8)}  ${holders.padStart(7)}  ${top5.padStart(5)}   ${verdict}`);
  }
  process.exit(0);
})().catch((e) => { console.error("ERR:", e.message); process.exit(1); });
