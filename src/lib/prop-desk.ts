// THE PROP DESK — swing-lev's signals on the Tradeify 247 account, under Tradeify's rules.
//
// Two entry points, both called by crons:
//   propEntry()  — margin-scan hands it the SAME high-conviction 4h breakout plan it hands the
//                  Kraken executor. It sizes by prop-rules.ts and opens WITH the stop attached
//                  (one request, never naked). Long only. One position. One entry per day.
//   propGuard()  — prop-watch, every 5 minutes: takes the 22:00 UTC snapshot, watches the two
//                  floors, trails stops exactly as paper's container does (breakeven at +1R,
//                  1R behind the peak, from completed Kraken 1-min bars), closes at max hold,
//                  re-protects a naked position, notices closes, keeps the account alive.
//
// Broker truth comes from DXtrade (metrics, positions, orders, history). Prices come from
// Kraken — DXtrade's market-data endpoint is not permitted for this login. Rules come from
// prop-rules.ts and nowhere else.
//
// STATE. The two crons overlap in wall time (margin-scan can run 5 minutes), so nothing that
// decides risk lives ONLY in the shared JSON blob: the day's entry count is read from the
// broker's order history and the ledger table (both append-only, both atomic), the JSON
// counter is a third vote; entries are serialised by a DB lock; the blob is saved by merge,
// never blind overwrite. The ledger is the raw table `prop_trades` (engine tables are raw SQL
// here — never `prisma db push`).
import { prisma } from "@/lib/db";
import { sendNotification } from "@/lib/notifications";
import { getKrakenOHLC } from "@/lib/kraken-margin";
import { exitParams, managedStop } from "@/lib/margin-shadow";
import {
  DxError, dxAccount, dxAccountStatus, dxAttachStop, dxCancelOrder, dxClosePosition, dxConfigured, dxInstrument, dxMetrics, dxModifyStop,
  dxOpenOrders, dxOpenWithStop, dxOrderHistory, dxPositions, dxQuantityStep, type DxAccountStatus, type DxMetrics, type DxOrder, type DxPosition,
} from "@/lib/dxtrade";
import {
  PROP_RISK_BASE_PCT, PROP_RISK_MAX_PCT, PROP_STOP_FRAC, PROP_LATE_SNAPSHOT_MS, TRADEIFY_2STEP_100K,
  fmtQty, keepAliveDue, msSinceReset, phaseProgress, propBreachState, propDayKey, propFloors, propRoom, propSize, sizingFloors, stopPriceFor, unitsFor,
  type PropBreachState, type PropFloors, type PropPlan,
} from "@/lib/prop-rules";

export const PROP_STATE_KEY = "prop_desk_state";
export const PROP_ARM_LOG_KEY = "prop_arm_log";
export const PROP_ENTRY_LOCK_KEY = "prop_entry_lock";
export const PROP_SOURCE_DEFAULT = "swing-lev";
export const PROP_GUARDIAN_FRESH_MS = 15 * 60_000;
// propEntry needs the broker several times plus a 2.5s settle; with 8s timeouts and retries
// a bad broker minute is ~45s. Refuse when the calling route has less than this left.
export const PROP_ENTRY_MIN_ROUTE_MS = 60_000;
const ENTRY_LOCK_TTL_MS = 300_000;   // ≥ the calling route's maxDuration
const BALANCE_WITNESS_FRESH_MS = 15 * 60_000;
const SETTLE_MISSES_MAX = 3;
const REALERT_MS = 60 * 60_000;
const ORDER_PREFIX = "pd";
const META = { desk: "prop" };
const KEEPALIVE_REASON = "keep-alive";

export interface ManagedPosition {
  symbol: string; coin: string; source: string; entry: number; oneR: number; peak: number; seenT: number;
  stop: number; openedAt: string; qty: number; ledgerId: number | null;
  stopFails?: number;   // consecutive runs the stop could not be moved/attached
  settleMisses?: number; // runs the close could not be found in history yet
}
export interface PropState {
  alerts: Record<string, string>;
  snapshot?: { dayKey: string; balance: number; at: string; estimated?: boolean };
  lastBalance?: { balance: number; at: string };  // closed balance at the last guardian run (pre-reset witness)
  entries?: Record<string, number>;               // dayKey → entries placed (third vote only)
  managed?: Record<string, ManagedPosition>;      // positionCode → container
  lastTradeAt?: string;
  phase?: number;                                 // 1-based; targets.length+1 = funded
  guardianAt?: string;
  lastEquity?: number;
  breach?: { state: PropBreachState; at: string };
  disarmed?: { reason: string; at: string };
  foreign?: Record<string, number>;               // positionCode → runs seen (not ours)
}

export async function cfg(key: string): Promise<string | null> {
  const row = await prisma.agentConfig.findUnique({ where: { key } }).catch(() => null);
  return row?.value ?? null;
}
async function cfgStrict(key: string): Promise<string | null> {
  const row = await prisma.agentConfig.findUnique({ where: { key } });
  return row?.value ?? null;
}
async function setKey(key: string, value: string): Promise<void> {
  await prisma.agentConfig.upsert({ where: { key }, update: { value }, create: { key, value } });
}
function num(v: string | null, fallback: number): number {
  if (v == null || v.trim() === "") return fallback;
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : fallback;
}

export interface PropConfig {
  armed: boolean; sources: string[]; riskBasePct: number; riskMaxPct: number; maxPositions: number; maxEntriesPerDay: number; plan: PropPlan;
}
/**
 * Slots and entries-per-day are PINNED at 1, not read from config: propSize does not yet
 * subtract the risk committed in an open position from the room, so two stop-outs in one
 * day ($1,642 each with slip) would exceed the $3,000 daily limit. Unpin only after that.
 */
export async function propConfig(): Promise<PropConfig> {
  const [armed, sources, base, max] = await Promise.all([cfg("prop_armed"), cfg("prop_live_sources"), cfg("prop_risk_base_pct"), cfg("prop_risk_max_pct")]);
  return {
    armed: armed === "true",
    sources: (sources ?? PROP_SOURCE_DEFAULT).split(",").map((s) => s.trim()).filter(Boolean),
    riskBasePct: Math.min(PROP_RISK_MAX_PCT, num(base, PROP_RISK_BASE_PCT)),
    riskMaxPct: Math.min(PROP_RISK_MAX_PCT, num(max, PROP_RISK_MAX_PCT)),
    maxPositions: 1,
    maxEntriesPerDay: 1,
    plan: TRADEIFY_2STEP_100K,
  };
}

// ---- state --------------------------------------------------------------------------------
function normalise(raw: unknown): PropState {
  const p = (raw && typeof raw === "object" ? raw : {}) as PropState;
  const managed: Record<string, ManagedPosition> = {};
  for (const [k, v] of Object.entries(p.managed ?? {})) {
    const m = v as Partial<ManagedPosition>;
    if (typeof m.entry === "number" && m.entry > 0 && typeof m.oneR === "number" && m.oneR > 0 && typeof m.peak === "number" && typeof m.stop === "number" && typeof m.symbol === "string") {
      const openedAt = typeof m.openedAt === "string" && !Number.isNaN(Date.parse(m.openedAt)) ? m.openedAt : new Date().toISOString();
      managed[k] = { symbol: m.symbol, coin: m.coin ?? m.symbol.split("/")[0], source: m.source ?? PROP_SOURCE_DEFAULT, entry: m.entry, oneR: m.oneR, peak: m.peak, seenT: typeof m.seenT === "number" ? m.seenT : 0, stop: m.stop, openedAt, qty: typeof m.qty === "number" ? m.qty : 0, ledgerId: typeof m.ledgerId === "number" ? m.ledgerId : null, stopFails: typeof m.stopFails === "number" ? m.stopFails : 0, settleMisses: typeof m.settleMisses === "number" ? m.settleMisses : 0 };
    }
  }
  const lb = p.lastBalance as unknown;
  const lastBalance = lb && typeof lb === "object" && typeof (lb as { balance?: unknown }).balance === "number" && typeof (lb as { at?: unknown }).at === "string" ? (lb as { balance: number; at: string }) : undefined;
  return { ...p, lastBalance, alerts: p.alerts && typeof p.alerts === "object" ? p.alerts : {}, managed, entries: p.entries && typeof p.entries === "object" ? p.entries : {}, foreign: p.foreign && typeof p.foreign === "object" ? p.foreign : {} };
}
export async function loadState(): Promise<{ state: PropState; unreliable: boolean }> {
  let row: { value: string } | null = null;
  try { row = await prisma.agentConfig.findUnique({ where: { key: PROP_STATE_KEY } }); }
  catch { return { state: { alerts: {} }, unreliable: true }; }
  if (!row?.value) return { state: { alerts: {} }, unreliable: false };
  try { return { state: normalise(JSON.parse(row.value)), unreliable: false }; }
  catch {
    await setKey(`${PROP_STATE_KEY}_corrupt_backup`, row.value).catch(() => {});
    await sendNotification("🚨 prop_desk_state was CORRUPT and has been reset (raw value in prop_desk_state_corrupt_backup). Positions are re-adopted from the broker; the day counter is re-read from order history.", "prop").catch(() => {});
    return { state: { alerts: {} }, unreliable: false };
  }
}
/**
 * Save by MERGE: re-read the row and take, field by field, whichever copy knows more. The
 * day counters take the max; managed positions are the union, minus any the caller settled
 * (they carry `settled`), so a concurrent guardian save can neither resurrect a closed
 * position nor drop a freshly opened one.
 */
async function saveState(mine: PropState, settled: string[] = []): Promise<void> {
  const keys = Object.keys(mine.entries ?? {}).sort();
  if (keys.length > 14) for (const k of keys.slice(0, keys.length - 14)) delete mine.entries![k];
  let fresh: PropState | null = null;
  try { const row = await prisma.agentConfig.findUnique({ where: { key: PROP_STATE_KEY } }); fresh = row?.value ? normalise(JSON.parse(row.value)) : null; } catch { fresh = null; }
  // Guardian-owned scalars (snapshot, balance witness, stamp, breach) belong to whichever copy
  // ran the guardian later — a copy loaded 100s ago must not revert a fresh snapshot.
  const mineG = mine.guardianAt ? Date.parse(mine.guardianAt) : 0, freshG = fresh?.guardianAt ? Date.parse(fresh.guardianAt) : 0;
  const newer = mineG >= freshG ? mine : fresh!;
  const out: PropState = { ...(fresh ?? {}), ...mine, alerts: { ...(fresh?.alerts ?? {}), ...mine.alerts } };
  if (fresh) { out.snapshot = newer.snapshot; out.lastBalance = newer.lastBalance; out.guardianAt = newer.guardianAt; out.breach = newer.breach; out.lastEquity = newer.lastEquity; }
  const entries: Record<string, number> = { ...(mine.entries ?? {}) };
  for (const [k, v] of Object.entries(fresh?.entries ?? {})) entries[k] = Math.max(entries[k] ?? 0, v);
  out.entries = entries;
  const managed: Record<string, ManagedPosition> = { ...(fresh?.managed ?? {}), ...(mine.managed ?? {}) };
  for (const k of settled) delete managed[k];
  out.managed = managed;
  const lt = [mine.lastTradeAt, fresh?.lastTradeAt].filter((x): x is string => typeof x === "string").sort();
  if (lt.length) out.lastTradeAt = lt[lt.length - 1];
  await setKey(PROP_STATE_KEY, JSON.stringify(out));
}
/** Field-scoped write: load the freshest row, apply `patch`, save by merge. For non-guardian callers. */
async function patchState(patch: (s: PropState) => void, settled: string[] = []): Promise<void> {
  const { state, unreliable } = await loadState();
  if (unreliable) return;
  patch(state);
  await saveState(state, settled);
}
function shouldFire(state: PropState, key: string, everyMs = REALERT_MS): boolean {
  const last = state.alerts[key];
  return !last || Date.now() - new Date(last).getTime() >= everyMs;
}
async function alert(state: PropState, key: string, text: string, everyMs = REALERT_MS): Promise<boolean> {
  if (!shouldFire(state, key, everyMs)) return false;
  await sendNotification(text, "prop");
  state.alerts[key] = new Date().toISOString();
  return true;
}

// ---- entry lock (serialises propEntry across overlapping scan runs) -----------------------
/** Compare-and-set on the row's current value: two racers cannot both win. */
async function acquireEntryLock(): Promise<string | null> {
  const token = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const now = Date.now();
  try {
    const row = await prisma.agentConfig.findUnique({ where: { key: PROP_ENTRY_LOCK_KEY } });
    if (!row) {
      try { await prisma.agentConfig.create({ data: { key: PROP_ENTRY_LOCK_KEY, value: `${token}@${now}` } }); return token; }
      catch { return null; }   // someone created it first
    }
    const [, at] = row.value.split("@");
    if (row.value && at && now - Number(at) < ENTRY_LOCK_TTL_MS) return null;
    const r = await prisma.agentConfig.updateMany({ where: { key: PROP_ENTRY_LOCK_KEY, value: row.value }, data: { value: `${token}@${now}` } });
    return r.count === 1 ? token : null;
  } catch { return null; }
}
async function releaseEntryLock(token: string): Promise<void> {
  try {
    const row = await prisma.agentConfig.findUnique({ where: { key: PROP_ENTRY_LOCK_KEY } });
    if (row?.value?.startsWith(token)) await setKey(PROP_ENTRY_LOCK_KEY, "");
  } catch { /* expires by TTL */ }
}

// ---- ledger -------------------------------------------------------------------------------
let ledgerReady = false;
export async function ensurePropTables(): Promise<void> {
  if (ledgerReady) return;
  await prisma.$executeRawUnsafe(`CREATE TABLE IF NOT EXISTS prop_trades (
    id SERIAL PRIMARY KEY,
    account TEXT NOT NULL,
    position_code TEXT NOT NULL UNIQUE,
    symbol TEXT NOT NULL,
    coin TEXT NOT NULL,
    side TEXT NOT NULL,
    source TEXT NOT NULL,
    tier TEXT,
    qty DOUBLE PRECISION NOT NULL,
    entry_px DOUBLE PRECISION NOT NULL,
    stop_px DOUBLE PRECISION NOT NULL,
    one_r DOUBLE PRECISION NOT NULL,
    risk_usd DOUBLE PRECISION NOT NULL,
    notional_usd DOUBLE PRECISION NOT NULL,
    risk_pct DOUBLE PRECISION NOT NULL,
    parent_order TEXT,
    stop_order TEXT,
    opened_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    closed_at TIMESTAMPTZ,
    exit_px DOUBLE PRECISION,
    pnl_usd DOUBLE PRECISION,
    exit_reason TEXT,
    note TEXT
  )`);
  ledgerReady = true;
}
export interface PropTradeRow {
  id: number; account: string; position_code: string; symbol: string; coin: string; side: string; source: string; tier: string | null;
  qty: number; entry_px: number; stop_px: number; one_r: number; risk_usd: number; notional_usd: number; risk_pct: number;
  parent_order: string | null; stop_order: string | null; opened_at: Date; closed_at: Date | null; exit_px: number | null; pnl_usd: number | null; exit_reason: string | null; note: string | null;
}
export async function propLedger(limit = 50): Promise<PropTradeRow[]> {
  await ensurePropTables();
  return prisma.$queryRawUnsafe<PropTradeRow[]>(`SELECT * FROM prop_trades ORDER BY opened_at DESC LIMIT ${Math.max(1, Math.min(500, limit))}`);
}
async function ledgerInsert(row: { positionCode: string; symbol: string; coin: string; source: string; tier: string | null; qty: number; entry: number; stop: number; oneR: number; riskUsd: number; notional: number; riskPct: number; parentOrder: string | null; stopOrder: string | null; openedAt: string; note: string }): Promise<number | null> {
  await ensurePropTables();
  const ins = await prisma.$queryRawUnsafe<{ id: number }[]>(
    `INSERT INTO prop_trades (account, position_code, symbol, coin, side, source, tier, qty, entry_px, stop_px, one_r, risk_usd, notional_usd, risk_pct, parent_order, stop_order, opened_at, note)
     VALUES ($1,$2,$3,$4,'buy',$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16::timestamptz,$17)
     ON CONFLICT (position_code) DO NOTHING RETURNING id`,
    dxAccount(), row.positionCode, row.symbol, row.coin, row.source, row.tier, row.qty, row.entry, row.stop, row.oneR, row.riskUsd, row.notional, row.riskPct, row.parentOrder, row.stopOrder, row.openedAt, row.note,
  );
  return ins[0]?.id ?? null;
}

// ---- floors from state --------------------------------------------------------------------
/**
 * Today's floors: the REAL ones (breach detection) and the ones SIZING plans against. Without
 * a snapshot for today the daily floor is unknown; take the conservative reading — the higher
 * of closed balance and equity — and treat the day as estimated (buffered for sizing).
 */
export function floorsFor(plan: PropPlan, state: PropState, m: DxMetrics, nowMs = Date.now()) {
  const dayKey = propDayKey(plan, nowMs);
  const known = state.snapshot?.dayKey === dayKey;
  const snap = known ? state.snapshot!.balance : Math.max(m.balance, m.equity);
  const estimated = !known || state.snapshot!.estimated === true;
  const floors = propFloors(plan, snap);
  return { dayKey, snapshotBalance: snap, known, estimated, floors, sizing: sizingFloors(plan, floors, estimated) };
}

// ---- the day's entry count, from broker truth ---------------------------------------------
// Ours = our metadata echoed back, OR our client order id prefix (pd… strategy, ka… keep-alive).
// The client id round-trips for certain (verified); metadata is belt-and-braces.
const isOurs = (o: DxOrder) => o.metadata?.desk === "prop" || /^(pd|ka)[osc]-/.test(o.clientOrderId ?? "");
const isKeepAlive = (o: DxOrder) => o.metadata?.reason === KEEPALIVE_REASON || /^ka[osc]-/.test(o.clientOrderId ?? "");
const isOurOpen = (o: DxOrder) => o.legs?.[0]?.positionEffect === "OPEN" && isOurs(o) && !isKeepAlive(o) && o.status !== "REJECTED" && o.status !== "CANCELED";
/** max(order history since the reset, ledger rows since the reset, the JSON counter). */
async function entriesToday(plan: PropPlan, state: PropState, dayKey: string, nowMs: number): Promise<{ n: number; sources: string }> {
  const resetIso = new Date(nowMs - msSinceReset(plan, nowMs)).toISOString();
  let hist = -1, ledger = -1;
  try { hist = (await dxOrderHistory(resetIso, 100)).filter(isOurOpen).length; } catch { hist = -1; }
  try {
    await ensurePropTables();
    const r = await prisma.$queryRawUnsafe<{ n: bigint }[]>(`SELECT count(*)::bigint AS n FROM prop_trades WHERE opened_at >= $1::timestamptz`, resetIso);
    ledger = Number(r[0]?.n ?? 0);
  } catch { ledger = -1; }
  const json = state.entries?.[dayKey] ?? 0;
  return { n: Math.max(hist, ledger, json), sources: `history ${hist < 0 ? "?" : hist} · ledger ${ledger < 0 ? "?" : ledger} · state ${json}` };
}

// ---- ENTRY --------------------------------------------------------------------------------
export interface PropEntryRequest {
  symbol: string;                // "BTC/USD"
  side: "buy" | "sell";
  source: string;
  tier: "low" | "med" | "high";
  entryPx: number;               // Kraken price the plan was scored at (chase included)
  deadlineMs?: number;
}
export interface PropEntryResult { executed: boolean; note: string; positionCode?: string }

export async function propEntry(req: PropEntryRequest): Promise<PropEntryResult> {
  const no = (note: string): PropEntryResult => ({ executed: false, note });
  if (!dxConfigured()) return no("prop desk not configured");
  const c = await propConfig();
  // The arm switch is read STRICT: a DB failure must read as "stop", never as "not disarmed".
  let armedRaw: string | null;
  try { armedRaw = await cfgStrict("prop_armed"); } catch { return no("prop_armed unreadable — refusing"); }
  if (armedRaw !== "true") return no("prop desk not armed");
  if (!c.sources.includes(req.source)) return no(`${req.source} is not armed for prop (${c.sources.join(",")})`);
  if (req.source !== PROP_SOURCE_DEFAULT) return no(`${req.source} has no prop container`);
  if (req.side !== "buy") return no("prop desk is long-only");
  if (req.tier !== "high") return no(`${req.tier} conviction — prop trades high only`);
  if (req.deadlineMs != null && req.deadlineMs - Date.now() < PROP_ENTRY_MIN_ROUTE_MS) return no("not enough route time left to place and record");

  const lock = await acquireEntryLock();
  if (!lock) return no("another prop entry is in flight");
  try {
    const { state, unreliable } = await loadState();
    if (unreliable) return no("prop state unreadable — refusing");
    if (state.disarmed) return no(`prop desk disarmed: ${state.disarmed.reason}`);
    const gAt = state.guardianAt ? new Date(state.guardianAt).getTime() : 0;
    if (Date.now() - gAt > PROP_GUARDIAN_FRESH_MS) return no(`guardian stale (${gAt ? Math.round((Date.now() - gAt) / 60000) + "m" : "never ran"}) — refusing`);

    // Broker truth, read fresh: equity, every open position (ours or not), the day's floors.
    let m: DxMetrics, positions: DxPosition[];
    try { m = await dxMetrics(); positions = (await dxPositions()).positions; }
    catch (e) { return no(`broker unreadable: ${e instanceof DxError ? e.message : String(e)}`); }
    if (positions.length === 0 && m.openPositionsCount > 0) return no("positions read empty while metrics show open positions — refusing");
    if (positions.some((p) => p.symbol === req.symbol)) return no(`${req.symbol} already open on the account`);
    const nowMs = Date.now();
    const f = floorsFor(c.plan, state, m, nowMs);
    const breach = propBreachState(c.plan, m.equity, f.floors);
    if (breach === "breached") return no("account at or below a floor");
    if (breach === "urgent") return no("within 20% of a floor — no new risk");
    const today = await entriesToday(c.plan, state, f.dayKey, nowMs);
    const sized = propSize({
      plan: c.plan, equity: m.equity, floors: f.sizing, riskBasePct: c.riskBasePct, riskMaxPct: c.riskMaxPct, stopFrac: PROP_STOP_FRAC,
      entriesToday: today.n, maxEntriesPerDay: c.maxEntriesPerDay, openPositions: positions.length, maxPositions: c.maxPositions,
    });
    if (!sized.ok) return no(`${sized.reason} (${today.sources})`);

    const ins = await dxInstrument(req.symbol).catch(() => null);
    if (!ins) return no(`${req.symbol} not listed on the prop venue`);
    const tick = ins.priceIncrement > 0 ? ins.priceIncrement : 0.01;
    const step = dxQuantityStep(req.entryPx);
    const units = unitsFor(sized.notionalUsd, req.entryPx, step);
    const qtyStr = fmtQty(units, step);
    if (!(Number(qtyStr) > 0)) return no("quantity rounds to zero");
    const stopPx = stopPriceFor(req.entryPx, PROP_STOP_FRAC, tick);
    const coin = req.symbol.split("/")[0];

    // Count the entry in the JSON vote BEFORE sending (rolled back only on a definitive 4xx or
    // REJECTED). The broker-history and ledger votes cover the case where this write is lost.
    // Field-scoped: this must not carry a 100s-old snapshot over a fresh guardian's.
    await patchState((st) => { st.entries = { ...(st.entries ?? {}), [f.dayKey]: Math.max(st.entries?.[f.dayKey] ?? 0, today.n + 1) }; });

    let opened;
    try {
      opened = await dxOpenWithStop({ symbol: req.symbol, side: "BUY", quantity: qtyStr, stopPrice: stopPx, codePrefix: ORDER_PREFIX, metadata: { ...META, source: req.source, coin, stopFrac: String(PROP_STOP_FRAC) } });
    } catch (e) {
      const msg = e instanceof DxError ? `${e.status} ${e.code ?? ""} ${e.message}` : String(e);
      // A 4xx placed nothing — give the day's entry back. 5xx/0/timeout may have landed: keep it counted; the guardian adopts.
      if (e instanceof DxError && e.status >= 400 && e.status < 500) await uncountEntry(f.dayKey);
      await sendNotification(`⚠️ PROP entry ${req.symbol} REFUSED by DXtrade: ${msg.slice(0, 200)}`, "prop").catch(() => {});
      return no(`DXtrade refused: ${msg.slice(0, 200)}`);
    }
    const positionCode = String(opened.parent.orderId);
    // Confirm the fill and the stop from the broker's own position record.
    await new Promise((r) => setTimeout(r, 2500));
    let pos: DxPosition | undefined;
    try { pos = (await dxPositions()).positions.find((p) => p.positionCode === positionCode); } catch { pos = undefined; }
    if (!pos) {
      let why = "not on the book 2.5s after the send";
      try {
        const h = await dxOrderHistory(new Date(Date.now() - 120_000).toISOString(), 20);
        const o = h.find((x) => String(x.orderId) === positionCode);
        why = o?.executions?.find((x) => x.rejectReason)?.rejectReason ?? `${o?.status ?? "unknown"}`;
        if (o?.status === "REJECTED") await uncountEntry(f.dayKey);
      } catch { /* keep default */ }
      await sendNotification(`⚠️ PROP entry ${req.symbol} sent but no position: ${why}`, "prop").catch(() => {});
      return no(`sent, no position: ${why}`);
    }
    const entry = pos.openPrice > 0 ? pos.openPrice : req.entryPx;
    const oneR = entry * PROP_STOP_FRAC;
    // A rejected STOP child would leave the position naked for a guardian cycle — protect now.
    let stopOn = pos.stopLossPrice ?? null;
    if (!stopOn) {
      try { await dxAttachStop({ symbol: req.symbol, positionCode, positionSide: "BUY", stopPrice: stopPx, codePrefix: ORDER_PREFIX, metadata: { ...META, reason: "re-protect" } }); stopOn = stopPx; }
      catch (e) { await sendNotification(`🚨 PROP ${coin}: position opened but its stop was REJECTED and re-protect failed: ${String(e).slice(0, 120)} — the guardian retries in ≤5 min.`, "prop").catch(() => {}); }
    }
    let ledgerId: number | null = null;
    try { ledgerId = await ledgerInsert({ positionCode, symbol: req.symbol, coin, source: req.source, tier: req.tier, qty: pos.quantity, entry, stop: stopOn ?? stopPx, oneR, riskUsd: sized.riskUsd, notional: pos.quantity * entry, riskPct: sized.riskPct, parentOrder: opened.parentCode, stopOrder: opened.stopCode, openedAt: pos.openTime, note: sized.reason }); }
    catch (e) { await sendNotification(`⚠️ PROP ledger write failed for ${req.symbol} ${positionCode}: ${String(e).slice(0, 120)} — the guardian still manages it from state`, "prop").catch(() => {}); }
    await patchState((st) => {
      st.managed = { ...(st.managed ?? {}), [positionCode]: { symbol: req.symbol, coin, source: req.source, entry, oneR, peak: entry, seenT: Math.floor(Date.now() / 1000), stop: stopOn ?? stopPx, openedAt: pos.openTime, qty: pos.quantity, ledgerId, stopFails: 0, settleMisses: 0 } };
      st.lastTradeAt = new Date().toISOString();   // AFTER a confirmed fill, never before
    });
    await sendNotification(
      `🟢 PROP LONG ${coin} · ${pos.quantity} @ $${entry} ($${Math.round(pos.quantity * entry).toLocaleString()}) · stop $${stopOn ?? "NONE"} · risk $${Math.round(sized.riskUsd)} (${sized.riskPct.toFixed(2)}% · ${sized.reason}) · room today $${Math.round(propRoom(c.plan, m.equity, f.floors).dailyRoom).toLocaleString()}`,
      "prop",
    ).catch(() => {});
    return { executed: true, note: `prop long ${coin} ${pos.quantity} @ ${entry}, stop ${stopOn ?? "NONE"}`, positionCode };
  } finally {
    await releaseEntryLock(lock);
  }
}

async function uncountEntry(dayKey: string): Promise<void> {
  // saveState merges counters by MAX, which would undo a decrement — so this one write goes
  // straight to the row, but on the freshest copy and touching only the counter.
  const { state, unreliable } = await loadState();
  if (unreliable) return;
  const n = state.entries?.[dayKey] ?? 0;
  if (n > 0) { state.entries = { ...(state.entries ?? {}), [dayKey]: n - 1 }; await setKey(PROP_STATE_KEY, JSON.stringify(state)); }
}

// ---- GUARDIAN -----------------------------------------------------------------------------
export interface PropGuardReport { ok: boolean; notes: string[]; errors: string[]; equity?: number; breach?: PropBreachState }

export async function propGuard(): Promise<PropGuardReport> {
  const notes: string[] = [], errors: string[] = [];
  if (!dxConfigured()) return { ok: false, notes, errors: ["not configured"] };
  const c = await propConfig();
  const plan = c.plan;
  const { state, unreliable } = await loadState();
  if (unreliable) return { ok: false, notes, errors: ["state unreadable — nothing done, nothing saved"] };
  const nowMs = Date.now();

  // Orders BEFORE positions: a stop that fills between the two reads then shows as "position
  // gone" (settled by 4c), never as "position without a stop" (which 4b would re-protect).
  let m: DxMetrics, positions: DxPosition[], orders: DxOrder[], ordersEtag: string | null, acct: DxAccountStatus | null = null;
  try {
    m = await dxMetrics();
    ({ orders, etag: ordersEtag } = await dxOpenOrders());
    ({ positions } = await dxPositions());
    if (!state.lastTradeAt) acct = await dxAccountStatus().catch(() => null);
  } catch (e) {
    const msg = e instanceof DxError ? `${e.status} ${e.message}` : String(e);
    errors.push(`broker read failed: ${msg.slice(0, 160)}`);
    await alert(state, "broker-down", `🔴 PROP guardian could not read DXtrade: ${msg.slice(0, 160)} — positions unknown, not flat.`, 30 * 60_000);
    await saveState(state);   // alerts only; no stamp → the executor refuses entries
    return { ok: false, notes, errors };
  }
  if (positions.length === 0 && m.openPositionsCount > 0) {
    errors.push(`positions read EMPTY while metrics show ${m.openPositionsCount} open — treating as a failed read`);
    await alert(state, "empty-positions", `🔴 PROP guardian: positions came back empty while the account shows ${m.openPositionsCount} open. Not flat — skipping this run.`, 30 * 60_000);
    await saveState(state);
    return { ok: false, notes, errors };
  }

  // 1. The 22:00 UTC snapshot. Tradeify snapshots the CLOSED balance exactly at the reset; the
  //    guardian sees it up to 5 minutes later, after a stop may already have filled. With one
  //    slot at most one close can fall in that window, so max(last run's balance, this run's)
  //    is exact or conservative. A LATE first read (outage) is marked estimated.
  const dayKey = propDayKey(plan, nowMs);
  if (state.snapshot?.dayKey !== dayKey) {
    const late = msSinceReset(plan, nowMs) > PROP_LATE_SNAPSHOT_MS;
    // The witness only counts if it is recent: after an outage it could be a stale HIGHER
    // balance that would inflate the floor into a false breach.
    const witness = state.lastBalance && nowMs - Date.parse(state.lastBalance.at) <= BALANCE_WITNESS_FRESH_MS ? state.lastBalance.balance : 0;
    const balance = Math.max(m.balance, witness);
    state.snapshot = { dayKey, balance, at: new Date(nowMs).toISOString(), estimated: late };
    notes.push(`snapshot ${dayKey} balance $${balance}${late ? " (LATE — estimated, +2.2% buffer for sizing)" : ""}`);
  }
  state.lastBalance = { balance: m.balance, at: new Date(nowMs).toISOString() };
  const floors: PropFloors = propFloors(plan, state.snapshot.balance);
  const room = propRoom(plan, m.equity, floors);
  const breach = propBreachState(plan, m.equity, floors);
  state.lastEquity = m.equity;
  state.breach = { state: breach, at: new Date(nowMs).toISOString() };

  // 2. Floors. A breach means Tradeify has (or will have) closed the account — disarm so the
  //    desk stops trying, and page every half hour until someone looks.
  if (breach === "breached") {
    if (!state.disarmed) { state.disarmed = { reason: `equity $${m.equity} at/below a floor (daily $${Math.round(floors.dailyFloor)}, max $${Math.round(floors.maxFloor)})`, at: new Date(nowMs).toISOString() }; await setKey("prop_armed", "false"); }
    await alert(state, "breached", `🚨 PROP ACCOUNT AT A FLOOR — equity $${m.equity.toLocaleString()} vs daily floor $${Math.round(floors.dailyFloor).toLocaleString()} / max floor $${Math.round(floors.maxFloor).toLocaleString()}. Desk disarmed.`, 30 * 60_000);
  } else if (breach === "urgent") {
    await alert(state, "urgent", `🔴 PROP equity $${m.equity.toLocaleString()} — room today $${Math.round(room.dailyRoom).toLocaleString()}, to max floor $${Math.round(room.maxRoom).toLocaleString()} (80%+ of a limit used).`, 15 * 60_000);
  } else if (breach === "warn") {
    await alert(state, "warn", `🟠 PROP equity $${m.equity.toLocaleString()} — room today $${Math.round(room.dailyRoom).toLocaleString()}, to max floor $${Math.round(room.maxRoom).toLocaleString()} (half a limit used).`);
  }

  // 3. Phase progress on CLOSED balance.
  const phase = state.phase ?? 1;
  const prog = phaseProgress(plan, phase, m.balance);
  if (prog.target != null && prog.remaining === 0) {
    await alert(state, `phase-${phase}`, `🎯 PROP phase ${phase} TARGET REACHED — balance $${m.balance.toLocaleString()}. Tradeify issues the next account; update TRADEIFY_DX_ACCOUNT/credentials on Vercel and bump prop phase.`, 6 * 3600_000);
  }

  // 4. Positions. Ours = in managed state, or carrying our metadata on the linked stop / the opener.
  const managed = state.managed ?? {};
  const byCode = new Map(positions.map((p) => [String(p.positionCode), p]));

  // 4a. Adopt positions our metadata opened but state never recorded (entry crashed after send).
  for (const p of positions) {
    const code = String(p.positionCode);
    if (managed[code]) continue;
    const linkedStop = orders.find((o) => String(o.legs?.[0]?.positionCode ?? "") === code && isOurs(o));
    let opener: DxOrder | undefined = linkedStop;
    if (!opener) {
      try { opener = (await dxOrderHistory(new Date(new Date(p.openTime).getTime() - 60_000).toISOString(), 100)).find((o) => String(o.orderId) === code && isOurs(o)); }
      catch { opener = undefined; }
    }
    if (!opener) {
      // Not ours: never touched. It DOES occupy the slot and DOES count against the floors.
      state.foreign = { ...(state.foreign ?? {}), [code]: (state.foreign?.[code] ?? 0) + 1 };
      if ((state.foreign[code] ?? 0) === 1) await alert(state, `foreign-${code}`, `ℹ️ PROP: a position the desk did not open is on the account (${p.symbol} ${p.side} ${p.quantity}). It uses the slot and counts against the floors; the desk will not manage it.`, 0);
      continue;
    }
    if (isKeepAlive(opener)) {
      // A keep-alive closes itself within ~25s. One still open minutes later is an orphan
      // (its close failed): it holds the one slot, so close it now.
      if (nowMs - Date.parse(p.openTime) > 2 * 60_000) {
        try { await dxClosePosition({ symbol: p.symbol, positionCode: code, positionSide: p.side, codePrefix: "ka", metadata: { ...META, reason: KEEPALIVE_REASON } }); notes.push(`orphaned keep-alive ${code} closed`); }
        catch (e) { errors.push(`orphaned keep-alive close failed ${String(e).slice(0, 80)}`); }
      }
      continue;
    }
    const entry = p.openPrice;
    const openedAt = !Number.isNaN(Date.parse(p.openTime)) ? p.openTime : new Date(nowMs).toISOString();
    const source = opener.metadata?.source ?? PROP_SOURCE_DEFAULT;
    let ledgerId: number | null = null;
    try { ledgerId = await ledgerInsert({ positionCode: code, symbol: p.symbol, coin: p.symbol.split("/")[0], source, tier: null, qty: p.quantity, entry, stop: p.stopLossPrice ?? entry * (1 - PROP_STOP_FRAC), oneR: entry * PROP_STOP_FRAC, riskUsd: p.quantity * entry * PROP_STOP_FRAC, notional: p.quantity * entry, riskPct: (p.quantity * entry * PROP_STOP_FRAC / plan.accountSize) * 100, parentOrder: opener.clientOrderId ?? null, stopOrder: linkedStop?.clientOrderId ?? null, openedAt, note: "adopted by the guardian" }); } catch { ledgerId = null; }
    managed[code] = { symbol: p.symbol, coin: p.symbol.split("/")[0], source, entry, oneR: entry * PROP_STOP_FRAC, peak: entry, seenT: Math.floor(new Date(openedAt).getTime() / 1000), stop: p.stopLossPrice ?? entry * (1 - PROP_STOP_FRAC), openedAt, qty: p.quantity, ledgerId, stopFails: 0 };
    notes.push(`adopted ${p.symbol} ${code}`);
  }

  // 4b. Manage ours: max hold → close; else peak from completed Kraken 1-min bars → trail.
  for (const [code, mp] of Object.entries(managed)) {
    const p = byCode.get(code);
    if (!p) continue;   // closed — handled in 4c
    const ex = exitParams(mp.source, 5, 1);
    const openedMs = Date.parse(mp.openedAt);
    const ageH = Number.isNaN(openedMs) ? null : (nowMs - openedMs) / 3600_000;
    if (ageH == null) {
      await alert(state, `age-${code}`, `⚠️ PROP ${mp.coin}: open time unreadable — max-hold check skipped, stop still managed.`, 6 * 3600_000);
    } else if (ageH >= ex.maxHoldH) {
      try {
        await dxClosePosition({ symbol: mp.symbol, positionCode: code, positionSide: "BUY", codePrefix: ORDER_PREFIX, metadata: { ...META, reason: "max-hold" } });
        notes.push(`${mp.coin}: max hold ${ex.maxHoldH}h — closed at market`);
        await sendNotification(`⏱ PROP ${mp.coin}: ${ex.maxHoldH}h hold reached — closed at market.`, "prop").catch(() => {});
      } catch (e) { errors.push(`${mp.coin}: max-hold close failed ${e instanceof DxError ? e.message : String(e)}`); }
      continue;
    }
    // Peak from COMPLETED 1-min bars since the last bar scored — the paper container's rule.
    // Kraken returns the most recent 720 bars after `since`; a guardian gap longer than 12h
    // loses the peak in between, which can only UNDER-trail (never loosen).
    let bars: { t: number; h: number; c: number }[] = [];
    try {
      let cursor = Math.max(0, mp.seenT - 60);
      for (let i = 0; i < 4; i++) {
        const page = await getKrakenOHLC(mp.symbol, 1, cursor);
        bars.push(...page);
        if (page.length < 700) break;
        cursor = page[page.length - 1].t;
      }
    } catch (e) { errors.push(`${mp.coin}: Kraken bars ${String(e).slice(0, 80)}`); bars = []; }
    bars = bars.filter((b) => b.t > mp.seenT).sort((a, b) => a.t - b.t);
    const done = bars.slice(0, -1);
    let peak = mp.peak;
    for (const b of done) peak = Math.max(peak, b.h);
    const seenT = done.length ? done[done.length - 1].t : mp.seenT;
    // Every working stop on this position, highest first. Exactly one should rest; a second
    // (a half-finished attach+cancel) is cancelled so a later run cannot PUT the lower one.
    const stopsFor = (list: DxOrder[]) => list.filter((o) => o.type === "STOP" && !o.finalStatus && String(o.legs?.[0]?.positionCode ?? "") === code).sort((a, b) => (b.legs?.[0]?.price ?? 0) - (a.legs?.[0]?.price ?? 0));
    let stops = stopsFor(orders);
    for (const extra of stops.slice(1)) {
      try { await dxCancelOrder(extra.orderCode, ordersEtag); notes.push(`${mp.coin}: cancelled a duplicate stop at ${extra.legs?.[0]?.price}`); ordersEtag = (await dxOpenOrders()).etag; }
      catch (e) { errors.push(`${mp.coin}: duplicate stop cancel failed ${String(e).slice(0, 80)}`); }
    }
    let stopOrder: DxOrder | undefined = stops[0];
    // The working order's own trigger is the truth for where the stop sits.
    const currentStop = stopOrder?.legs?.[0]?.price ?? p.stopLossPrice ?? mp.stop;
    const target = managedStop(1, mp.entry, peak, currentStop, mp.oneR, ex);
    const ins = await dxInstrument(mp.symbol).catch(() => null);
    const tick = ins && ins.priceIncrement > 0 ? ins.priceIncrement : 0.01;
    const floorTick = (x: number) => Number((Math.floor(x / tick) * tick).toFixed(10));

    if (!stopOrder) {
      // NAKED? Re-read BOTH orders and positions this instant: the stop may have just filled
      // (position gone → settle next run), or an entry may have landed between this run's two
      // reads (stop present → nothing to do). Only then re-protect.
      let still: DxPosition | undefined;
      try {
        const fresh = await dxOpenOrders();
        stops = stopsFor(fresh.orders);
        if (stops[0]) { stopOrder = stops[0]; ordersEtag = fresh.etag; notes.push(`${mp.coin}: stop appeared on re-read — not naked`); mp.peak = peak; mp.seenT = seenT; mp.stop = Math.max(mp.stop, stopOrder.legs?.[0]?.price ?? 0); continue; }
        still = (await dxPositions()).positions.find((x) => String(x.positionCode) === code);
      } catch { still = undefined; }
      if (!still) { notes.push(`${mp.coin}: gone before re-protect — settled next run`); mp.peak = peak; mp.seenT = seenT; continue; }
      const px = floorTick(Math.max(target, mp.stop));
      try {
        await dxAttachStop({ symbol: mp.symbol, positionCode: code, positionSide: "BUY", stopPrice: px, codePrefix: ORDER_PREFIX, metadata: { ...META, reason: "re-protect" } });
        mp.stop = px; mp.stopFails = 0;
        await alert(state, `naked-${code}`, `🛡 PROP ${mp.coin}: position had NO stop on the book — re-protected at $${px}.`, 0);
        notes.push(`${mp.coin}: re-protected at ${px}`);
      } catch (e) {
        mp.stopFails = (mp.stopFails ?? 0) + 1;
        errors.push(`${mp.coin}: re-protect failed ${e instanceof DxError ? e.message : String(e)}`);
        await alert(state, `naked-fail-${code}`, `🚨 PROP ${mp.coin}: NAKED and re-protect FAILED (${mp.stopFails}×): ${String(e).slice(0, 120)}`, 5 * 60_000);
      }
    } else if (target > currentStop + tick) {
      const px = floorTick(target);
      let moved = false;
      try { await dxModifyStop(stopOrder, px, ordersEtag); moved = true; }
      catch (e) {
        // PUT refused for a reason other than a stale ETag: attach a fresh stop first (the
        // position is never without one), then cancel the old — the round-trip script's path.
        const first = e instanceof DxError ? e.message : String(e);
        try {
          await dxAttachStop({ symbol: mp.symbol, positionCode: code, positionSide: "BUY", stopPrice: px, codePrefix: ORDER_PREFIX, metadata: { ...META, reason: "trail" } });
          // The new (higher) stop is on the book from here: record it even if the cancel below
          // fails — the next run cancels the lower duplicate, never PUTs it.
          mp.stop = px; moved = true;
          const again = await dxOpenOrders();
          const old = again.orders.find((o) => o.orderCode === stopOrder!.orderCode && !o.finalStatus);
          if (old) await dxCancelOrder(old.orderCode, again.etag);
          notes.push(`${mp.coin}: PUT failed (${first.slice(0, 60)}) — replaced via attach+cancel`);
        } catch (e2) {
          mp.stopFails = (mp.stopFails ?? 0) + 1;
          errors.push(`${mp.coin}: stop move failed twice — ${first.slice(0, 80)} / ${String(e2).slice(0, 80)}`);
          if ((mp.stopFails ?? 0) >= 2) await alert(state, `trail-fail-${code}`, `⚠️ PROP ${mp.coin}: the stop could not be moved to $${px} for ${mp.stopFails} runs (still resting at $${currentStop}).`, 30 * 60_000);
        }
      }
      if (moved) {
        mp.stop = px; mp.stopFails = 0;
        notes.push(`${mp.coin}: stop ${currentStop} → ${px} (peak ${peak}, +${((peak - mp.entry) / mp.oneR).toFixed(2)}R)`);
        if (currentStop < mp.entry && px >= mp.entry) await sendNotification(`🔒 PROP ${mp.coin} at +1R — stop moved to breakeven $${px}.`, "prop").catch(() => {});
      }
    } else {
      mp.stopFails = 0;
    }
    mp.peak = peak; mp.seenT = seenT;
    if (currentStop > mp.stop) mp.stop = currentStop;
  }

  // 4c. Closed since last run → settle the ledger from order history.
  const settled: string[] = [];
  for (const [code, mp] of Object.entries(managed)) {
    if (byCode.has(code)) continue;
    let exitPx: number | null = null, reason = "closed";
    try {
      const hist = await dxOrderHistory(new Date(Date.parse(mp.openedAt) - 60_000).toISOString(), 200);
      const closer = hist.filter((o) => String(o.legs?.[0]?.positionCode ?? "") === code && o.legs?.[0]?.positionEffect === "CLOSE" && (o.legs?.[0]?.filledQuantity ?? 0) > 0)
        .sort((a, b) => Date.parse(b.transactionTime) - Date.parse(a.transactionTime))[0];
      if (closer) { exitPx = closer.legs?.[0]?.averagePrice ?? null; reason = closer.type === "STOP" ? "stop" : closer.metadata?.reason ?? "market"; }
    } catch (e) { errors.push(`${mp.coin}: history ${String(e).slice(0, 80)}`); }
    if (exitPx == null && (mp.settleMisses ?? 0) < SETTLE_MISSES_MAX) {
      // History lags the book by a little; give it a few runs before settling without a price.
      mp.settleMisses = (mp.settleMisses ?? 0) + 1;
      notes.push(`${mp.coin}: closed, close not in history yet (${mp.settleMisses}/${SETTLE_MISSES_MAX})`);
      continue;
    }
    const pnl = exitPx != null && exitPx > 0 ? mp.qty * (exitPx - mp.entry) - mp.qty * (exitPx + mp.entry) * 0.0004 : null;
    await ensurePropTables();
    await prisma.$executeRawUnsafe(`UPDATE prop_trades SET closed_at=now(), exit_px=$1, pnl_usd=$2, exit_reason=$3 WHERE position_code=$4 AND closed_at IS NULL`, exitPx, pnl, reason, code).catch((e) => errors.push(`ledger close ${String(e).slice(0, 80)}`));
    settled.push(code);
    delete managed[code];
    const r = exitPx != null ? ((exitPx - mp.entry) / mp.oneR).toFixed(2) : "?";
    await sendNotification(`${pnl != null && pnl >= 0 ? "🟢" : "🔴"} PROP ${mp.coin} closed (${reason}) ${exitPx != null ? `@ $${exitPx}` : ""} · ${pnl != null ? `${pnl >= 0 ? "+" : "−"}$${Math.abs(pnl).toFixed(0)} (${r}R, est. incl. fees)` : "P&L pending"} · balance $${m.balance.toLocaleString()}`, "prop").catch(() => {});
    notes.push(`${mp.coin} closed ${reason} ${exitPx ?? "?"}`);
  }
  state.managed = managed;
  for (const k of Object.keys(state.foreign ?? {})) if (!byCode.has(k)) delete state.foreign![k];

  // 5. The inactivity clock comes from the BROKER when state has none: the last filled order,
  //    else the account's registration. 30 days without a trade is a breach; keep-alive at 27,
  //    only while armed and flat.
  if (!state.lastTradeAt) {
    let seed: string | null = null;
    try {
      const hist = await dxOrderHistory(new Date(nowMs - 31 * 86_400_000).toISOString(), 200);
      const filled = hist.filter((o) => (o.legs?.[0]?.filledQuantity ?? 0) > 0).sort((a, b) => Date.parse(b.transactionTime) - Date.parse(a.transactionTime))[0];
      seed = filled?.transactionTime ?? acct?.registrationTime ?? null;
    } catch { seed = acct?.registrationTime ?? null; }
    if (seed) { state.lastTradeAt = seed; notes.push(`inactivity clock seeded from ${seed}`); }
  }
  const lastTrade = state.lastTradeAt ? Date.parse(state.lastTradeAt) : null;
  if (c.armed && positions.length === 0 && keepAliveDue(lastTrade, nowMs)) {
    try {
      await propKeepAlive();
      state.lastTradeAt = new Date(nowMs).toISOString();
      notes.push("keep-alive trade placed and closed");
      await sendNotification("🫀 PROP keep-alive: 27 days without a trade — placed and closed a minimum BTC trade to reset Tradeify's inactivity clock.", "prop").catch(() => {});
    } catch (e) {
      errors.push(`keep-alive failed ${String(e).slice(0, 100)}`);
      await alert(state, "keepalive-fail", `⚠️ PROP keep-alive FAILED: ${String(e).slice(0, 120)} — inactivity breach in ~3 days unless a trade happens.`, 6 * 3600_000);
    }
  }

  state.guardianAt = new Date(nowMs).toISOString();
  await saveState(state, settled);
  return { ok: errors.length === 0, notes, errors, equity: m.equity, breach };
}

/** A minimum-size BTC round trip (open with stop, hold 21.5s, close) — resets the inactivity clock. */
export async function propKeepAlive(): Promise<void> {
  const ins = await dxInstrument("BTC/USD");
  const tick = ins && ins.priceIncrement > 0 ? ins.priceIncrement : 0.01;
  const bars = await getKrakenOHLC("BTC/USD", 1);
  const px = bars[bars.length - 1]?.c;
  if (!(px > 0)) throw new Error("no BTC price");
  const opened = await dxOpenWithStop({ symbol: "BTC/USD", side: "BUY", quantity: "0.01", stopPrice: stopPriceFor(px, PROP_STOP_FRAC, tick), codePrefix: "ka", metadata: { ...META, reason: KEEPALIVE_REASON } });
  await new Promise((r) => setTimeout(r, 21_500));
  await dxClosePosition({ symbol: "BTC/USD", positionCode: String(opened.parent.orderId), positionSide: "BUY", codePrefix: "ka", metadata: { ...META, reason: KEEPALIVE_REASON } });
}

// ---- ARM ----------------------------------------------------------------------------------
/** Clears a standing disarm reason — field-scoped, never a blind whole-state write. */
export async function clearPropDisarm(): Promise<void> {
  await patchState((st) => { delete st.disarmed; });
}
export async function propArmLog(entry: Record<string, unknown>): Promise<void> {
  const raw = await cfg(PROP_ARM_LOG_KEY);
  let list: unknown[] = [];
  try { list = raw ? JSON.parse(raw) : []; } catch { list = []; }
  list.push({ at: new Date().toISOString(), ...entry });
  await setKey(PROP_ARM_LOG_KEY, JSON.stringify(list.slice(-50)));
}

// ---- STATUS (for the admin page) ----------------------------------------------------------
export async function propStatus() {
  const c = await propConfig();
  const { state } = await loadState();
  const configured = dxConfigured();
  let account: DxAccountStatus | null = null, m: DxMetrics | null = null, positions: DxPosition[] = [], orders: DxOrder[] = [], brokerError: string | null = null;
  if (configured) {
    try { account = await dxAccountStatus(); m = await dxMetrics(); positions = (await dxPositions()).positions; orders = (await dxOpenOrders()).orders; }
    catch (e) { brokerError = e instanceof DxError ? `${e.status} ${e.message}` : String(e); }
  }
  const ledger = await propLedger(50).catch(() => [] as PropTradeRow[]);
  const f = m ? floorsFor(c.plan, state, m) : null;
  const room = m && f ? propRoom(c.plan, m.equity, f.floors) : null;
  const breach = m && f ? propBreachState(c.plan, m.equity, f.floors) : null;
  const phase = state.phase ?? 1;
  const gAt = state.guardianAt ? Date.parse(state.guardianAt) : 0;
  let armLog: unknown[] = [];
  try { armLog = JSON.parse((await cfg(PROP_ARM_LOG_KEY)) ?? "[]"); } catch { armLog = []; }
  const closed = ledger.filter((r) => r.closed_at && r.pnl_usd != null);
  return {
    configured, brokerError, account, metrics: m, plan: c.plan, config: c,
    floors: f ? { ...f.floors, snapshotBalance: f.snapshotBalance, snapshotKnown: f.known, snapshotEstimated: f.estimated, dayKey: f.dayKey } : null,
    room, breach, phase: phaseProgress(c.plan, phase, m?.balance ?? c.plan.accountSize),
    guardian: { at: state.guardianAt ?? null, fresh: gAt > 0 && Date.now() - gAt <= PROP_GUARDIAN_FRESH_MS },
    disarmed: state.disarmed ?? null, entriesToday: f ? (state.entries?.[f.dayKey] ?? 0) : 0, lastTradeAt: state.lastTradeAt ?? null,
    positions: positions.map((p) => ({ ...p, managed: state.managed?.[String(p.positionCode)] ?? null })),
    orders, ledger, armLog: armLog.slice(-10).reverse(),
    record: { trades: closed.length, wins: closed.filter((r) => (r.pnl_usd ?? 0) > 0).length, pnl: closed.reduce((a, r) => a + (r.pnl_usd ?? 0), 0) },
  };
}
