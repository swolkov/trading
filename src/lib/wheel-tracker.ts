// ============ WHEEL FORWARD PAPER TRACKER (shared core) ============
// Simulates a ~$30K "wheel" (cash-secured puts → covered calls) on LIVE Alpaca option data to prove
// the volatility-risk-premium edge forward at $0. Places NO orders and never touches the live $1K
// stocks/crypto account. State + ledger persist in the DB (AgentConfig) so it runs equally on the
// Mac (scripts/wheel-track.ts) or a Vercel cron (api/cron/wheel-track). Advances at most once per day.
//
// Rules (tunable): sell CSPs at ~0.30 delta, 30-45 DTE; buy to close at 50% of premium; on assignment
// hold the shares and sell ~0.30-delta covered calls (above cost basis) until called away. Universe =
// liquid, "would-own" optionable names (the ownership test is the wheel's most important filter).
import { prisma } from "./db";
import { getSnapshot, getOptionsChain, getOptionsSnapshots } from "./alpaca";

// ---------- Tunable parameters ----------
const START_CAPITAL = 30_000;
const UNIVERSE = ["F", "T", "INTC", "PFE", "SOFI", "CSCO", "KO", "HPE"];
const DELTA_TARGET = 0.30;
const DTE_MIN = 30, DTE_MAX = 45, DTE_IDEAL = 37;
const PROFIT_CLOSE = 0.50;
const MAX_SPREAD_PCT = 0.15;
const MAX_NEW_PER_RUN = 3;
const CONTRACTS = 1;
const MULT = 100;
const LEDGER_CAP = 750;

const STATE_KEY = "wheel_account_state";
const LEDGER_KEY = "wheel_ledger";

export interface ShortLeg { optSymbol: string; underlying: string; strike: number; expiry: string; contracts: number; credit: number; opened: string; }
export interface ShareLot { qty: number; costBasis: number; }
export interface WheelState {
  startCapital: number; cash: number; premiumCollected: number; realizedPnl: number;
  assignments: number; calledAway: number;
  shortPuts: ShortLeg[]; shortCalls: ShortLeg[]; shares: Record<string, ShareLot>;
  started: string; lastRun: string | null;
}
export type LedgerRow = Record<string, string | number>;
export interface WheelResult {
  state: WheelState; log: string[]; equity: number; retPct: number;
  sharesValue: number; shortLiab: number; ledgerRow: LedgerRow; ledger: LedgerRow[]; advanced: boolean;
}

const today = () => new Date().toISOString().slice(0, 10);
const dteOf = (expiry: string) => Math.round((new Date(expiry + "T00:00:00Z").getTime() - Date.now()) / 86400000);

function freshState(): WheelState {
  return {
    startCapital: START_CAPITAL, cash: START_CAPITAL, premiumCollected: 0, realizedPnl: 0,
    assignments: 0, calledAway: 0, shortPuts: [], shortCalls: [], shares: {},
    started: today(), lastRun: null,
  };
}

async function loadState(reset: boolean): Promise<WheelState> {
  if (reset) return freshState();
  const row = await prisma.agentConfig.findUnique({ where: { key: STATE_KEY } });
  if (!row?.value) return freshState();
  try { return JSON.parse(row.value) as WheelState; } catch { return freshState(); }
}
async function saveState(s: WheelState) {
  const value = JSON.stringify(s);
  await prisma.agentConfig.upsert({ where: { key: STATE_KEY }, update: { value }, create: { key: STATE_KEY, value } });
}
async function loadLedger(): Promise<LedgerRow[]> {
  const row = await prisma.agentConfig.findUnique({ where: { key: LEDGER_KEY } });
  if (!row?.value) return [];
  try { return JSON.parse(row.value) as LedgerRow[]; } catch { return []; }
}
async function saveLedger(rows: LedgerRow[]) {
  const value = JSON.stringify(rows.slice(-LEDGER_CAP));
  await prisma.agentConfig.upsert({ where: { key: LEDGER_KEY }, update: { value }, create: { key: LEDGER_KEY, value } });
}

export async function runWheelOnce(opts: { reset?: boolean } = {}): Promise<WheelResult> {
  const s = await loadState(!!opts.reset);
  const log: string[] = [];
  const day = today();
  // Advance the wheel at most once per day so the cron and a manual run can't double-trade.
  const advanced = opts.reset === true || s.lastRun !== day;

  // Underlying prices (one pass).
  const price: Record<string, number> = {};
  for (const u of UNIVERSE) {
    try { const snap = await getSnapshot(u); price[u] = snap.latestTrade?.p || snap.latestQuote?.ap || 0; }
    catch { price[u] = 0; }
  }

  const mark = async (leg: ShortLeg, type: "put" | "call"): Promise<number> => {
    try {
      const snap = (await getOptionsSnapshots([leg.optSymbol]))[leg.optSymbol];
      const bp = snap?.latestQuote?.bp ?? 0, ap = snap?.latestQuote?.ap ?? 0;
      if (bp > 0 && ap > 0) return (bp + ap) / 2;
      if (snap?.latestTrade?.p) return snap.latestTrade.p;
    } catch { /* fall through to intrinsic */ }
    const px = price[leg.underlying] || 0;
    return type === "put" ? Math.max(0, leg.strike - px) : Math.max(0, px - leg.strike);
  };

  const selectShort = async (underlying: string, type: "put" | "call"):
    Promise<{ optSymbol: string; strike: number; expiry: string; mid: number; delta: number } | null> => {
    const px = price[underlying];
    if (!px) return null;
    const gte = new Date(Date.now() + DTE_MIN * 86400000).toISOString().slice(0, 10);
    const lte = new Date(Date.now() + DTE_MAX * 86400000).toISOString().slice(0, 10);
    const chain = await getOptionsChain(underlying, undefined, type, gte, lte);
    if (!chain.length) return null;
    const expiries = [...new Set(chain.map((c) => c.expiration_date))];
    const expiry = expiries.sort((a, b) => Math.abs(dteOf(a) - DTE_IDEAL) - Math.abs(dteOf(b) - DTE_IDEAL))[0];
    const targetStrike = type === "put" ? px * 0.93 : px * 1.07;
    const otm = chain
      .filter((c) => c.expiration_date === expiry && (type === "put" ? +c.strike_price < px : +c.strike_price > px))
      .sort((a, b) => Math.abs(+a.strike_price - targetStrike) - Math.abs(+b.strike_price - targetStrike))
      .slice(0, 8);
    if (!otm.length) return null;
    const snaps = await getOptionsSnapshots(otm.map((c) => c.symbol));
    let best: { optSymbol: string; strike: number; expiry: string; mid: number; delta: number } | null = null;
    let bestScore = Infinity;
    for (const c of otm) {
      const snap = snaps[c.symbol];
      const bp = snap?.latestQuote?.bp ?? 0, ap = snap?.latestQuote?.ap ?? 0;
      if (bp <= 0 || ap <= 0) continue;
      const mid = (bp + ap) / 2;
      if ((ap - bp) / mid > MAX_SPREAD_PCT) continue;
      const delta = snap?.greeks?.delta;
      const score = delta != null ? Math.abs(Math.abs(delta) - DELTA_TARGET) : Math.abs(+c.strike_price - targetStrike) / px;
      if (score < bestScore) { bestScore = score; best = { optSymbol: c.symbol, strike: +c.strike_price, expiry, mid, delta: delta ?? NaN }; }
    }
    return best;
  };

  if (advanced) {
    // 1. Settle / manage open SHORT PUTS
    for (const p of [...s.shortPuts]) {
      const px = price[p.underlying] || 0;
      const notional = p.credit * MULT * p.contracts;
      if (dteOf(p.expiry) <= 0) {
        if (px > 0 && px < p.strike) {
          s.cash -= p.strike * MULT * p.contracts;
          const lot = s.shares[p.underlying] || { qty: 0, costBasis: 0 };
          const addQty = MULT * p.contracts;
          lot.costBasis = (lot.costBasis * lot.qty + p.strike * addQty) / (lot.qty + addQty);
          lot.qty += addQty; s.shares[p.underlying] = lot;
          s.realizedPnl += notional; s.assignments++;
          log.push(`ASSIGNED  ${p.underlying} put $${p.strike} → bought ${addQty} sh (kept $${notional.toFixed(0)} premium)`);
        } else {
          s.realizedPnl += notional;
          log.push(`EXPIRED   ${p.underlying} put $${p.strike} worthless (+$${notional.toFixed(0)})`);
        }
        s.shortPuts = s.shortPuts.filter((x) => x !== p);
      } else {
        const m = await mark(p, "put");
        if (m <= p.credit * (1 - PROFIT_CLOSE)) {
          s.cash -= m * MULT * p.contracts;
          s.realizedPnl += (p.credit - m) * MULT * p.contracts;
          s.shortPuts = s.shortPuts.filter((x) => x !== p);
          log.push(`CLOSE 50% ${p.underlying} put $${p.strike} @ $${m.toFixed(2)} (+$${((p.credit - m) * MULT * p.contracts).toFixed(0)})`);
        }
      }
    }

    // 2. Settle / manage open SHORT CALLS (covered)
    for (const c of [...s.shortCalls]) {
      const px = price[c.underlying] || 0;
      const notional = c.credit * MULT * c.contracts;
      const lot = s.shares[c.underlying];
      if (dteOf(c.expiry) <= 0) {
        if (px > 0 && px > c.strike && lot) {
          const qty = MULT * c.contracts;
          s.cash += c.strike * qty;
          s.realizedPnl += (c.strike - lot.costBasis) * qty + notional;
          lot.qty -= qty; if (lot.qty <= 0) delete s.shares[c.underlying];
          s.calledAway++;
          log.push(`CALLED    ${c.underlying} @ $${c.strike} → sold ${qty} sh (+$${notional.toFixed(0)} call premium)`);
        } else {
          s.realizedPnl += notional;
          log.push(`EXPIRED   ${c.underlying} call $${c.strike} worthless, keep shares (+$${notional.toFixed(0)})`);
        }
        s.shortCalls = s.shortCalls.filter((x) => x !== c);
      } else {
        const m = await mark(c, "call");
        if (m <= c.credit * (1 - PROFIT_CLOSE)) {
          s.cash -= m * MULT * c.contracts;
          s.realizedPnl += (c.credit - m) * MULT * c.contracts;
          s.shortCalls = s.shortCalls.filter((x) => x !== c);
          log.push(`CLOSE 50% ${c.underlying} call $${c.strike} @ $${m.toFixed(2)} (+$${((c.credit - m) * MULT * c.contracts).toFixed(0)})`);
        }
      }
    }

    // 3. Sell covered calls on assigned shares (no open call yet, strike >= cost basis)
    for (const u of Object.keys(s.shares)) {
      const lot = s.shares[u];
      if (lot.qty < MULT || s.shortCalls.some((c) => c.underlying === u)) continue;
      try {
        const pick = await selectShort(u, "call");
        if (pick && pick.strike >= lot.costBasis) {
          const contracts = Math.floor(lot.qty / MULT);
          s.cash += pick.mid * MULT * contracts; s.premiumCollected += pick.mid * MULT * contracts;
          s.shortCalls.push({ optSymbol: pick.optSymbol, underlying: u, strike: pick.strike, expiry: pick.expiry, contracts, credit: pick.mid, opened: day });
          log.push(`SELL CC   ${u} $${pick.strike} exp ${pick.expiry} Δ${pick.delta.toFixed(2)} +$${(pick.mid * MULT * contracts).toFixed(0)}`);
        }
      } catch (e) { log.push(`  CC ${u} skipped — ${e instanceof Error ? e.message : e}`); }
    }

    // 4. Sell new cash-secured puts (diversify; respect reserved collateral)
    const reserved = s.shortPuts.reduce((a, p) => a + p.strike * MULT * p.contracts, 0);
    let available = s.cash - reserved;
    let opened = 0;
    for (const u of UNIVERSE) {
      if (opened >= MAX_NEW_PER_RUN) break;
      if (s.shares[u] || s.shortPuts.some((p) => p.underlying === u)) continue;
      try {
        const pick = await selectShort(u, "put");
        if (!pick) continue;
        const collateral = pick.strike * MULT * CONTRACTS;
        if (collateral > available) continue;
        s.cash += pick.mid * MULT * CONTRACTS; s.premiumCollected += pick.mid * MULT * CONTRACTS;
        s.shortPuts.push({ optSymbol: pick.optSymbol, underlying: u, strike: pick.strike, expiry: pick.expiry, contracts: CONTRACTS, credit: pick.mid, opened: day });
        available -= collateral; opened++;
        log.push(`SELL CSP  ${u} $${pick.strike} exp ${pick.expiry} Δ${pick.delta.toFixed(2)} +$${(pick.mid * MULT * CONTRACTS).toFixed(0)}`);
      } catch (e) { log.push(`  CSP ${u} skipped — ${e instanceof Error ? e.message : e}`); }
    }
  } else {
    log.push(`Already advanced today (${day}) — refreshing mark-to-market only.`);
  }

  // 5. Mark-to-market equity
  let shortLiab = 0;
  for (const p of s.shortPuts) shortLiab += (await mark(p, "put")) * MULT * p.contracts;
  for (const c of s.shortCalls) shortLiab += (await mark(c, "call")) * MULT * c.contracts;
  let sharesValue = 0;
  for (const u of Object.keys(s.shares)) sharesValue += s.shares[u].qty * (price[u] || 0);
  const equity = s.cash + sharesValue - shortLiab;
  const retPct = ((equity - s.startCapital) / s.startCapital) * 100;

  s.lastRun = day;
  await saveState(s);

  // 6. Ledger (one row per day; replace same-day)
  const ledgerRow: LedgerRow = {
    run_date: day, equity: +equity.toFixed(0), return_pct: +retPct.toFixed(2), cash: +s.cash.toFixed(0),
    open_puts: s.shortPuts.length, open_calls: s.shortCalls.length, share_lots: Object.keys(s.shares).length,
    premium_total: +s.premiumCollected.toFixed(0), realized_pnl: +s.realizedPnl.toFixed(0),
    assigned: s.assignments, called_away: s.calledAway,
  };
  const ledger = await loadLedger();
  if (ledger.length && ledger[ledger.length - 1].run_date === day) ledger[ledger.length - 1] = ledgerRow;
  else ledger.push(ledgerRow);
  await saveLedger(ledger);

  return { state: s, log, equity, retPct, sharesValue, shortLiab, ledgerRow, ledger, advanced };
}
