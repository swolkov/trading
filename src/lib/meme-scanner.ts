// Meme Lab — an OBSERVATION-ONLY paper harness for Solana meme-coin "jumps" (Cash Cat style).
// It reads new + trending Solana pools from GeckoTerminal (free, no key, no exchange, NO real money),
// filters out obvious rugs, "paper-buys" survivors that show real momentum with realistic slippage
// baked in, then manages each with mechanical exits (take-profit / trail / stop / time / rug).
// The whole point: MEASURE whether any signal we can actually see pays off after fees — before ever
// risking a dollar. Honest expectation: it does NOT (dominated by speed + insiders); the scoreboard
// proves it with our own forward data. Nothing here touches Kraken — memes live on-chain, not on a CEX.
import { prisma } from "./db";
import { checkSafety, checkSmartMoney, checkConcentration, scoreConviction, type SmartMoney } from "./meme-signals";
import { walletConfigured, buyToken, sellToken, solPriceUsd, getSolBalance, sweepSolTo } from "./meme-trader";
import { sendNotification } from "./notifications";

const GT = "https://api.geckoterminal.com/api/v2/networks/solana";
const CLOSED_CAP = 300;        // keep the last N closed paper trades
// Honest slippage: thin books cost FAR more than 5% to get in/out. Scale it by liquidity so the
// scoreboard reflects what we'd actually net, not a fantasy fill.
function slipFor(liq: number): number { return liq < 25000 ? 0.15 : liq < 75000 ? 0.08 : 0.05; }

interface Cfg {
  enabled: boolean;
  sizeUsd: number;             // hypothetical $ per paper entry
  minLiqUsd: number;           // reject below this (can't realistically exit)
  minH1VolUsd: number;         // require real activity
  maxOpen: number;
  minFdvUsd: number;
  maxFdvUsd: number;
  minConviction: number;       // AI conviction gate (0-100)
  enrichMax: number;           // cap on how many candidates get the (safety+AI) treatment per run
  // ── LIVE (real money) ──
  liveEnabled: boolean;        // master switch: execute real Solana buys/sells
  liveValidate: boolean;       // true = build+sign but DON'T send (safe dry run). Arming sets this false.
  liveSizeUsd: number;         // $ per real buy
  liveMaxOpen: number;         // max concurrent REAL positions (× size must stay under the wallet cap)
  liveDailyLossHaltUsd: number;// halt real buys once today's realized live loss exceeds this
  liveMinConviction: number;   // real money only on higher conviction than paper
  maxH1Pump: number;           // ANTI-CHASE: skip if already up more than this % on the hour (don't be exit liquidity)
  maxH6Pump: number;           // ANTI-CHASE: skip if already extended this % on 6h
  partialTpPct: number;        // PARTIAL PROFIT: bank half the position at this gain (1.0 = +100% = 2x), ride the rest
  maxTop5Pct: number;          // ANTI-MANIPULATION: reject if the top-5 non-pool wallets hold >this % of the float
  minHolders: number;          // ANTI-MANIPULATION: reject coins with fewer than this many holders (too easy to rug)
}

async function loadCfg(): Promise<Cfg> {
  const keys = ["meme_scan_enabled", "meme_paper_size_usd", "meme_min_liq_usd", "meme_min_h1_vol_usd", "meme_max_open", "meme_min_fdv_usd", "meme_max_fdv_usd", "meme_min_conviction", "meme_enrich_max",
    "meme_live_enabled", "meme_live_validate", "meme_live_size_usd", "meme_live_max_open", "meme_live_daily_loss_halt_usd", "meme_live_min_conviction",
    "meme_max_h1_pump", "meme_max_h6_pump", "meme_partial_tp_pct", "meme_max_top5_pct", "meme_min_holders"];
  const rows = await prisma.agentConfig.findMany({ where: { key: { in: keys } } });
  const c: Record<string, string> = {}; for (const r of rows) c[r.key] = r.value;
  return {
    enabled: c.meme_scan_enabled !== "false",       // default ON — it's paper, zero risk
    sizeUsd: parseFloat(c.meme_paper_size_usd) || 50,
    minLiqUsd: parseFloat(c.meme_min_liq_usd) || 10000,
    minH1VolUsd: parseFloat(c.meme_min_h1_vol_usd) || 8000,
    maxOpen: parseInt(c.meme_max_open) || 20,
    minFdvUsd: parseFloat(c.meme_min_fdv_usd) || 10000,
    maxFdvUsd: parseFloat(c.meme_max_fdv_usd) || 10000000,
    minConviction: parseFloat(c.meme_min_conviction) || 45,
    enrichMax: parseInt(c.meme_enrich_max) || 8,
    liveEnabled: c.meme_live_enabled === "true",    // default OFF — must be explicitly turned on
    liveValidate: c.meme_live_validate !== "false", // default TRUE — dry run until explicitly armed
    liveSizeUsd: parseFloat(c.meme_live_size_usd) || 20,
    liveMaxOpen: parseInt(c.meme_live_max_open) || 4,   // 4 × $20 = $80, under the $100 wallet cap
    liveDailyLossHaltUsd: parseFloat(c.meme_live_daily_loss_halt_usd) || 40,
    liveMinConviction: parseFloat(c.meme_live_min_conviction) || 60,
    maxH1Pump: parseFloat(c.meme_max_h1_pump) || 60,
    maxH6Pump: parseFloat(c.meme_max_h6_pump) || 120,
    partialTpPct: parseFloat(c.meme_partial_tp_pct) || 1.0,
    maxTop5Pct: parseFloat(c.meme_max_top5_pct) || 80,   // top-5 non-pool wallets owning >80% of the float = manipulated/rug-prone
    minHolders: parseInt(c.meme_min_holders) || 15,      // fewer than 15 holders = too thin, too easy to dump
  };
}

// ── normalized candidate ──
interface Cand {
  pool: string; mint: string; name: string; dex: string; price: number; fdv: number; liq: number;
  ageMin: number; volH1: number; m15: number; h1: number; h6: number;
  buysH1: number; sellsH1: number;
}

function num(v: unknown): number { const n = parseFloat(String(v)); return Number.isFinite(n) ? n : 0; }

function normalize(p: any, now: number): Cand | null {
  const a = p?.attributes; if (!a) return null;
  const addr = a.address as string; if (!addr) return null;
  const created = a.pool_created_at ? new Date(a.pool_created_at).getTime() : now;
  const tx1 = a.transactions?.h1 || {};
  const mint = String(p?.relationships?.base_token?.data?.id || "").replace("solana_", "");
  const dex = String(p?.relationships?.dex?.data?.id || "");
  return {
    pool: addr,
    mint,
    name: a.name || "?",
    dex,
    price: num(a.base_token_price_usd),
    fdv: num(a.fdv_usd),
    liq: num(a.reserve_in_usd),
    ageMin: (now - created) / 60000,
    volH1: num(a.volume_usd?.h1),
    m15: num(a.price_change_percentage?.m15),
    h1: num(a.price_change_percentage?.h1),
    h6: num(a.price_change_percentage?.h6),
    buysH1: num(tx1.buys),
    sellsH1: num(tx1.sells),
  };
}

async function gt(path: string): Promise<any[]> {
  try {
    const r = await fetch(`${GT}${path}`, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(20000) });
    if (!r.ok) return [];
    const d = await r.json();
    return Array.isArray(d?.data) ? d.data : [];
  } catch { return []; }
}

async function fetchCandidates(now: number): Promise<Cand[]> {
  // Trending is the realistic detection surface for a slow bot; new_pools + top pools widen the net.
  const paths = ["/trending_pools?page=1", "/trending_pools?page=2", "/new_pools?page=1", "/new_pools?page=2", "/pools?page=1"];
  const pages = await Promise.all(paths.map((p) => gt(p)));
  const byPool = new Map<string, Cand>();
  for (const p of pages.flat()) {
    const c = normalize(p, now);
    if (c && !byPool.has(c.pool)) byPool.set(c.pool, c);
  }
  return [...byPool.values()];
}

// current price/liq for open positions (multi endpoint, up to 30 addresses)
async function fetchPrices(addrs: string[], now: number): Promise<Record<string, Cand>> {
  const out: Record<string, Cand> = {};
  for (let i = 0; i < addrs.length; i += 30) {
    const chunk = addrs.slice(i, i + 30);
    const data = await gt(`/pools/multi/${chunk.join(",")}`);
    for (const p of data) { const c = normalize(p, now); if (c) out[c.pool] = c; }
  }
  return out;
}

// buy pressure 0..1 (share of h1 trades that were buys) — accumulation vs distribution
function buyRatio(c: Cand): number { const t = c.buysH1 + c.sellsH1; return t > 0 ? c.buysH1 / t : 0.5; }
// acceleration: is the move happening NOW (last 15m) or already spent on the hour? >1 = accelerating.
function accel(c: Cand): number { const h = Math.abs(c.h1); return h > 1 ? (c.m15 * 4) / h : (c.m15 > 0 ? 2 : 1); }

// ENTRY QUALITY 0..~1.3 — rewards fresh, accelerating, well-bid, liquid moves; punishes already-extended
// pumps. This replaces the old "biggest %-gain first" ranking, which literally prioritized the most
// exhausted (and most likely to dump) coins — the core reason the bot kept buying tops.
function entryScore(c: Cand): number {
  const bid = buyRatio(c);                                    // 0..1
  const acc = Math.min(accel(c), 2) / 2;                      // 0..1, capped
  const liq = Math.min(1, c.liq / 200000);                    // deeper book = safer + real exit
  const churn = c.liq > 0 ? Math.min(1, c.volH1 / c.liq) : 0; // real turnover vs a dead pool
  const notExtended = 1 - Math.min(1, Math.max(0, c.h1) / 100); // the higher it's already run, the lower the score
  const gradBonus = c.dex === "pumpswap" ? 0.15 : 0;          // fresh pump.fun graduate
  return bid * 0.3 + acc * 0.25 + liq * 0.15 + churn * 0.15 + notExtended * 0.15 + gradBonus;
}

function passesEntry(c: Cand, cfg: Cfg): string | null {
  if (c.price <= 0) return null;
  if (c.dex === "pump-fun") return null;                     // still on the bonding curve — rug zone, no locked LP, skip
  if (c.liq < cfg.minLiqUsd) return null;                    // too thin to exit → instant-rug territory
  if (c.volH1 < cfg.minH1VolUsd) return null;                // no real activity
  if (c.ageMin < 5 || c.ageMin > 10080) return null;         // past the first-minutes snipe, younger than 7d
  if (c.fdv < cfg.minFdvUsd || c.fdv > cfg.maxFdvUsd) return null; // skip dust and already-mooned
  if (c.h6 < -25) return null;                               // already collapsing
  if (c.h1 > cfg.maxH1Pump) return null;                     // ANTI-CHASE: already ran on the hour — we'd be exit liquidity
  if (c.h6 > cfg.maxH6Pump) return null;                     // ANTI-CHASE: already extended on 6h — the move is likely spent
  if (c.m15 < 8 && c.h1 < 20) return null;                   // require a real jump on a short window
  if (c.buysH1 <= c.sellsH1) return null;                    // more buyers than sellers
  const bidPct = Math.round(buyRatio(c) * 100);
  return `jump m15 +${c.m15.toFixed(0)}% h1 +${c.h1.toFixed(0)}% (${accel(c) > 1.1 ? "accelerating" : "cooling"}), buy-pressure ${bidPct}%, liq $${Math.round(c.liq / 1000)}k, ${c.buysH1}b/${c.sellsH1}s`;
}

interface Pos {
  pool: string; mint: string; name: string; entryTs: string; entryPrice: number; sizeUsd: number;
  entryLiq: number; entryFdv: number; reason: string;
  conviction: number; thesis: string; lpLocked: number; smartCount: number;   // research signals, logged for grading
  top5Pct?: number; holders?: number;                                          // anti-manipulation: holder concentration at entry
  dex?: string; isPumpGraduate?: boolean;                                      // pump.fun graduate signal
  live?: boolean; buyTx?: string; sellTx?: string; solSpentLamports?: number;  // real-money execution
  scaledOut?: boolean; remainFrac?: number; realizedUsdPartial?: number; scaleTx?: string; // partial profit-taking state
  peakPrice: number; lastPrice: number; lastPnlPct: number; lastTs: string;
  exitTs?: string; exitPrice?: number; exitReason?: string; realizedPct?: number; realizedUsd?: number; holdMin?: number;
}

type ExitAction = "hold" | "scale" | "exit";
function decideExit(pos: Pos, cur: Cand | undefined, now: number, cfg: Cfg): { action: ExitAction; reason: string; price: number } {
  const ageMin = (now - new Date(pos.entryTs).getTime()) / 60000;
  // pool vanished / unpriceable = treat as a rug exit at a punitive mark
  if (!cur || cur.price <= 0) {
    if (ageMin > 30) return { action: "exit", reason: "rug_gone", price: pos.entryPrice * 0.1 };
    return { action: "hold", reason: "", price: pos.lastPrice };
  }
  const price = cur.price;
  const gain = price / pos.entryPrice - 1;
  const peak = Math.max(pos.peakPrice, price);
  const peakGain = peak / pos.entryPrice - 1;
  // rug / capitulation always wins
  if (cur.liq <= pos.entryLiq * 0.5 || price <= pos.entryPrice * 0.15) return { action: "exit", reason: "rug_liq", price };
  if (gain >= 4.0) return { action: "exit", reason: "moon_cap", price };                    // bank a +400% moonshot
  if (peakGain >= 1.0 && price <= peak * 0.7) return { action: "exit", reason: "trail", price }; // gave back 30% from peak after +100%
  // after banking half, the runner is free — protect it at breakeven instead of the -40% stop
  if (pos.scaledOut) {
    if (price <= pos.entryPrice) return { action: "exit", reason: "breakeven_after_scale", price };
  } else {
    // PARTIAL PROFIT: first time we clear +TP, sell half and ride the rest (locks a win, removes rug risk on the half)
    if (gain >= cfg.partialTpPct) return { action: "scale", reason: "partial_tp", price };
    if (gain <= -0.4) return { action: "exit", reason: "stop", price };                     // -40% hard stop (pre-scale only)
  }
  if (ageMin >= 1440) return { action: "exit", reason: "time", price };                     // 24h time stop
  return { action: "hold", reason: "", price };
}

// EXIT MANAGER — shared by the full scan AND the fast 1-minute exit cron. Meme coins move in seconds,
// so exits must be checked far more often than the 10-min entry scan. Self-contained: loads open
// positions, sells any that hit a stop/trail/target/rug, persists, returns a summary.
export async function manageMemeExits(): Promise<{ exited: number; open: number; details: string[] }> {
  const cfg = await loadCfg();
  const details: string[] = [];
  const now = Date.now();
  let open: Pos[] = await loadJson("meme_live_open");
  const closed: Pos[] = await loadJson("meme_live_closed");
  if (open.length === 0) return { exited: 0, open: 0, details };
  const liveOn = cfg.liveEnabled && walletConfigured();
  const solPx = liveOn ? await solPriceUsd() : 0;
  const prices = await fetchPrices(open.map((p) => p.pool), now);
  let exited = 0; const stillOpen: Pos[] = [];
  for (const pos of open) {
    const cur = prices[pos.pool];
    if (cur) { pos.peakPrice = Math.max(pos.peakPrice, cur.price); pos.lastPrice = cur.price; pos.lastPnlPct = cur.price / pos.entryPrice - 1; pos.lastTs = new Date(now).toISOString(); }
    const remain = pos.remainFrac ?? 1;
    const d = decideExit(pos, cur, now, cfg);

    if (d.action === "scale") {
      // PARTIAL PROFIT: sell HALF, bank the win, keep the runner. Removes rug risk on the sold half.
      const soldFrac = 0.5;
      const exitPrice = d.price * (1 - slipFor(pos.entryLiq));
      const gainPct = exitPrice / pos.entryPrice - 1;
      let bankedUsd = pos.sizeUsd * soldFrac * gainPct;               // paper: profit on the half sold
      if (pos.live) {
        const sr = await sellToken(pos.mint, cfg.liveValidate, soldFrac);
        pos.scaleTx = sr.sig;
        if (!cfg.liveValidate && sr.ok && sr.expectedOut && pos.solSpentLamports && solPx > 0) {
          const costHalf = pos.solSpentLamports * soldFrac;
          bankedUsd = ((Number(sr.expectedOut) - costHalf) / 1e9) * solPx;   // real SOL delta on the half → $
        }
        await sendNotification(`🎰 MEME SCALED OUT ½ ${pos.name} +${(gainPct * 100).toFixed(0)}% — riding the rest${sr.sig ? ` tx ${sr.sig.slice(0, 8)}` : sr.ok ? "" : ` [${sr.error}]`}`, "general").catch(() => {});
      }
      pos.scaledOut = true;
      pos.remainFrac = remain * soldFrac;                            // remaining fraction of the original position
      pos.realizedUsdPartial = (pos.realizedUsdPartial ?? 0) + bankedUsd;
      stillOpen.push(pos);
      details.push(`SCALE ½ ${pos.name}${pos.live ? " [LIVE]" : ""} +${(gainPct * 100).toFixed(0)}% (banked $${bankedUsd.toFixed(1)}, stop→breakeven)`);
      continue;
    }

    if (d.action === "exit") {
      const exitPrice = d.price * (1 - slipFor(pos.entryLiq));
      pos.exitTs = new Date(now).toISOString();
      pos.exitPrice = exitPrice;
      pos.exitReason = d.reason;
      // realized on the REMAINING fraction, then fold in whatever was banked at the partial
      let runnerUsd = pos.sizeUsd * remain * (exitPrice / pos.entryPrice - 1);
      pos.holdMin = Math.round((now - new Date(pos.entryTs).getTime()) / 60000);
      if (pos.live) {   // REAL sell of the remainder
        const sr = await sellToken(pos.mint, cfg.liveValidate);       // sells the whole remaining balance
        pos.sellTx = sr.sig;
        if (!cfg.liveValidate && sr.ok && sr.expectedOut && pos.solSpentLamports && solPx > 0) {
          const costRemain = pos.solSpentLamports * remain;
          runnerUsd = ((Number(sr.expectedOut) - costRemain) / 1e9) * solPx;   // real SOL delta on remainder → $
        }
      }
      pos.realizedUsd = runnerUsd + (pos.realizedUsdPartial ?? 0);
      pos.realizedPct = pos.sizeUsd > 0 ? pos.realizedUsd / pos.sizeUsd : 0;   // total return on the ORIGINAL size
      if (pos.live) await sendNotification(`🎰 MEME ${cfg.liveValidate ? "VALIDATED SELL" : "SOLD"} ${pos.name} ${(pos.realizedPct * 100).toFixed(0)}% (${d.reason})${pos.sellTx ? ` tx ${pos.sellTx.slice(0, 8)}` : ""}`, "general").catch(() => {});
      closed.unshift(pos); exited++;
      details.push(`EXIT ${pos.name}${pos.live ? " [LIVE]" : ""} ${(pos.realizedPct * 100).toFixed(0)}% (${d.reason})`);
    } else stillOpen.push(pos);
  }
  open = stillOpen;
  await saveJson("meme_live_open", open);
  await saveJson("meme_live_closed", closed.slice(0, CLOSED_CAP));
  await saveJson("meme_scan_stats", computeStats(closed, open));
  return { exited, open: open.length, details };
}

export interface MemeScanResult { enabled: boolean; scanned: number; entered: number; exited: number; open: number; details: string[]; }

export async function runMemeScan(): Promise<MemeScanResult> {
  const cfg = await loadCfg();
  const details: string[] = [];
  if (!cfg.enabled) return { enabled: false, scanned: 0, entered: 0, exited: 0, open: 0, details: ["Meme Lab disabled"] };
  const now = Date.now();

  // 1. manage exits first (the same logic the fast 1-minute exit cron runs standalone)
  const ex = await manageMemeExits();
  details.push(...ex.details);
  const exited = ex.exited;
  let open: Pos[] = await loadJson("meme_live_open");
  let closed: Pos[] = await loadJson("meme_live_closed");
  const liveOn = cfg.liveEnabled && walletConfigured();

  // live guardrails snapshot
  const todayStr = new Date(now).toISOString().slice(0, 10);
  const liveLossToday = closed.filter((p) => p.live && (p.exitTs || "").slice(0, 10) === todayStr).reduce((s, p) => s + Math.min(0, p.realizedUsd ?? 0), 0);
  const liveHalted = liveLossToday <= -cfg.liveDailyLossHaltUsd;
  let liveOpenCount = open.filter((p) => p.live).length;

  // 2. new entries — LIVE ONLY. Mechanical filter → safety → AI conviction. A position exists ONLY
  //    when real money actually buys it (armed) — dry-run just proves the path, no tracked position.
  const cands = await fetchCandidates(now);
  let entered = 0, enriched = 0;
  const knownPools = new Set([...open.map((p) => p.pool), ...closed.map((p) => p.pool)]);
  const shortlist = cands
    .filter((c) => !knownPools.has(c.pool) && passesEntry(c, cfg))
    // rank by ENTRY QUALITY (buy pressure + acceleration + liquidity + not-already-extended), best first —
    // NOT by raw %-gain, which chased the most exhausted coins straight into their dumps
    .sort((a, b) => entryScore(b) - entryScore(a));

  // SMART-MONEY pre-pass (cheap, cached): check whether tracked winner-wallets hold the strongest candidates,
  // then float smart-backed coins to the front so they always get full evaluation. Gates stay firm — this
  // only changes WHICH coins get looked at first. Reused in the loop below so we never double-fetch.
  const top = shortlist.slice(0, 15);
  const smartMap = new Map<string, SmartMoney>();
  await Promise.all(top.map(async (c) => { smartMap.set(c.pool, await checkSmartMoney(c.mint)); }));
  top.sort((a, b) => ((smartMap.get(b.pool)?.count || 0) - (smartMap.get(a.pool)?.count || 0)) || (entryScore(b) - entryScore(a)));

  for (const c of top) {
    if (enriched >= cfg.enrichMax) break;
    enriched++;
    const isGrad = c.dex === "pumpswap";                     // freshly graduated from pump.fun
    const reason = passesEntry(c, cfg)! + (isGrad ? " · pump.fun GRADUATE" : ` · ${c.dex}`);
    const safety = await checkSafety(c.mint);
    if (!safety.ok) { details.push(`SKIP ${c.name} — ${safety.reason}`); continue; }
    // ANTI-MANIPULATION: reject concentrated ownership (few non-pool wallets = engineered pump / rug-prone).
    const conc = await checkConcentration(c.mint);
    if (conc.holders >= 3 && (conc.holders < cfg.minHolders || conc.top5Pct > cfg.maxTop5Pct)) {
      details.push(`SKIP ${c.name} — concentrated (${conc.reason})`); continue;
    }
    const smart = smartMap.get(c.pool) ?? await checkSmartMoney(c.mint);
    const smartTag = smart.count > 0 ? ` 🐋${smart.count}` : "";
    const conv = await scoreConviction(c.name, reason + (smart.count > 0 ? ` · ${smart.count} smart wallet(s) holding` : ""), safety, smart, conc);
    if (conv.score < cfg.liveMinConviction) { details.push(`SKIP ${c.name} — conviction ${conv.score}<${cfg.liveMinConviction}`); continue; }
    // passed every gate → a real BUY candidate
    const gradTag = isGrad ? "🎓 " : "";
    if (!liveOn) { details.push(`WOULD BUY ${gradTag}${c.name} conv ${conv.score} — bot off (fund + arm to trade)`); continue; }
    if (liveHalted) { details.push(`HALTED (daily loss cap) — skip ${c.name}`); continue; }
    if (liveOpenCount >= cfg.liveMaxOpen) { details.push(`FULL (${cfg.liveMaxOpen} open) — skip ${c.name}`); continue; }
    const tr = await buyToken(c.mint, cfg.liveSizeUsd, cfg.liveValidate);
    if (!tr.ok) { details.push(`BUY FAILED ${c.name}: ${tr.error}`); continue; }
    if (cfg.liveValidate) {   // dry-run — path proven, no spend, no tracked position
      details.push(`VALIDATED BUY ${gradTag}${c.name} conv ${conv.score} (dry-run, no spend)`);
      await sendNotification(`🎰 MEME VALIDATED BUY ${gradTag}${c.name} $${cfg.liveSizeUsd} (conv ${conv.score}) — dry-run OK`, "general").catch(() => {});
      continue;
    }
    // ARMED real buy → track the real position
    const entryPrice = c.price * (1 + slipFor(c.liq));
    open.push({
      pool: c.pool, mint: c.mint, name: c.name, entryTs: new Date(now).toISOString(), entryPrice, sizeUsd: cfg.liveSizeUsd,
      entryLiq: c.liq, entryFdv: c.fdv, reason, conviction: conv.score, thesis: conv.thesis, lpLocked: safety.lpLocked, smartCount: smart.count,
      top5Pct: conc.top5Pct, holders: conc.holders,
      dex: c.dex, isPumpGraduate: isGrad,
      live: true, buyTx: tr.sig, solSpentLamports: tr.solSpentLamports,
      peakPrice: entryPrice, lastPrice: entryPrice, lastPnlPct: 0, lastTs: new Date(now).toISOString(),
    });
    knownPools.add(c.pool); liveOpenCount++; entered++;
    await sendNotification(`🎰 MEME BOUGHT ${c.name}${smartTag} $${cfg.liveSizeUsd} (conv ${conv.score})${tr.sig ? ` tx ${tr.sig.slice(0, 8)}` : ""} — ${conv.thesis}`, "general").catch(() => {});
    details.push(`BOUGHT ${c.name}${smartTag} conv ${conv.score}${tr.sig ? ` tx ${tr.sig.slice(0, 8)}` : ""}`);
  }

  // 3. persist + stats
  closed = closed.slice(0, CLOSED_CAP);
  await saveJson("meme_live_open", open);
  await saveJson("meme_live_closed", closed);
  const stats = computeStats(closed, open);
  await saveJson("meme_scan_stats", stats);
  await saveJson("meme_scan_last_run", { ts: new Date(now).toISOString(), scanned: cands.length, entered, exited, open: open.length, details: details.slice(0, 10) });

  return { enabled: true, scanned: cands.length, entered, exited, open: open.length, details };
}

export interface MemeStats {
  closedCount: number; wins: number; winRate: number; totalRealizedUsd: number; totalInvestedUsd: number;
  avgWinPct: number; avgLossPct: number; bestPct: number; worstPct: number; openUnrealizedUsd: number;
}
function computeStats(closed: Pos[], open: Pos[]): MemeStats {
  const n = closed.length;
  const wins = closed.filter((p) => (p.realizedPct ?? 0) > 0);
  const winsPct = wins.map((p) => p.realizedPct!);
  const lossPct = closed.filter((p) => (p.realizedPct ?? 0) <= 0).map((p) => p.realizedPct!);
  const avg = (a: number[]) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0);
  return {
    closedCount: n,
    wins: wins.length,
    winRate: n ? wins.length / n : 0,
    totalRealizedUsd: closed.reduce((s, p) => s + (p.realizedUsd ?? 0), 0),
    totalInvestedUsd: closed.reduce((s, p) => s + p.sizeUsd, 0),
    avgWinPct: avg(winsPct),
    avgLossPct: avg(lossPct),
    bestPct: closed.reduce((m, p) => Math.max(m, p.realizedPct ?? -1), -1),
    worstPct: closed.reduce((m, p) => Math.min(m, p.realizedPct ?? 0), 0),
    // exposure on what's still held (remaining fraction) + cash already banked at any partial scale-out
    openUnrealizedUsd: open.reduce((s, p) => s + p.sizeUsd * (p.remainFrac ?? 1) * p.lastPnlPct + (p.realizedUsdPartial ?? 0), 0),
  };
}

// ── JSON blob storage in agentConfig (no schema migration — never risk the engine's raw SQL tables) ──
async function loadJson<T = Pos[]>(key: string): Promise<T> {
  try { const r = await prisma.agentConfig.findUnique({ where: { key } }); return r?.value ? JSON.parse(r.value) : ([] as unknown as T); }
  catch { return [] as unknown as T; }
}
async function saveJson(key: string, value: unknown): Promise<void> {
  const v = JSON.stringify(value);
  await prisma.agentConfig.upsert({ where: { key }, update: { value: v }, create: { key, value: v } }).catch(() => {});
}

// CASH OUT — sell every open position to SOL, then sweep all SOL to a destination address.
// Also flips the bot off so it doesn't immediately re-buy. Password-gated at the API layer.
export async function cashOut(destAddress: string): Promise<{ ok: boolean; sold: number; swept?: string; error?: string; details: string[] }> {
  const details: string[] = [];
  if (!walletConfigured()) return { ok: false, sold: 0, error: "wallet not configured", details };
  await prisma.agentConfig.upsert({ where: { key: "meme_live_enabled" }, update: { value: "false" }, create: { key: "meme_live_enabled", value: "false" } }).catch(() => {});
  let open: Pos[] = await loadJson("meme_live_open");
  let closed: Pos[] = await loadJson("meme_live_closed");
  let sold = 0;
  for (const pos of open) {
    const sr = await sellToken(pos.mint, false);
    pos.exitTs = new Date().toISOString(); pos.exitReason = "cashout"; pos.sellTx = sr.sig;
    if (sr.ok) sold++; else details.push(`sell failed ${pos.name}: ${sr.error}`);
    closed.unshift(pos);
    await sendNotification(`🎰 MEME CASHOUT SELL ${pos.name}${sr.sig ? ` tx ${sr.sig.slice(0, 8)}` : ` [${sr.error}]`}`, "general").catch(() => {});
  }
  open = [];
  await saveJson("meme_live_open", open);
  await saveJson("meme_live_closed", closed.slice(0, CLOSED_CAP));
  const sweep = await sweepSolTo(destAddress, false);
  if (!sweep.ok) { details.push(`sweep failed: ${sweep.error}`); return { ok: false, sold, error: sweep.error, details }; }
  await sendNotification(`🎰 MEME CASHED OUT — sold ${sold}, swept SOL to ${destAddress.slice(0, 6)}… tx ${sweep.sig?.slice(0, 8)}`, "general").catch(() => {});
  return { ok: true, sold, swept: sweep.sig, details };
}

// ── status for the Meme Lab page ──
export interface MemeLabStatus {
  enabled: boolean; config: Record<string, string>; stats: MemeStats;
  open: Pos[]; closed: Pos[]; lastRun: unknown;
  live: { enabled: boolean; validate: boolean; sizeUsd: number; maxOpen: number; walletConfigured: boolean; walletAddress: string | null; solBalance: number; capUsd: number };
}
export async function getMemeLabStatus(): Promise<MemeLabStatus> {
  const cfg = await loadCfg();
  const rows = await prisma.agentConfig.findMany({ where: { key: { in: ["meme_scan_enabled", "meme_min_liq_usd", "meme_min_h1_vol_usd", "meme_live_min_conviction", "meme_smart_wallets", "meme_wallet_pubkey"] } } });
  const config: Record<string, string> = {}; for (const r of rows) config[r.key] = r.value;
  const open = await loadJson("meme_live_open");
  const closed = await loadJson("meme_live_closed");
  const stats = await loadJson<MemeStats>("meme_scan_stats").then((s) => (Array.isArray(s) ? computeStats(closed, open) : s)) as MemeStats;
  let lastRun: unknown = null;
  try { const lr = await prisma.agentConfig.findUnique({ where: { key: "meme_scan_last_run" } }); if (lr?.value) lastRun = JSON.parse(lr.value); } catch { /* ignore */ }
  const configured = walletConfigured();
  const solBalance = configured ? await getSolBalance().catch(() => 0) : 0;
  const live = {
    enabled: cfg.liveEnabled, validate: cfg.liveValidate, sizeUsd: cfg.liveSizeUsd, maxOpen: cfg.liveMaxOpen,
    walletConfigured: configured, walletAddress: config.meme_wallet_pubkey || null, solBalance,
    capUsd: cfg.liveSizeUsd * cfg.liveMaxOpen,
  };
  return { enabled: cfg.enabled, config, stats: stats || computeStats(closed, open), open, closed: closed.slice(0, 40), lastRun, live };
}
