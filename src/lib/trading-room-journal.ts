// THE JOURNAL — pure rules (Sprint 2, Sep 19 2026). Spencer trades MES / MNQ / MGC live, by hand, at
// his own size; the room stores every fill his Tradovate account reports (trading_room_fills). This
// module turns fills into ROUND TRIPS, stamps each with what the chart knew at entry (session, nearest
// level, distance in ATR, event proximity), measures what happened inside the trade (MFE / MAE), and
// runs the pre-registered 40-trade test from Research/fable-futures-assist-sep19.md. Nothing here
// judges size: contracts are recorded as data and the test speaks for itself.
//
// R: when a stop order was seen for the position, R = |entry − stop| × point value × contracts (the
// real risk). When no stop was seen, R falls back to a PROXY of 2 × the 5-minute ATR at entry — and
// the row says so (`riskSource`), so the scoreboard can report "trades with a real stop".
import { INSTRUMENTS, etParts, type Bar, type RoomSymbol } from "@/lib/trading-room-rules";

export const FEES_RT_PER_CONTRACT_USD = 1.5;   // Tradovate micro: ~$0.35 commission + ~$0.37 exchange + NFA, each side
export const TEST_RULES = {
  registeredAt: "2026-09-19",
  minTrades: 40, recheckAt: 50,
  minT: 1.5,                     // mean net R > 0 with t ≥ 1.5 — modest, honest for a person (code is held to 2)
  minProfitFactor: 1.3,
  minProfitFactorWithoutTopTwo: 1.0,
  minBootstrapPMeanPositive: 0.85,
  bootstrapDraws: 10_000,
} as const;

export interface JournalFill { id: number; symbol: RoomSymbol; ts: number; action: "Buy" | "Sell"; qty: number; price: number }

export interface RoundTrip {
  symbol: RoomSymbol;
  side: "long" | "short";
  qty: number;                 // peak contracts held during the trip
  entryTs: number; exitTs: number;
  entryPx: number; exitPx: number;     // volume-weighted
  grossUsd: number; feesUsd: number; netUsd: number;
  fillIds: number[];
  open: boolean;               // true while the position is still on (exitTs / exitPx = last fill so far)
}

/** FIFO netting per symbol: a trip opens on the first fill from flat and closes when the net position returns
 *  to zero. Scale-ins raise `qty`; a flip (long 2 → sell 3) closes one trip and opens the next with the excess. */
export function roundTripsFromFills(fills: JournalFill[]): RoundTrip[] {
  const out: RoundTrip[] = [];
  const bySymbol = new Map<RoomSymbol, JournalFill[]>();
  for (const f of [...fills].sort((a, b) => a.ts - b.ts || a.id - b.id)) bySymbol.set(f.symbol, [...(bySymbol.get(f.symbol) ?? []), f]);
  for (const [symbol, list] of bySymbol) {
    const spec = INSTRUMENTS[symbol];
    let pos = 0;                                   // signed contracts
    let cur: { side: "long" | "short"; qty: number; entryTs: number; openNotional: number; openQty: number; closeNotional: number; closeQty: number; ids: number[]; lastTs: number } | null = null;
    const finish = (exitTs: number) => {
      if (!cur) return;
      const entryPx = cur.openNotional / cur.openQty, exitPx = cur.closeQty ? cur.closeNotional / cur.closeQty : entryPx;
      const dir = cur.side === "long" ? 1 : -1;
      const gross = dir * (exitPx - entryPx) * spec.pointValue * cur.closeQty;
      const fees = FEES_RT_PER_CONTRACT_USD * cur.qty;
      out.push({ symbol, side: cur.side, qty: cur.qty, entryTs: cur.entryTs, exitTs, entryPx, exitPx, grossUsd: gross, feesUsd: fees, netUsd: gross - fees, fillIds: cur.ids, open: false });
      cur = null;
    };
    for (const f of list) {
      let remaining = f.qty;
      const signed = f.action === "Buy" ? 1 : -1;
      while (remaining > 0) {
        if (pos === 0 || Math.sign(pos) === signed) {
          // opening or adding
          if (!cur) cur = { side: signed > 0 ? "long" : "short", qty: 0, entryTs: f.ts, openNotional: 0, openQty: 0, closeNotional: 0, closeQty: 0, ids: [], lastTs: f.ts };
          cur.openNotional += f.price * remaining; cur.openQty += remaining; cur.ids.push(f.id); cur.lastTs = f.ts;
          pos += signed * remaining; cur.qty = Math.max(cur.qty, Math.abs(pos)); remaining = 0;
        } else {
          // reducing (and possibly flipping)
          const closeNow = Math.min(remaining, Math.abs(pos));
          cur!.closeNotional += f.price * closeNow; cur!.closeQty += closeNow; if (!cur!.ids.includes(f.id)) cur!.ids.push(f.id); cur!.lastTs = f.ts;
          pos += signed * closeNow; remaining -= closeNow;
          if (pos === 0) finish(f.ts);
        }
      }
    }
    if (cur) {
      const c = cur as NonNullable<typeof cur>;
      const entryPx = c.openNotional / c.openQty;
      const exitPx = c.closeQty ? c.closeNotional / c.closeQty : entryPx;
      const dir = c.side === "long" ? 1 : -1;
      const gross = dir * (exitPx - entryPx) * spec.pointValue * c.closeQty;
      out.push({ symbol, side: c.side, qty: c.qty, entryTs: c.entryTs, exitTs: c.lastTs, entryPx, exitPx, grossUsd: gross, feesUsd: FEES_RT_PER_CONTRACT_USD * c.qty, netUsd: gross - FEES_RT_PER_CONTRACT_USD * c.qty, fillIds: c.ids, open: true });
    }
  }
  return out.sort((a, b) => a.entryTs - b.entryTs);
}

// ---- stamps -----------------------------------------------------------------------------------
export type SessionBucket = "overnight" | "premarket" | "open" | "morning" | "midday" | "afternoon" | "close";
/** ET buckets. "open" = the first hour after 09:30, the one robust intraday effect on these markets. */
export function sessionBucket(ms: number): SessionBucket {
  const h = etParts(ms).hourFrac;
  if (h < 4) return "overnight";
  if (h < 9.5) return "premarket";
  if (h < 10.5) return "open";
  if (h < 12) return "morning";
  if (h < 14) return "midday";
  if (h < 15.5) return "afternoon";
  if (h < 17) return "close";
  return "overnight";
}

export interface Excursion { mfePts: number; maePts: number }
/** Best and worst price excursion between entry and exit, on bars overlapping the trade. */
export function excursion(bars: Bar[], side: "long" | "short", entryPx: number, entryTs: number, exitTs: number): Excursion | null {
  const inside = bars.filter((b) => b.t + 60_000 > entryTs && b.t <= exitTs);
  if (!inside.length) return null;
  const hi = Math.max(...inside.map((b) => b.h)), lo = Math.min(...inside.map((b) => b.l));
  return side === "long" ? { mfePts: Math.max(0, hi - entryPx), maePts: Math.max(0, entryPx - lo) } : { mfePts: Math.max(0, entryPx - lo), maePts: Math.max(0, hi - entryPx) };
}

export interface JournalRow {
  id: string;                       // `${symbol}-${entryTs}-${firstFillId}`
  symbol: RoomSymbol; side: "long" | "short"; qty: number;
  entryTs: string; exitTs: string; entryPx: number; exitPx: number;
  grossUsd: number; feesUsd: number; netUsd: number;
  stopPx: number | null; riskUsd: number | null; riskSource: "stop" | "atr-proxy" | "none";
  netR: number | null; mfeR: number | null; maeR: number | null;
  holdMin: number; session: SessionBucket; dow: number;
  nearestLevel: string | null; nearestLevelPx: number | null; distAtr: number | null;
  eventFlag: string | null;
  setupTag: string | null; why: string | null;   // Spencer's own words, from the page
  open: boolean;
  fillIds: number[];
}

/** R in dollars for one contract: the stop distance, else the ATR proxy (documented on the row). */
export function riskPerContract(spec: { pointValue: number }, entryPx: number, stopPx: number | null, atr5m: number | null): { usd: number; source: JournalRow["riskSource"] } | null {
  if (stopPx != null && Math.abs(entryPx - stopPx) > 0) return { usd: Math.abs(entryPx - stopPx) * spec.pointValue, source: "stop" };
  if (atr5m != null && atr5m > 0) return { usd: 2 * atr5m * spec.pointValue, source: "atr-proxy" };
  return null;
}

// ---- the 40-trade test -----------------------------------------------------------------------------
export interface Scoreboard {
  n: number; closed: number; withStop: number;
  netUsd: number; meanR: number | null; sdR: number | null; tStat: number | null;
  profitFactor: number | null; profitFactorWithoutTopTwo: number | null;
  winRate: number | null; avgContracts: number | null;
  bootstrapPMeanPositive: number | null;
  bySession: { session: SessionBucket; n: number; netUsd: number; meanR: number | null }[];
  bySymbol: { symbol: RoomSymbol; n: number; netUsd: number; meanR: number | null }[];
  eventWindow: { inside: { n: number; netUsd: number }; outside: { n: number; netUsd: number } };
  verdict: { status: "collecting" | "pass" | "fail"; checks: { name: string; ok: boolean | null; detail: string }[] };
}

const mean = (a: number[]) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : NaN);
const sd = (a: number[]) => { if (a.length < 2) return NaN; const m = mean(a); return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1)); };
/** mulberry32 — a tiny seeded PRNG so the bootstrap is reproducible in tests. */
function prng(seed: number) { let a = seed >>> 0; return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
export function bootstrapPMeanPositive(rs: number[], draws: number = TEST_RULES.bootstrapDraws, seed = 20260919): number | null {
  if (rs.length < 5) return null;
  const rnd = prng(seed); let pos = 0;
  for (let d = 0; d < draws; d++) { let s = 0; for (let i = 0; i < rs.length; i++) s += rs[Math.floor(rnd() * rs.length)]; if (s > 0) pos++; }
  return pos / draws;
}
function profitFactor(pnls: number[]): number | null {
  let w = 0, l = 0; for (const p of pnls) { if (p > 0) w += p; else l -= p; }
  if (!pnls.length) return null;
  return l > 0 ? w / l : (w > 0 ? Infinity : null);
}

export function scoreboard(rows: JournalRow[], eventWindowMs = 30 * 60_000, eventTimes: number[] = []): Scoreboard {
  const closed = rows.filter((r) => !r.open);
  const withR = closed.filter((r) => r.netR != null);
  const rs = withR.map((r) => r.netR as number);
  const pnls = closed.map((r) => r.netUsd);
  const m = rs.length ? mean(rs) : NaN, s = rs.length > 1 ? sd(rs) : NaN;
  const t = rs.length > 1 && s > 0 ? m / s * Math.sqrt(rs.length) : null;
  const sortedPnl = [...pnls].sort((a, b) => b - a);
  const pf = profitFactor(pnls), pfNoTop2 = closed.length > 2 ? profitFactor(sortedPnl.slice(2)) : null;
  const group = <K extends string>(key: (r: JournalRow) => K) => {
    const mp = new Map<K, JournalRow[]>(); for (const r of closed) mp.set(key(r), [...(mp.get(key(r)) ?? []), r]);
    return [...mp.entries()].map(([k, list]) => { const rr = list.filter((x) => x.netR != null).map((x) => x.netR as number); return { key: k, n: list.length, netUsd: list.reduce((a, x) => a + x.netUsd, 0), meanR: rr.length ? mean(rr) : null }; });
  };
  const inside = closed.filter((r) => eventTimes.some((e) => Math.abs(Date.parse(r.entryTs) - e) <= eventWindowMs));
  const outside = closed.filter((r) => !inside.includes(r));
  const boot = bootstrapPMeanPositive(rs);
  const n = closed.length;
  const enough = n >= TEST_RULES.minTrades;
  const checks = [
    { name: `mean net R > 0 with t ≥ ${TEST_RULES.minT}`, ok: enough ? (t != null && m > 0 && t >= TEST_RULES.minT) : null, detail: rs.length ? `mean R ${m.toFixed(2)} · t ${t?.toFixed(2) ?? "—"} · ${rs.length} trades with R` : "no trades with R yet" },
    { name: `profit factor ≥ ${TEST_RULES.minProfitFactor}, and ≥ ${TEST_RULES.minProfitFactorWithoutTopTwo} without the two best trades`, ok: enough ? (pf != null && pf >= TEST_RULES.minProfitFactor && pfNoTop2 != null && pfNoTop2 >= TEST_RULES.minProfitFactorWithoutTopTwo) : null, detail: `PF ${pf == null ? "—" : Number.isFinite(pf) ? pf.toFixed(2) : "∞"} · without top two ${pfNoTop2 == null ? "—" : Number.isFinite(pfNoTop2) ? pfNoTop2.toFixed(2) : "∞"}` },
    { name: `bootstrap P(mean R > 0) ≥ ${Math.round(TEST_RULES.minBootstrapPMeanPositive * 100)}%`, ok: enough ? (boot != null && boot >= TEST_RULES.minBootstrapPMeanPositive) : null, detail: boot == null ? "needs 5+ trades" : `${(boot * 100).toFixed(0)}%` },
    { name: "a real stop on the trade (process, reported not gated)", ok: null, detail: `${closed.filter((r) => r.riskSource === "stop").length} of ${n} had a stop order the room could see` },
  ];
  const gated = checks.slice(0, 3);
  const status: Scoreboard["verdict"]["status"] = !enough ? "collecting" : gated.every((c) => c.ok) ? "pass" : "fail";
  return {
    n: rows.length, closed: n, withStop: closed.filter((r) => r.riskSource === "stop").length,
    netUsd: pnls.reduce((a, b) => a + b, 0), meanR: rs.length ? m : null, sdR: rs.length > 1 ? s : null, tStat: t,
    profitFactor: pf, profitFactorWithoutTopTwo: pfNoTop2,
    winRate: n ? closed.filter((r) => r.netUsd > 0).length / n : null, avgContracts: n ? mean(closed.map((r) => r.qty)) : null,
    bootstrapPMeanPositive: boot,
    bySession: group((r) => r.session).map((g) => ({ session: g.key, n: g.n, netUsd: g.netUsd, meanR: g.meanR })),
    bySymbol: group((r) => r.symbol).map((g) => ({ symbol: g.key, n: g.n, netUsd: g.netUsd, meanR: g.meanR })),
    eventWindow: { inside: { n: inside.length, netUsd: inside.reduce((a, r) => a + r.netUsd, 0) }, outside: { n: outside.length, netUsd: outside.reduce((a, r) => a + r.netUsd, 0) } },
    verdict: { status, checks },
  };
}
