// THE CO-PILOT — I/O (Sep 22 2026). Reads Spencer's LIVE Tradovate account every 15 seconds (positions, the
// account's open P&L, working orders; fills only when a size changes), runs the pure rules in copilot-rules.ts,
// and posts to the co-pilot Slack lane. READ-ONLY: every Tradovate call here is a plain GET with the room's own
// session token, read from the shared row the room publishes. It has its own tiny client on purpose: it can never
// reach the password login (5 per hour, per user — tripped on Sep 22), never re-authenticates on a 401, and has no
// order endpoint. No session → it says it is blind and waits for the room to publish one. It also keeps every order and every order version it sees
// (trading_room_orders / trading_room_order_versions), because Tradovate forgets them at the session roll and
// that is where his stop placements and stop moves live — the audit on Sep 22 could not see them.
import { prisma } from "@/lib/db";
import { sendNotification } from "@/lib/notifications";
import { CHART_KEY } from "@/lib/trading-room";
import { ROOM_SYMBOLS, type ChartLevels, type RoomSymbol } from "@/lib/trading-room-rules";
import { priceFromOpenPnl, step, timeBucket, type CopilotFill, type CopilotOrder, type CopilotPosition, type CopilotState } from "@/lib/copilot-rules";
import { gradeAsk, saveDiscipline } from "@/lib/trade-grades";

export const COPILOT_STATE_KEY = "copilot_state";
export const COPILOT_ENABLED_KEY = "copilot_enabled";     // "false" silences it; anything else (or missing) = on
const LEASE_KEY = "copilot_lease";
const LANE = "copilot" as const;
const CHART_PRICE_FRESH_MS = 90_000;
const BLIND_WARN_EVERY_MS = 30 * 60_000;
const LAST_POLL_START_MS = 48_000;
// Suspended = a bracket leg that is not active yet (its parent hasn't filled) — it protects nothing, so it is not counted.
const LIVE_STATUSES = new Set(["Working", "PendingNew", "PendingReplace", "PendingCancel"]);
const STOP_TYPES = new Set(["Stop", "StopLimit", "TrailingStop", "TrailingStopLimit"]);

interface Stored extends CopilotState { lastPollMs?: number; lastOkMs?: number; lastError?: string; blindWarnedMs?: number; polls?: number; snapshotFields?: string[]; accountId?: number; auditError?: string }
const LIVE_URL = "https://live.tradovateapi.com/v1";
const SHARED_TOKEN_KEY = "tradovate_live_shared_token";

async function cfg(key: string): Promise<string | null> {
  return (await prisma.agentConfig.findUnique({ where: { key } }).catch(() => null))?.value ?? null;
}
async function setKey(key: string, value: string): Promise<void> {
  await prisma.agentConfig.upsert({ where: { key }, update: { value }, create: { key, value } });
}

/** One runner at a time across Vercel instances: a lease row that only an expired holder gives up. */
export async function acquireLease(untilMs: number, nowMs = Date.now()): Promise<boolean> {
  const rows = await prisma.$queryRawUnsafe<{ key: string }[]>(
    `INSERT INTO "AgentConfig" (key, value) VALUES ($1, $2)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value WHERE "AgentConfig".value < $3
     RETURNING key`,
    LEASE_KEY, new Date(untilMs).toISOString(), new Date(nowMs).toISOString(),
  );
  return rows.length > 0;
}
/** Give the lease back — only if it is still ours (a slow run must not free a newer runner's lease). */
export async function releaseLease(ownUntilMs: number): Promise<void> {
  await prisma.$executeRawUnsafe(`UPDATE "AgentConfig" SET value = $1 WHERE key = $2 AND value = $3`, new Date(0).toISOString(), LEASE_KEY, new Date(ownUntilMs).toISOString()).catch(() => {});
}

export async function ensureOrderTables(): Promise<void> {
  await prisma.$executeRawUnsafe(`CREATE TABLE IF NOT EXISTS trading_room_orders (
    id bigint PRIMARY KEY, contract text, action text, ord_status text, created_ts timestamptz,
    first_seen timestamptz NOT NULL DEFAULT now(), last_seen timestamptz NOT NULL DEFAULT now())`);
  await prisma.$executeRawUnsafe(`CREATE TABLE IF NOT EXISTS trading_room_order_versions (
    id bigint PRIMARY KEY, order_id bigint NOT NULL, order_type text, stop_price float8, price float8, qty int,
    first_seen timestamptz NOT NULL DEFAULT now())`);
  await prisma.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS trading_room_order_versions_order ON trading_room_order_versions (order_id)`);
}

// ---- Tradovate reads: GET only, the room's session only ---------------------------------------------
class Blind extends Error {}
async function sessionToken(nowMs: number): Promise<{ token: string; accountId: number }> {
  const raw = await cfg(SHARED_TOKEN_KEY);
  if (!raw) throw new Blind("no shared Tradovate session yet (the room republishes it every 5 minutes)");
  let row: { token?: string; expires?: string; accountId?: number };
  try { row = JSON.parse(raw); } catch { throw new Blind("shared session row unreadable"); }
  if (!row.token || !(Date.parse(row.expires ?? "") > nowMs + 30_000)) throw new Blind("shared Tradovate session expired — waiting for the room to renew it");
  return { token: row.token, accountId: Number(row.accountId) || 0 };
}
let session: { token: string } | null = null;
async function get<T>(path: string): Promise<T> {
  if (!session) throw new Blind("no session");
  const res = await fetch(`${LIVE_URL}${path}`, { headers: { Authorization: `Bearer ${session.token}`, Accept: "application/json" }, signal: AbortSignal.timeout(8_000) });
  if (res.status === 401) throw new Blind("Tradovate said the session is expired (401) — waiting for the room to renew it");
  if (!res.ok) throw new Error(`Tradovate ${path.split("?")[0]} → HTTP ${res.status}`);
  return (await res.json()) as T;
}

const contractRoots = new Map<number, RoomSymbol | null>();
/** A room symbol, null for a CONFIRMED other contract; throws when the lookup fails (never guesses a position away). */
async function symbolOf(contractId: number): Promise<RoomSymbol | null> {
  if (!contractRoots.has(contractId)) {
    const c = await get<{ name?: string }>(`/contract/item?id=${contractId}`);
    if (!c?.name) throw new Error(`contract ${contractId}: no name`);
    contractRoots.set(contractId, ROOM_SYMBOLS.find((s) => c.name!.startsWith(s)) ?? null);
  }
  return contractRoots.get(contractId) ?? null;
}

interface RawPosition { accountId: number; contractId: number; netPos: number; netPrice: number }
interface RawOrder { id: number; accountId: number; contractId: number; action: string; ordStatus: string; timestamp: string }
interface RawVersion { id: number; orderId: number; orderType: string; stopPrice?: number; price?: number; orderQty?: number }
interface RawFill { id: number; contractId: number; timestamp: string; action: string; qty: number; price: number }

async function readPositions(accountId: number): Promise<{ room: CopilotPosition[]; openCount: number }> {
  const raw = await get<RawPosition[]>("/position/list");
  if (!Array.isArray(raw)) throw new Error("position/list: not a list");
  const open = raw.filter((p) => p.netPos !== 0 && (!p.accountId || p.accountId === accountId));
  const room: CopilotPosition[] = [];
  for (const p of open) {
    const symbol = await symbolOf(p.contractId);
    if (symbol) room.push({ symbol, netPos: p.netPos, netPrice: p.netPrice });
  }
  return { room, openCount: open.length };
}

/** The account's open P&L. Tradovate names it `openPnL`; netLiq − cash is the same number, kept as the fallback. */
async function readOpenPnl(accountId: number): Promise<{ openPnl: number | null; fields: string[] }> {
  const s = await get<Record<string, unknown>>(`/cashBalance/getCashBalanceSnapshot?accountId=${accountId}`);
  const num = (x: unknown) => (typeof x === "number" && Number.isFinite(x) ? x : null);
  const fields = s && typeof s === "object" ? Object.keys(s).sort() : [];
  const direct = num(s?.openPnL);
  if (direct != null) return { openPnl: direct, fields };
  const liq = num(s?.netLiq), cash = num(s?.totalCashValue);
  return { openPnl: liq != null && cash != null ? liq - cash : null, fields };
}

const REJECT_LOOKBACK_MS = 5 * 60_000;
let lastRejected: CopilotOrder[] = [];   // filled by readOrders each time it runs (this poll's view)
async function readOrders(accountId: number, state: Stored): Promise<CopilotOrder[]> {
  lastRejected = [];
  const [orders, versions] = await Promise.all([
    get<RawOrder[]>("/order/list"),
    get<RawVersion[]>("/orderVersion/list"),
  ]);
  if (!Array.isArray(orders) || !Array.isArray(versions)) throw new Error("order lists: not a list");
  await recordOrders(orders.filter((o) => !o.accountId || o.accountId === accountId), versions)
    .then(() => { delete state.auditError; })
    .catch((e) => { state.auditError = String(e).slice(0, 160); console.error("[copilot] order audit write failed", e); });
  const latest = new Map<number, RawVersion>();
  for (const v of [...versions].sort((a, b) => a.id - b.id)) latest.set(v.orderId, v);
  const out: CopilotOrder[] = [];
  for (const o of orders) {
    if (o.accountId && o.accountId !== accountId) continue;
    const rejected = o.ordStatus === "Rejected" && Date.now() - Date.parse(o.timestamp) < REJECT_LOOKBACK_MS;
    if (!LIVE_STATUSES.has(o.ordStatus) && !rejected) continue;
    const v = latest.get(o.id);
    if (!v) continue;
    const symbol = await symbolOf(o.contractId);
    if (!symbol) continue;
    const action = o.action === "Buy" ? "Buy" : o.action === "Sell" ? "Sell" : null;
    if (!action) continue;
    const isStop = STOP_TYPES.has(v.orderType), isLimit = v.orderType === "Limit";
    const price = isStop ? v.stopPrice : isLimit ? v.price : undefined;
    if ((!isStop && !isLimit) || typeof price !== "number") continue;
    // A trailing stop's orderVersion keeps its STARTING price; the broker moves it server-side. Flagged, never presented as current.
    const order: CopilotOrder = { orderId: o.id, symbol, action, kind: isStop ? "stop" : "limit", price, qty: Number(v.orderQty) || 0, trailing: v.orderType.startsWith("Trailing") };
    if (rejected) { if (isStop) lastRejected.push(order); continue; }
    out.push(order);
  }
  return out;
}

async function recordOrders(orders: RawOrder[], versions: RawVersion[]): Promise<void> {
  if (!orders.length && !versions.length) return;
  const names: (RoomSymbol | null)[] = [];
  for (const o of orders) names.push(await symbolOf(o.contractId).catch(() => null));   // audit only: unknown stays null
  if (orders.length) await prisma.$executeRawUnsafe(
    `INSERT INTO trading_room_orders (id, contract, action, ord_status, created_ts)
     SELECT * FROM unnest($1::bigint[], $2::text[], $3::text[], $4::text[], $5::timestamptz[])
     ON CONFLICT (id) DO UPDATE SET ord_status = EXCLUDED.ord_status, last_seen = now()`,
    orders.map((o) => o.id), names, orders.map((o) => o.action), orders.map((o) => o.ordStatus), orders.map((o) => new Date(o.timestamp)),
  );
  if (versions.length) await prisma.$executeRawUnsafe(
    `INSERT INTO trading_room_order_versions (id, order_id, order_type, stop_price, price, qty)
     SELECT * FROM unnest($1::bigint[], $2::bigint[], $3::text[], $4::float8[], $5::float8[], $6::int[])
     ON CONFLICT (id) DO NOTHING`,
    versions.map((v) => v.id), versions.map((v) => v.orderId), versions.map((v) => v.orderType),
    versions.map((v) => (typeof v.stopPrice === "number" ? v.stopPrice : null)), versions.map((v) => (typeof v.price === "number" ? v.price : null)),
    versions.map((v) => (typeof v.orderQty === "number" ? v.orderQty : null)),
  );
}

async function readFillsSince(sinceMs: number): Promise<CopilotFill[]> {
  const raw = await get<RawFill[]>("/fill/list");
  if (!Array.isArray(raw)) return [];
  const out: CopilotFill[] = [];
  for (const f of raw) {
    const ms = Date.parse(f.timestamp);
    if (!(ms > sinceMs)) continue;
    const symbol = await symbolOf(f.contractId);
    const action = f.action === "Buy" ? "Buy" : f.action === "Sell" ? "Sell" : null;
    if (symbol && action && f.qty > 0) out.push({ symbol, action, qty: f.qty, price: f.price, ms });
  }
  return out;
}

async function chartPrices(nowMs: number): Promise<Partial<Record<RoomSymbol, number>>> {
  const raw = await cfg(CHART_KEY);
  if (!raw) return {};
  try {
    const all = JSON.parse(raw) as Record<string, ChartLevels>;
    const out: Partial<Record<RoomSymbol, number>> = {};
    for (const sym of ROOM_SYMBOLS) {
      const c = all[sym];
      if (c && nowMs - Date.parse(c.receivedAt) <= CHART_PRICE_FRESH_MS && Number.isFinite(c.price)) out[sym] = c.price;
    }
    return out;
  } catch { return {}; }
}

/** His own closed trips for this market in this time-of-day bucket (the journal the room folds), last 30 days. */
async function recordFor(sym: RoomSymbol, nowMs: number): Promise<{ label: string; n: number; netUsd: number; since: string } | null> {
  const rows = await prisma.$queryRawUnsafe<{ entry_ts: Date; net_usd: number }[]>(
    `SELECT entry_ts, net_usd FROM trading_room_trades WHERE symbol = $1 AND open = false AND entry_ts >= $2`, sym, new Date(nowMs - 30 * 86_400_000));
  const label = timeBucket(nowMs);
  const mine = rows.filter((r) => timeBucket(new Date(r.entry_ts).getTime()) === label);
  if (!mine.length) return null;
  const first = mine.reduce((a, r) => Math.min(a, new Date(r.entry_ts).getTime()), Infinity);
  return { label, n: mine.length, netUsd: mine.reduce((a, r) => a + Number(r.net_usd), 0), since: new Date(first).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "America/New_York" }) };
}

// ---- one poll ---------------------------------------------------------------------------------------
async function loadState(): Promise<Stored> {
  const r = await cfg(COPILOT_STATE_KEY);
  try { const st = r ? (JSON.parse(r) as Stored) : { trips: {} }; st.trips ??= {}; return st; } catch { return { trips: {} }; }
}

export async function copilotPoll(nowMs = Date.now(), readOrdersThisPoll = true): Promise<{ ok: boolean; posted: number; note: string }> {
  const state = await loadState();
  try {
    const s = await sessionToken(nowMs);
    session = { token: s.token };
    let accountId = s.accountId || state.accountId || 0;
    if (!accountId) {
      const accts = await get<{ id: number; active: boolean }[]>("/account/list");
      accountId = (accts.find((a) => a.active) ?? accts[0])?.id ?? 0;
    }
    if (!accountId) throw new Error("no Tradovate account id");
    state.accountId = accountId;
    const [{ room, openCount }, pnl] = await Promise.all([readPositions(accountId), readOpenPnl(accountId)]);
    const tracking = Object.keys(state.trips).length > 0 || room.length > 0;
    const orders = tracking || readOrdersThisPoll ? await readOrders(accountId, state) : null;
    const sizeChanged = ROOM_SYMBOLS.some((sym) => {
      const t = state.trips[sym], p = room.find((x) => x.symbol === sym);
      return (t?.qty ?? 0) !== Math.abs(p?.netPos ?? 0) || (!!t && !!p && Math.sign(p.netPos) !== t.side);
    });
    // Fills since the last GOOD poll (a close during a blind stretch still finds its exit fills).
    const fills = sizeChanged ? await readFillsSince((state.lastOkMs ?? nowMs - 60_000) - 5_000).catch(() => []) : [];
    const records: Partial<Record<RoomSymbol, { label: string; n: number; netUsd: number; since: string }>> = {};
    for (const p of room) if (!state.trips[p.symbol]) { const r = await recordFor(p.symbol, nowMs).catch(() => null); if (r) records[p.symbol] = r; }
    const prices = { ...(await chartPrices(nowMs)), ...(openCount === 1 ? priceFromOpenPnl(room, pnl.openPnl) : {}) };
    const { state: next, messages, gradeAsks, discipline } = step(state, { nowMs, positions: room, orders: tracking ? orders : null, prices, fills, records, rejectedStops: orders ? lastRejected : [] });
    // State first, then Slack: a failed save must not make the next poll say it all again (at most once > twice).
    const out: Stored = { ...next, accountId, lastPollMs: nowMs, lastOkMs: nowMs, polls: (state.polls ?? 0) + 1, snapshotFields: pnl.fields, auditError: state.auditError };
    await setKey(COPILOT_STATE_KEY, JSON.stringify(out));
    for (const m of messages) await sendNotification(m, LANE).catch(() => {});
    await saveDiscipline(discipline).catch((e) => console.error("[copilot] discipline save failed", e));
    // His A/B/C read on each new entry, one tap, before it plays out (skipped when the signing secret isn't set).
    for (const g of gradeAsks) { const txt = gradeAsk(g.symbol, g.side, g.openedMs, g.closed); if (txt) await sendNotification(txt, LANE, undefined, { noUnfurl: true }).catch(() => {}); }
    return { ok: true, posted: messages.length, note: `${room.length} open · ${orders ? `${orders.length} working` : "orders not read"} · ${Object.keys(prices).join(",") || "no price"}` };
  } catch (e) {
    // A blind co-pilot must say so — once per half hour, and only while it is watching a position.
    const err = String(e instanceof Error ? e.message : e).slice(0, 200);
    const watching = Object.keys(state.trips).length > 0;
    if (watching && (!state.blindWarnedMs || nowMs - state.blindWarnedMs > BLIND_WARN_EVERY_MS)) {
      state.blindWarnedMs = nowMs;
      await setKey(COPILOT_STATE_KEY, JSON.stringify({ ...state, lastPollMs: nowMs, lastError: err })).catch(() => {});
      await sendNotification(`🙈 Co-pilot can't read Tradovate right now — I'm NOT watching your ${Object.keys(state.trips).join("/")} position. Your stops at the broker are unaffected. (${err.slice(0, 120)})`, LANE).catch(() => {});
    } else {
      await setKey(COPILOT_STATE_KEY, JSON.stringify({ ...state, lastPollMs: nowMs, lastError: err })).catch(() => {});
    }
    return { ok: false, posted: 0, note: err };
  } finally { session = null; }
}

/** The cron body: up to four polls, 15 seconds apart, inside one lease. */
export async function copilotMinute(startMs = Date.now(), polls = 4, gapMs = 15_000): Promise<{ ran: boolean; results: { ok: boolean; posted: number; note: string }[] }> {
  if ((await cfg(COPILOT_ENABLED_KEY)) === "false") return { ran: false, results: [] };
  const leaseUntil = startMs + polls * gapMs + 5_000;
  if (!(await acquireLease(leaseUntil, startMs))) return { ran: false, results: [] };
  const results: { ok: boolean; posted: number; note: string }[] = [];
  try {
    await ensureOrderTables();
    for (let i = 0; i < polls; i++) {
      const due = startMs + i * gapMs;
      if (Date.now() > startMs + LAST_POLL_START_MS) break;   // leave room inside maxDuration 60 — never be killed mid-poll
      const wait = due - Date.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      // Orders are read every poll while a position is open; when flat, once a minute (for the order audit).
      results.push(await copilotPoll(Date.now(), i === 0));
    }
  } finally { await releaseLease(leaseUntil); }
  return { ran: true, results };
}
