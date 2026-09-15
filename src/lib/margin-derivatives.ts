// DERIVATIVES RESEARCH FEED (Sep 15 2026) — funding, open interest and mark from PUBLIC perpetual
// tickers, snapshotted every ≥15 min by the margin scan and STAMPED on every paper row so the
// three pre-registered hypotheses (scripts/study-derivatives-edge.ts) can be read against
// outcomes. Research only: nothing here gates an entry, sizes a trade, or is read by the
// executor or the guardian. A dead feed stamps NULLs; it can never block anything.
//
// SOURCES AND UNITS — verified by hand on 2026-09-15 15:34Z (curl, no key):
//
//   Kraken Futures  GET https://futures.kraken.com/derivatives/api/v3/tickers
//     tickers[] for the multi-collateral perps "PF_<BASE>USD" (BTC is PF_XBTUSD). All 26 US-margin
//     coins have one. Fields used:
//       markPrice            USD
//       openInterest         BASE UNITS (contract = 1 unit; PF_XBTUSD 1894.6 = 1,894.6 BTC ≈ $145M)
//       fundingRate          ABSOLUTE funding, USD per 1 base unit PER HOUR — NOT a fraction.
//                            Kraken's own /api/v4/historicalfundingrates confirms it:
//                            fundingRate 1.75590 at markPrice 76,340 ↔ relativeFundingRate
//                            2.3138e-05 (= 1.75590 / 76,340), hourly rows.
//       fundingRatePrediction same unit, the next hour's estimate.
//     → funding8hRel = fundingRate / markPrice × 8 (relative, per 8h — the unit the rest of the
//       industry quotes; +0.01%/8h ≈ +11%/yr). Raw values are stored beside it untouched.
//     The legacy inverse "PI_" contracts carry a fraction-looking fundingRate (5.7e-10) in a
//     different unit; they are ignored — only PF_ symbols are parsed.
//
//   Bybit  GET https://api.bybit.com/v5/market/tickers?category=linear   (fallback for gaps)
//     result.list[] with symbol "<BASE>USDT": markPrice (USDT), openInterest (base units),
//     openInterestValue (USDT), fundingRate (a FRACTION per funding interval — 8h on the majors,
//     shorter on some alts; treated as per-8h here, which overstates funding on 4h/1h coins).
//     ⚠️ Bybit is GEO-BLOCKED from US IPs (CloudFront 403 on 2026-09-15 from this machine); the
//     parser is built from the documented v5 shape and the fetch is expected to fail-soft in
//     production. Kraken Futures covers all 26 today, so Bybit is a spare, not a dependency.
//
//   Fear & Greed  GET https://api.alternative.me/fng/?limit=1  → data[0].value "0".."100",
//     value_classification, timestamp (epoch seconds, daily). Stored on the latest key only.
//
// LIQUIDATIONS: there is no free liquidation feed. The proxy this desk uses is an OI DROP of
// ≥5% over 24h coinciding with a price move (positions forced out, not opened) — hypothesis H3
// in the study script, computed from the snapshot table, never from a feed.
import { prisma } from "@/lib/db";
import { SCAN_UNIVERSE } from "@/lib/kraken-pairs";

export const KF_TICKERS_URL = "https://futures.kraken.com/derivatives/api/v3/tickers";
export const BYBIT_TICKERS_URL = "https://api.bybit.com/v5/market/tickers?category=linear";
export const FNG_URL = "https://api.alternative.me/fng/?limit=1";
export const FETCH_TIMEOUT_MS = 8_000;
export const SNAPSHOT_MIN_INTERVAL_MS = 15 * 60_000;
export const DERIV_LATEST_KEY = "kraken_margin_derivatives_latest";
/** Hours of funding per normalised period; Kraken's rate is hourly. */
export const KF_FUNDING_HOURS = 1;
export const FUNDING_PERIOD_HOURS = 8;
/** H3's liquidation proxy: OI down ≥5% in 24h. */
export const OI_DROP_PROXY = -0.05;

export type DerivSource = "kraken-futures" | "bybit";
export interface DerivTicker {
  coin: string;
  source: DerivSource;
  funding: number;              // RAW, in the source's unit (see header)
  fundingPred: number | null;   // RAW, Kraken only
  funding8hRel: number | null;  // normalised: relative funding per 8h
  oi: number;                   // base units
  oiUsd: number | null;         // oi × mark
  mark: number;
  raw: Record<string, unknown>;
}

/** Every scanned coin → its Kraken Futures perp and Bybit linear symbol. */
export const SYMBOL_MAP: Record<string, { kf: string; bybit: string }> = Object.fromEntries(
  SCAN_UNIVERSE.map((c) => [c, { kf: `PF_${c === "BTC" ? "XBT" : c}USD`, bybit: `${c}USDT` }]),
);
const KF_TO_COIN: Record<string, string> = Object.fromEntries(Object.entries(SYMBOL_MAP).map(([c, m]) => [m.kf, c]));
const BYBIT_TO_COIN: Record<string, string> = Object.fromEntries(Object.entries(SYMBOL_MAP).map(([c, m]) => [m.bybit, c]));

const num = (x: unknown): number | null => {
  const n = typeof x === "number" ? x : typeof x === "string" ? parseFloat(x) : NaN;
  return Number.isFinite(n) ? n : null;
};

/** Pure: the Kraken Futures payload → tickers for the coins in SYMBOL_MAP. Never throws. */
export function parseKrakenFuturesTickers(payload: unknown): DerivTicker[] {
  const out: DerivTicker[] = [];
  const list = (payload as { tickers?: unknown[] } | null)?.tickers;
  if (!Array.isArray(list)) return out;
  for (const t of list) {
    const r = t as Record<string, unknown>;
    const coin = KF_TO_COIN[String(r.symbol ?? "")];
    if (!coin) continue;
    const mark = num(r.markPrice); const oi = num(r.openInterest); const funding = num(r.fundingRate);
    if (mark == null || !(mark > 0) || oi == null || funding == null) continue;
    out.push({
      coin, source: "kraken-futures", funding, fundingPred: num(r.fundingRatePrediction),
      funding8hRel: (funding / mark) * (FUNDING_PERIOD_HOURS / KF_FUNDING_HOURS),
      oi, oiUsd: oi * mark, mark, raw: r,
    });
  }
  return out;
}

/** Pure: the Bybit v5 linear payload → tickers for the coins in SYMBOL_MAP. Never throws. */
export function parseBybitLinearTickers(payload: unknown): DerivTicker[] {
  const out: DerivTicker[] = [];
  const list = (payload as { result?: { list?: unknown[] } } | null)?.result?.list;
  if (!Array.isArray(list)) return out;
  for (const t of list) {
    const r = t as Record<string, unknown>;
    const coin = BYBIT_TO_COIN[String(r.symbol ?? "")];
    if (!coin) continue;
    const mark = num(r.markPrice) ?? num(r.lastPrice); const oi = num(r.openInterest); const funding = num(r.fundingRate);
    if (mark == null || !(mark > 0) || oi == null || funding == null) continue;
    out.push({ coin, source: "bybit", funding, fundingPred: null, funding8hRel: funding, oi, oiUsd: num(r.openInterestValue) ?? oi * mark, mark, raw: r });
  }
  return out;
}

async function fetchJson(url: string): Promise<unknown> {
  const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

/** Never throws: [] on any failure (timeout, geo-block, bad JSON). */
export async function fetchKrakenFuturesTickers(): Promise<DerivTicker[]> {
  try { return parseKrakenFuturesTickers(await fetchJson(KF_TICKERS_URL)); } catch { return []; }
}
export async function fetchBybitLinearTickers(): Promise<DerivTicker[]> {
  try { return parseBybitLinearTickers(await fetchJson(BYBIT_TICKERS_URL)); } catch { return []; }
}

export interface FearGreed { value: number; label: string; at: string }
/** Pure. */
export function parseFearGreed(payload: unknown): FearGreed | null {
  const d = (payload as { data?: unknown[] } | null)?.data?.[0] as Record<string, unknown> | undefined;
  const value = num(d?.value);
  if (!d || value == null) return null;
  const ts = num(d.timestamp);
  return { value, label: String(d.value_classification ?? ""), at: ts != null ? new Date(ts * 1000).toISOString() : new Date().toISOString() };
}
export async function fetchFearGreed(): Promise<FearGreed | null> {
  try { return parseFearGreed(await fetchJson(FNG_URL)); } catch { return null; }
}

/** Pure: Kraken Futures wins; Bybit fills coins Kraken lacks. Keyed by coin. */
export function normalizeDerivatives(kf: DerivTicker[], bybit: DerivTicker[]): Record<string, DerivTicker> {
  const out: Record<string, DerivTicker> = {};
  for (const t of kf) if (t.coin in SYMBOL_MAP) out[t.coin] = t;
  for (const t of bybit) if (t.coin in SYMBOL_MAP && !out[t.coin]) out[t.coin] = t;
  return out;
}

/** Pure: fractional change of OI vs a prior reading; null when either side is unusable. */
export function oiChange24h(nowOi: number | null | undefined, priorOi: number | null | undefined): number | null {
  if (nowOi == null || priorOi == null || !Number.isFinite(nowOi) || !Number.isFinite(priorOi) || !(priorOi > 0)) return null;
  return nowOi / priorOi - 1;
}

// ---------- persistence ----------
const TABLE_SQL = `CREATE TABLE IF NOT EXISTS margin_derivatives_snapshots (
  id serial PRIMARY KEY,
  at timestamptz NOT NULL DEFAULT now(),
  coin text NOT NULL,
  source text NOT NULL,
  funding double precision,
  funding_pred double precision,
  oi double precision,
  mark double precision,
  raw jsonb
)`;
const INDEX_SQL = `CREATE INDEX IF NOT EXISTS margin_derivatives_snapshots_coin_at_idx ON margin_derivatives_snapshots(coin, at)`;
let tableReady: Promise<void> | null = null;
function ensureDerivTable(): Promise<void> {
  if (!tableReady) {
    tableReady = (async () => { await prisma.$executeRawUnsafe(TABLE_SQL); await prisma.$executeRawUnsafe(INDEX_SQL); })()
      .catch((e) => { tableReady = null; throw e; });
  }
  return tableReady;
}

/** What each coin's stamp carries; deriv_funding = funding8hRel, deriv_oi = base units. */
export interface DerivCoin {
  source: DerivSource;
  funding: number;              // raw (source unit)
  funding8hRel: number | null;
  fundingPred: number | null;
  oi: number;
  oiUsd: number | null;
  mark: number;
  oiChg24h: number | null;      // vs the newest snapshot ≥20h old (null until one exists)
}
export interface DerivLatest {
  at: string;
  coverage: string;             // "n/26"
  covered: number;
  universe: number;
  byCoin: Record<string, DerivCoin>;
  fearGreed: FearGreed | null;
  errors: string[];
}

/** The newest snapshot per coin that is at least 20h (and at most 30h) old — the 24h baseline. */
async function priorOiByCoin(nowMs: number): Promise<Record<string, number>> {
  const rows = await prisma.$queryRawUnsafe<{ coin: string; oi: number | null }[]>(
    `SELECT DISTINCT ON (coin) coin, oi FROM margin_derivatives_snapshots
     WHERE at <= $1::timestamptz - interval '20 hours' AND at >= $1::timestamptz - interval '30 hours'
     ORDER BY coin, at DESC`,
    new Date(nowMs).toISOString(),
  );
  const out: Record<string, number> = {};
  for (const r of rows) if (r.oi != null && Number.isFinite(r.oi)) out[r.coin] = r.oi;
  return out;
}

export async function readLatestDerivatives(): Promise<DerivLatest | null> {
  try {
    const raw = (await prisma.agentConfig.findUnique({ where: { key: DERIV_LATEST_KEY } }))?.value;
    if (!raw) return null;
    const p = JSON.parse(raw) as DerivLatest;
    return p && typeof p.at === "string" && p.byCoin && typeof p.byCoin === "object" ? p : null;
  } catch { return null; }
}

export interface SnapshotResult { ran: boolean; reason: string; latest: DerivLatest | null }

/**
 * Fetch → normalise → insert one row per coin → write the latest key. Throttled to one run per
 * SNAPSHOT_MIN_INTERVAL_MS (the scan runs every 5 min); `deadlineMs` skips the run when the route
 * has <20s left. NEVER throws: every failure is a reason string and the stale latest key.
 */
export async function snapshotDerivatives(opts: { nowMs?: number; deadlineMs?: number; force?: boolean } = {}): Promise<SnapshotResult> {
  const nowMs = opts.nowMs ?? Date.now();
  try {
    const prev = await readLatestDerivatives();
    if (!opts.force && prev && nowMs - Date.parse(prev.at) < SNAPSHOT_MIN_INTERVAL_MS) return { ran: false, reason: `snapshot ${Math.round((nowMs - Date.parse(prev.at)) / 60_000)} min old`, latest: prev };
    if (opts.deadlineMs != null && opts.deadlineMs - nowMs < 20_000) return { ran: false, reason: "route deadline — skipped", latest: prev };
    const errors: string[] = [];
    const kf = await fetchKrakenFuturesTickers();
    if (kf.length === 0) errors.push("kraken-futures: no tickers");
    // Bybit only when Kraken left gaps (it is geo-blocked from US IPs and usually fails anyway).
    const missing = SCAN_UNIVERSE.filter((c) => !kf.some((t) => t.coin === c));
    const bybit = missing.length ? await fetchBybitLinearTickers() : [];
    if (missing.length && bybit.length === 0) errors.push("bybit: no tickers");
    const byTicker = normalizeDerivatives(kf, bybit);
    const fearGreed = await fetchFearGreed();
    if (!fearGreed) errors.push("fear-greed: unavailable");
    await ensureDerivTable();
    const prior = await priorOiByCoin(nowMs).catch(() => ({} as Record<string, number>));
    const at = new Date(nowMs).toISOString();
    const byCoin: Record<string, DerivCoin> = {};
    for (const t of Object.values(byTicker)) {
      byCoin[t.coin] = { source: t.source, funding: t.funding, funding8hRel: t.funding8hRel, fundingPred: t.fundingPred, oi: t.oi, oiUsd: t.oiUsd, mark: t.mark, oiChg24h: oiChange24h(t.oi, prior[t.coin]) };
      await prisma.$executeRawUnsafe(
        `INSERT INTO margin_derivatives_snapshots (at, coin, source, funding, funding_pred, oi, mark, raw) VALUES ($1::timestamptz,$2,$3,$4,$5,$6,$7,$8::jsonb)`,
        at, t.coin, t.source, t.funding, t.fundingPred, t.oi, t.mark, JSON.stringify(t.raw),
      ).catch((e) => errors.push(`insert ${t.coin}: ${String(e).slice(0, 60)}`));
    }
    const covered = Object.keys(byCoin).length;
    const latest: DerivLatest = { at, coverage: `${covered}/${SCAN_UNIVERSE.length}`, covered, universe: SCAN_UNIVERSE.length, byCoin, fearGreed: fearGreed ?? prev?.fearGreed ?? null, errors };
    if (covered === 0 && prev) return { ran: true, reason: "no coverage — latest key kept", latest: { ...prev, errors } };
    await prisma.agentConfig.upsert({ where: { key: DERIV_LATEST_KEY }, update: { value: JSON.stringify(latest) }, create: { key: DERIV_LATEST_KEY, value: JSON.stringify(latest) } });
    return { ran: true, reason: `snapshotted ${latest.coverage}`, latest };
  } catch (e) {
    return { ran: false, reason: `derivatives: ${String(e).slice(0, 80)}`, latest: null };
  }
}
