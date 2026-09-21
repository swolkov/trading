// THE TRADE LIBRARY (pure). What the library page computes from the journal rows and the broker ledger:
// the unified list (journal trips, plus broker-recorded trades from before the room existed), the day groups,
// the stats a trader reviews by, the equity curve and the CSV. No I/O; tested.
import type { JournalRow, SessionBucket } from "@/lib/trading-room-journal";
import { sessionBucket } from "@/lib/trading-room-journal";
import type { LedgerTrade } from "@/lib/trading-room-ledger-rules";

/** The first fill the room captured; broker-recorded trades before this have no fills and no chart. */
export const ROOM_START_MS = Date.parse("2026-09-20T23:00:00Z");

export interface LibraryRow {
  id: string; kind: "journal" | "record";
  symbol: string | null; side: "long" | "short" | null; qty: number | null;
  entryTs: string | null; exitTs: string; entryPx: number | null; exitPx: number | null;
  netUsd: number; feesUsd: number | null; netR: number | null; mfeR: number | null; maeR: number | null; riskSource: string;
  holdMin: number | null; session: SessionBucket; nearestLevel: string | null; distAtr: number | null;
  setupTag: string | null; why: string | null; grade: string | null; open: boolean; pairs: number | null;
  /** How much of the best the trade got was kept: net R over MFE R (1.0 = sold the top). */
  efficiency: number | null;
}

export function libraryRows(journal: JournalRow[], ledger: LedgerTrade[]): LibraryRow[] {
  const rows: LibraryRow[] = journal.map((r) => ({
    id: r.id, kind: "journal", symbol: r.symbol, side: r.side, qty: r.qty, entryTs: r.entryTs, exitTs: r.exitTs, entryPx: r.entryPx, exitPx: r.exitPx,
    netUsd: r.netUsd, feesUsd: r.feesUsd, netR: r.netR, mfeR: r.mfeR, maeR: r.maeR, riskSource: r.riskSource, holdMin: r.holdMin, session: r.session,
    nearestLevel: r.nearestLevel, distAtr: r.distAtr, setupTag: r.setupTag, why: r.why, grade: r.grade ?? null, open: r.open, pairs: null,
    efficiency: r.open || r.netR == null || r.mfeR == null || r.mfeR <= 0 ? null : Math.round((r.netR / r.mfeR) * 100) / 100,
  }));
  for (const t of ledger) {
    if (Date.parse(t.exitTs) >= ROOM_START_MS) continue;   // the room has these as real round trips
    rows.push({
      id: `record-${t.id}`, kind: "record", symbol: null, side: null, qty: null, entryTs: null, exitTs: t.exitTs, entryPx: null, exitPx: null,
      netUsd: t.grossUsd, feesUsd: null, netR: null, mfeR: null, maeR: null, riskSource: "none", holdMin: null, session: sessionBucket(Date.parse(t.exitTs)),
      nearestLevel: null, distAtr: null, setupTag: null, why: null, grade: null, open: false, pairs: t.pairs, efficiency: null,
    });
  }
  return rows.sort((a, b) => Date.parse(b.exitTs) - Date.parse(a.exitTs));
}

export interface LibraryFilter { symbol?: string | null; session?: SessionBucket | null; result?: "win" | "loss" | null; tag?: string | null; kind?: "journal" | "record" | null }
export function filterRows(rows: LibraryRow[], f: LibraryFilter): LibraryRow[] {
  return rows.filter((r) =>
    (!f.symbol || r.symbol === f.symbol) && (!f.session || r.session === f.session) && (!f.kind || r.kind === f.kind)
    && (!f.result || (f.result === "win" ? r.netUsd > 0 : r.netUsd < 0)) && (!f.tag || (r.setupTag ?? "").toLowerCase() === f.tag.toLowerCase()));
}

export interface Split { key: string; n: number; netUsd: number; wins: number; meanR: number | null }
export interface LibraryStats {
  n: number; wins: number; losses: number; netUsd: number; feesUsd: number; winRate: number | null;
  avgWinUsd: number | null; avgLossUsd: number | null; expectancyUsd: number | null; profitFactor: number | null;
  meanR: number | null; avgHoldMin: number | null; avgEfficiency: number | null; bestUsd: number | null; worstUsd: number | null;
  maxRunUpUsd: number; maxDrawdownUsd: number; bySession: Split[]; bySymbol: Split[]; byTag: Split[]; byGrade: Split[];
}
export function libraryStats(rowsNewestFirst: LibraryRow[]): LibraryStats {
  const closed = rowsNewestFirst.filter((r) => !r.open);
  const chrono = [...closed].sort((a, b) => Date.parse(a.exitTs) - Date.parse(b.exitTs));
  const wins = closed.filter((r) => r.netUsd > 0), losses = closed.filter((r) => r.netUsd < 0);
  const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
  const mean = (xs: number[]) => (xs.length ? sum(xs) / xs.length : null);
  const rs = closed.map((r) => r.netR).filter((x): x is number => x != null);
  const holds = closed.map((r) => r.holdMin).filter((x): x is number => x != null);
  const effs = closed.map((r) => r.efficiency).filter((x): x is number => x != null);
  const grossWin = sum(wins.map((r) => r.netUsd)), grossLoss = -sum(losses.map((r) => r.netUsd));
  let run = 0, peak = 0, maxRunUp = 0, maxDd = 0;
  for (const r of chrono) { run += r.netUsd; peak = Math.max(peak, run); maxRunUp = Math.max(maxRunUp, run); maxDd = Math.max(maxDd, peak - run); }
  const split = (key: (r: LibraryRow) => string | null): Split[] => {
    const m = new Map<string, LibraryRow[]>();
    for (const r of closed) { const k = key(r); if (!k) continue; (m.get(k) ?? m.set(k, []).get(k)!).push(r); }
    return [...m.entries()].map(([k, xs]) => ({ key: k, n: xs.length, netUsd: sum(xs.map((r) => r.netUsd)), wins: xs.filter((r) => r.netUsd > 0).length, meanR: mean(xs.map((r) => r.netR).filter((x): x is number => x != null)) }))
      .sort((a, b) => b.netUsd - a.netUsd);
  };
  return {
    n: closed.length, wins: wins.length, losses: losses.length, netUsd: sum(closed.map((r) => r.netUsd)), feesUsd: sum(closed.map((r) => r.feesUsd ?? 0)),
    winRate: closed.length ? wins.length / closed.length : null, avgWinUsd: mean(wins.map((r) => r.netUsd)), avgLossUsd: mean(losses.map((r) => r.netUsd)),
    expectancyUsd: closed.length ? sum(closed.map((r) => r.netUsd)) / closed.length : null, profitFactor: grossLoss > 0 ? grossWin / grossLoss : grossWin > 0 ? Infinity : null,
    meanR: mean(rs), avgHoldMin: mean(holds), avgEfficiency: mean(effs), bestUsd: closed.length ? Math.max(...closed.map((r) => r.netUsd)) : null, worstUsd: closed.length ? Math.min(...closed.map((r) => r.netUsd)) : null,
    maxRunUpUsd: maxRunUp, maxDrawdownUsd: maxDd,
    bySession: split((r) => r.session), bySymbol: split((r) => r.symbol), byTag: split((r) => r.setupTag), byGrade: split((r) => r.grade),
  };
}

/** Cumulative net after each closed trade, oldest first — the equity curve. */
export function equityCurve(rowsNewestFirst: LibraryRow[]): { t: number; cum: number; id: string }[] {
  const chrono = rowsNewestFirst.filter((r) => !r.open).sort((a, b) => Date.parse(a.exitTs) - Date.parse(b.exitTs));
  let cum = 0;
  return chrono.map((r) => { cum += r.netUsd; return { t: Date.parse(r.exitTs), cum: Math.round(cum * 100) / 100, id: r.id }; });
}

export interface DayGroup { day: string; rows: LibraryRow[]; n: number; netUsd: number; feesUsd: number; wins: number }
export function dayGroups(rowsNewestFirst: LibraryRow[], dayKeyOf: (ms: number) => string): DayGroup[] {
  const m = new Map<string, LibraryRow[]>();
  for (const r of rowsNewestFirst) { const k = dayKeyOf(Date.parse(r.exitTs)); (m.get(k) ?? m.set(k, []).get(k)!).push(r); }
  return [...m.entries()].map(([day, rows]) => ({ day, rows, n: rows.filter((r) => !r.open).length, netUsd: rows.filter((r) => !r.open).reduce((a, r) => a + r.netUsd, 0), feesUsd: rows.reduce((a, r) => a + (r.feesUsd ?? 0), 0), wins: rows.filter((r) => r.netUsd > 0 && !r.open).length }))
    .sort((a, b) => b.day.localeCompare(a.day));
}

export function libraryCsv(rows: LibraryRow[]): string {
  const esc = (v: unknown) => { const s = v == null ? "" : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const head = ["kind", "entry_utc", "exit_utc", "symbol", "side", "qty", "entry_px", "exit_px", "net_usd", "fees_usd", "net_r", "mfe_r", "mae_r", "efficiency", "hold_min", "session", "nearest_level", "dist_atr", "tag", "why", "grade", "pairs", "open"];
  const lines = rows.map((r) => [r.kind, r.entryTs, r.exitTs, r.symbol, r.side, r.qty, r.entryPx, r.exitPx, r.netUsd.toFixed(2), r.feesUsd?.toFixed(2), r.netR?.toFixed(3), r.mfeR?.toFixed(3), r.maeR?.toFixed(3), r.efficiency, r.holdMin?.toFixed(1), r.session, r.nearestLevel, r.distAtr?.toFixed(2), r.setupTag, r.why, r.grade, r.pairs, r.open].map(esc).join(","));
  return [head.join(","), ...lines].join("\n");
}
