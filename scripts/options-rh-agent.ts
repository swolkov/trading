import { OPTIONS_PAPER_RETIRED } from "../src/lib/options-operation";
// Read-only real account collector. Options simulation is retired.
// node --env-file=.env.local --import tsx scripts/options-rh-agent.ts ingest <payload.json>
// Historical quote/scan code below is unreachable while retirement is active.
import { assertCompleteOptionsSnapshot } from "../src/lib/options-snapshot-validation";
import { readFileSync } from "node:fs";
import { prisma } from "../src/lib/db";
import {
  markChainFulfilled, pendingChainRequests, putQuotes, quoteStoreFreshness,
  saveAccountSnapshot, saveLiveSnapshot, type LiveOrder, type LivePosition, type QuoteWithHint,
} from "../src/lib/options-quote-store";
import { parseOcc, toOcc } from "../src/lib/options-occ";
import { runOptionsScan } from "../src/lib/options-run";
import { barsWorklist, barsStoreFreshness, putBars, type StoredBar } from "../src/lib/options-bars-store";
import { OPTIONS_SYMBOLS } from "../src/lib/options-paper-model";

// Quotes arrive in ROBINHOOD's own shape — underlying symbol, expiration, strike, type —
// and this script derives the OCC key. Asking the agent to hand-format OCC's eight-digit
// thousandths strike field would be a silent-failure machine: a mis-padded symbol does not
// throw, it just never matches a stored position, and the book would quietly stop marking.
interface AgentQuote {
  symbol: string; expiration: string; strike: number; type: "call" | "put";
  bid: number; ask: number; bidSize?: number; askSize?: number;
  quoteTs?: string | null; delta?: number | null; theta?: number | null;
  iv?: number | null; dayVolume?: number;
}
// Daily bars arrive per symbol, in Robinhood's own shape (get_equity_historicals, interval
// "day", regular session, split-adjusted). `day` is the session date. The agent marks the
// bar for TODAY `official: true` only after the close and only with the settled close from
// get_equity_quotes — a provisional bar never overwrites an official one.
interface AgentBars { symbol: string; bars: { day: string; o: number; h: number; l: number; c: number; v?: number; official?: boolean }[] }
// The real account's positions and orders, in Robinhood's own field names (get_option_positions
// with nonzero=true; get_option_orders, newest first). Passed through with light normalisation
// so the page shows what the broker said, not a reinterpretation.
interface AgentPosition {
  chain_symbol: string; type: string; option_type?: string | null; strike_price?: number | string | null;
  expiration_date?: string | null; quantity: number | string; average_price: number | string; pending_quantity?: number | string | null;
}
interface AgentOrder {
  id: string; chain_symbol: string; state: string; opening_strategy?: string | null; closing_strategy?: string | null;
  direction?: string | null; quantity: number | string; processed_quantity?: number | string | null;
  premium?: number | string | null; price?: number | string | null; type?: string | null; trigger?: string | null;
  placed_agent?: string | null; created_at?: string | null;
}
interface Payload {
  positionsComplete?: boolean;
  ordersComplete?: boolean;
  account?: { accountNumber: string; type: string; optionLevel: string; cash: number; buyingPower: number; optionsValue: number; totalValue: number };
  positions?: AgentPosition[];
  orders?: AgentOrder[];
  bars?: AgentBars[];
  quotes?: AgentQuote[];
  underlyings?: Record<string, number>;
  chainsFulfilled?: string[];
}

function toStoreQuote(q: AgentQuote): QuoteWithHint | null {
  if (!q.symbol || !q.expiration || !Number.isFinite(q.strike)) return null;
  const occ = toOcc(q.symbol, q.expiration, q.type, q.strike);
  // Round-trip check: if the key we just built does not parse back to the same contract,
  // something is wrong with the inputs and writing it would poison the inbox.
  const back = parseOcc(occ);
  if (!back || back.strike !== q.strike || back.expiry !== q.expiration || back.type !== q.type) return null;
  return {
    occ, symbolHint: q.symbol.toUpperCase(),
    strike: q.strike, expiry: q.expiration, type: q.type,
    bid: q.bid ?? 0, ask: q.ask ?? 0, bidSize: q.bidSize ?? 0, askSize: q.askSize ?? 0,
    quoteTs: q.quoteTs ?? null,
    delta: q.delta ?? null, theta: q.theta ?? null, iv: q.iv ?? null,
    dayVolume: q.dayVolume ?? 0,
  };
}

async function worklist() {
  if (OPTIONS_PAPER_RETIRED) {
    console.log(JSON.stringify({ paperRetired: true, accountSnapshotsOnly: true, openPositions: [], chainRequests: [], bars: [], nothingToDo: true }));
    return;
  }
  // BOTH LEGS, and NOT cohort-filtered.
  //
  // Both of those were bugs. Selecting only `occ` meant a spread's SHORT leg was quoted once
  // at entry and never again; 36 hours later the evaluator's freshness gate dropped it, and
  // from then on the position never marked, never checked its trend exit, never checked the
  // 21-day floor — it just ran to expiry, which is precisely the assignment exposure this
  // book exists to avoid. And filtering by cohort here re-introduced the abandonment that
  // evaluateOptionsPaper deliberately removed: an open o1 position would stop being quoted
  // the moment the sim version was bumped.
  const open = await prisma.$queryRawUnsafe<{
    occ: string; short_occ: string | null; symbol: string; expiry: string;
    strike: number | null; short_strike: number | null;
  }[]>(
    `SELECT occ, short_occ, symbol, expiry, strike, short_strike
     FROM options_paper_trades WHERE status='open' ORDER BY time ASC`,
  );
  const chains = await pendingChainRequests();
  const fresh = await quoteStoreFreshness();
  // Every name the signal reads, plus any held name that has left the universe.
  const barSymbols = [...new Set([...OPTIONS_SYMBOLS, ...open.map((r) => r.symbol)])];
  const bars = await barsWorklist(barSymbols);
  const barsStore = await barsStoreFreshness(barSymbols);
  console.log(JSON.stringify({
    // DAILY BARS FIRST. The signal is computed from these; a name with stale bars cannot
    // fire. `fromDay` is the first day still needed (inclusive) — fetch get_equity_historicals
    // interval "day" from there, up to 10 symbols per call. After the close, take today's
    // settled close from get_equity_quotes and push today's bar with official: true.
    bars,
    barsStore,
    // Contracts we hold: they must be re-quoted every run or their stops go unchecked.
    // strike/type are spelled out so the agent can look the contract up on Robinhood
    // directly (it identifies contracts by symbol+expiry+strike+type, never by OCC).
    // ONE ENTRY PER LEG. A spread needs both quoted or it cannot be marked or closed at all.
    openPositions: open.flatMap((r) => {
      const legs = [{ occ: r.occ, strike: r.strike, leg: "long" as const }];
      if (r.short_occ) legs.push({ occ: r.short_occ, strike: r.short_strike, leg: "short" as const });
      return legs.map(({ occ, strike, leg }) => {
        const p = parseOcc(occ);
        return {
          occ, symbol: r.symbol, expiry: r.expiry,
          strike: strike ?? p?.strike ?? null, type: p?.type ?? "call", leg,
        };
      });
    }),
    // Chains the scanner asked for and could not fetch itself.
    chainRequests: chains,
    quoteStore: fresh,
    nothingToDo: open.length === 0 && chains.length === 0 && bars.length === 0,
  }, null, 2));
}

async function ingest(path: string) {
  const payload = JSON.parse(readFileSync(path, "utf8")) as Payload;
  assertCompleteOptionsSnapshot(payload);

  if (payload.account) {
    await saveAccountSnapshot(payload.account);
    console.log(`[account] ${payload.account.optionLevel} · buying power $${payload.account.buyingPower.toFixed(2)}`);
  }

  if (payload.positions || payload.orders) {
    const num = (x: unknown) => { const n = Number(x); return Number.isFinite(n) ? n : 0; };
    const positions: LivePosition[] = (payload.positions ?? []).map((p) => ({
      symbol: String(p.chain_symbol ?? "").toUpperCase(), type: p.type === "short" ? "short" : "long",
      optionType: p.option_type === "call" || p.option_type === "put" ? p.option_type : null,
      strike: p.strike_price == null ? null : num(p.strike_price), expiry: p.expiration_date ?? null,
      quantity: num(p.quantity), averagePrice: num(p.average_price), pendingQuantity: num(p.pending_quantity),
    })).filter((p) => p.symbol && p.quantity !== 0);
    const orders: LiveOrder[] = (payload.orders ?? []).map((o) => ({
      id: String(o.id), symbol: String(o.chain_symbol ?? "").toUpperCase(), state: String(o.state ?? "unknown"),
      strategy: o.opening_strategy ?? o.closing_strategy ?? null, side: o.direction ?? null,
      quantity: num(o.quantity), processedQuantity: num(o.processed_quantity),
      premium: o.premium == null ? null : num(o.premium), price: o.price == null ? null : num(o.price),
      orderType: `${o.type ?? "?"}${o.trigger && o.trigger !== "immediate" ? `+${o.trigger}` : ""}`,
      placedAgent: o.placed_agent ?? null, createdAt: o.created_at ?? null,
    })).filter((o) => o.symbol);
    await saveLiveSnapshot({ positions, orders });
    console.log(`[live   ] ${positions.length} open position${positions.length === 1 ? "" : "s"} · ${orders.length} order${orders.length === 1 ? "" : "s"} on the real account`);
  }

  if (OPTIONS_PAPER_RETIRED) return;

  let barsWritten = 0, barsSymbols = 0;
  for (const b of payload.bars ?? []) {
    if (!b?.symbol || !Array.isArray(b.bars)) continue;
    const rows: StoredBar[] = b.bars.map((x) => ({ day: x.day, o: x.o, h: x.h, l: x.l, c: x.c, v: x.v ?? 0, official: !!x.official }));
    const n = await putBars(b.symbol, rows);
    if (n !== rows.length) console.log(`[bars   ] ${b.symbol}: ${rows.length - n} rejected — malformed day or OHLC`);
    barsWritten += n; barsSymbols++;
  }
  if (barsSymbols) console.log(`[bars   ] ${barsWritten} bars written across ${barsSymbols} symbols`);

  const supplied = payload.quotes ?? [];
  const mapped = supplied.map(toStoreQuote).filter((q): q is QuoteWithHint => q !== null);
  if (mapped.length !== supplied.length) {
    console.log(`[quotes ] ${supplied.length - mapped.length} rejected — symbol/expiry/strike did not round-trip to a valid OCC`);
  }
  const wrote = await putQuotes(mapped, payload.underlyings ?? {});
  console.log(`[quotes ] ${wrote} written of ${supplied.length} supplied`);

  if (payload.chainsFulfilled?.length) {
    await markChainFulfilled(payload.chainsFulfilled);
    console.log(`[chains ] fulfilled: ${payload.chainsFulfilled.join(", ")}`);
  }

  // Run the real thing — same function the daily cron calls, no duplicated entry logic.
  const res = await runOptionsScan();
  console.log(`[scan   ] scanned ${res.scanned} · signals ${res.trendSignals.length} (fresh ${res.freshSignals.length}) · resolved ${res.resolved} · opened ${res.opened.length}`);
  for (const o of res.opened) console.log(`  [open ] ${o}`);
  for (const r of res.refused.slice(0, 10)) console.log(`  [skip ] ${r}`);
  for (const e of res.errors) console.log(`  [error] ${e}`);
  if (!res.tracking) console.log("  [gate ] options_paper_autotrack is OFF — no new entries");
}

async function main() {
  const mode = process.argv[2];
  if (mode === "worklist") return worklist();
  if (mode === "ingest") {
    const path = process.argv[3];
    if (!path) throw new Error("usage: options-rh-agent.ts ingest <payload.json>");
    return ingest(path);
  }
  throw new Error("usage: options-rh-agent.ts worklist | ingest <payload.json>");
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
