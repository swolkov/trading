// THE REPLAY'S EXECUTIONS (pure). What each click did inside one round trip — opened, added, took some off,
// closed — and the dollars each exit banked, plus the running P&L at any moment of the replay. Sep 23 2026:
// Spencer wants the replay to show "my entry buy or sell and when I execute, profit / loss". No I/O; tested.
//
// Cost basis is the running average of the contracts still on (the broker's own convention), so a scale-out's
// dollars are measured against what was held at that moment. Fees are NOT in the per-fill dollars; the trip's
// net (after fees) is the row's number and is shown next to them.

export interface ExecFill { ts: string; action: "Buy" | "Sell"; qty: number; price: number }
export type ExecRole = "open" | "add" | "reduce" | "close";
export interface Execution extends ExecFill {
  role: ExecRole;
  posAfter: number;            // contracts still on after this fill (unsigned)
  avgPx: number;               // average cost of what is held (before this fill, for a reduce / close)
  realizedUsd: number | null;  // gross dollars this fill banked; null for an open or an add
}

export function executions(side: "long" | "short", fills: ExecFill[], pointValue: number): Execution[] {
  const dir = side === "long" ? 1 : -1;
  const opens = side === "long" ? "Buy" : "Sell";
  let pos = 0, avg = 0;
  const out: Execution[] = [];
  for (const f of [...fills].sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts))) {
    if (f.action === opens) {
      avg = pos + f.qty > 0 ? (avg * pos + f.price * f.qty) / (pos + f.qty) : f.price;
      out.push({ ...f, role: pos === 0 ? "open" : "add", posAfter: pos + f.qty, avgPx: avg, realizedUsd: null });
      pos += f.qty;
    } else {
      // A fill bigger than the position (a flip) closes this trip; the excess belongs to the next trip.
      const q = Math.min(f.qty, pos);
      const realized = dir * (f.price - avg) * pointValue * q;
      pos -= q;
      out.push({ ...f, qty: q, role: pos === 0 ? "close" : "reduce", posAfter: pos, avgPx: avg, realizedUsd: realized });
    }
  }
  return out;
}

export interface PnlNow { pos: number; avgPx: number | null; openUsd: number; bankedUsd: number }
/** Position and P&L as of `untilMs`, marking what is still on at `markPx` (the last shown bar's close). */
export function pnlAt(side: "long" | "short", execs: Execution[], pointValue: number, untilMs: number, markPx: number): PnlNow {
  const dir = side === "long" ? 1 : -1;
  let pos = 0, avg: number | null = null, banked = 0;
  for (const e of execs) {
    if (Date.parse(e.ts) >= untilMs) break;
    pos = e.posAfter; avg = e.avgPx;
    if (e.realizedUsd != null) banked += e.realizedUsd;
  }
  return { pos, avgPx: pos > 0 ? avg : null, openUsd: pos > 0 && avg != null ? dir * (markPx - avg) * pointValue * pos : 0, bankedUsd: banked };
}

/** Plain-English verb for a fill: "opened short", "added", "covered 5", "sold 10". */
export function execVerb(side: "long" | "short", e: Execution): string {
  if (e.role === "open") return `opened ${side}`;
  if (e.role === "add") return `added ${e.qty}`;
  const exit = side === "long" ? "sold" : "covered";
  return e.role === "close" ? `${exit} ${e.qty} · flat` : `${exit} ${e.qty}`;
}

/** Whole dollars with a sign and thousands separators: +$2,743 · -$108. ASCII minus so the pixel font can draw it. */
export const usd0 = (n: number) => `${n < 0 ? "-" : "+"}$${Math.round(Math.abs(n)).toLocaleString("en-US")}`;
