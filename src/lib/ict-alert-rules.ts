// ICT SETUPS → SLACK — pure rules (Sep 24 2026). The ICT Setups indicator (tradingview/ict-core.pine), with its
// "Slack webhook secret" input filled, posts one JSON message each time its ACTION RIGHT NOW changes:
//   { "secret": "…", "room": "trading", "kind": "ict", "symbol": "MES", "tf": "5", "action": "ENTRY_READY",
//     "side": "short", "zoneLo": 7729.25, "zoneHi": 7731.75, "entry": 7729.25, "stop": 7739.25, "tp1": 7722, "tp1s": "15M SL",
//     "tp2": 7716.5, "tp3": 7713.75, "cancelAt": 1758729900000, "bar": 1758729600000, "why": "" }
// This turns it into one plain-English Slack line: what to do now, which order, where, and when to cancel. It is
// INFORMATION, never a signal to any executor (the room has no order path), and the 15-year test of the rule is
// negative on MES/MNQ/MGC — the ENTRY READY line says so. Pure; unit-tested.
import { etParts, type RoomSymbol } from "@/lib/trading-room-rules";

export type IctAction = "PREPARE" | "ENTRY_READY" | "MISSED" | "INVALIDATED";
const ACTIONS: IctAction[] = ["PREPARE", "ENTRY_READY", "MISSED", "INVALIDATED"];
const ROOT_TO_SYMBOL: Record<string, RoomSymbol> = { ES: "MES", MES: "MES", NQ: "MNQ", MNQ: "MNQ", GC: "MGC", MGC: "MGC" };

export interface IctAlert {
  id: string;             // symbol|tf|action|side|bar — a TradingView retry of the same bar is one alert
  symbol: RoomSymbol;
  tf: string;             // the chart's timeframe ("5" is the tested one)
  action: IctAction;
  side: 1 | -1;
  zoneLo: number | null;
  zoneHi: number | null;
  entry: number;
  stop: number;
  tp1: number | null;
  tp1s: string;
  tp2: number | null;
  tp3: number | null;
  cancelAt: number | null;
  bar: number;
  why: string;
}
export type ParsedIct = { ok: true; alert: IctAlert } | { ok: false; reason: string };

const num = (x: unknown): number | null => {
  const n = typeof x === "number" ? x : typeof x === "string" && x.trim() !== "" ? Number(x) : NaN;
  return Number.isFinite(n) ? n : null;
};
const clean = (x: unknown, max: number): string => (typeof x === "string" ? x.replace(/[<>&`*_~]/g, "").slice(0, max) : "");

export function parseIctAlert(body: unknown): ParsedIct {
  if (typeof body !== "object" || body === null) return { ok: false, reason: "not an object" };
  const b = body as Record<string, unknown>;
  if (b.room !== "trading" || b.kind !== "ict") return { ok: false, reason: "not an ICT message" };
  const symbol = ROOT_TO_SYMBOL[String(b.symbol ?? "").toUpperCase().replace(/[^A-Z]/g, "")];
  if (!symbol) return { ok: false, reason: `symbol '${String(b.symbol ?? "")}' is not one of ES/NQ/GC or their micros` };
  const action = ACTIONS.find((a) => a === b.action);
  if (!action) return { ok: false, reason: "action must be PREPARE, ENTRY_READY, MISSED or INVALIDATED" };
  const side = b.side === "long" ? 1 : b.side === "short" ? -1 : 0;
  if (!side) return { ok: false, reason: "side must be long or short" };
  const entry = num(b.entry), stop = num(b.stop), bar = num(b.bar);
  if (entry == null || entry <= 0 || stop == null || stop <= 0) return { ok: false, reason: "entry/stop missing" };
  if ((entry - stop) * side <= 0) return { ok: false, reason: "stop is not on the loss side" };
  if (bar == null || bar < 1e12) return { ok: false, reason: "bar time missing" };
  const tf = clean(b.tf, 8) || "?";
  const cancelAt = num(b.cancelAt);
  return {
    ok: true,
    alert: {
      id: `${symbol}|${tf}|${action}|${side === 1 ? "L" : "S"}|${bar}`,
      symbol, tf, action, side: side as 1 | -1,
      zoneLo: num(b.zoneLo), zoneHi: num(b.zoneHi), entry, stop,
      tp1: num(b.tp1), tp1s: clean(b.tp1s, 40), tp2: num(b.tp2), tp3: num(b.tp3),
      cancelAt: cancelAt != null && cancelAt > 1e12 ? cancelAt : null,
      bar, why: clean(b.why, 160),
    },
  };
}

const DECIMALS: Record<RoomSymbol, number> = { MES: 2, MNQ: 2, MGC: 1 };

/** The Slack line. Every price the order needs is in it; nothing is phrased as a recommendation to trade. */
export function ictText(a: IctAlert): string {
  const px = (x: number | null) => (x == null ? "—" : x.toLocaleString("en-US", { minimumFractionDigits: DECIMALS[a.symbol], maximumFractionDigits: DECIMALS[a.symbol] }));
  const side = a.side === 1 ? "LONG" : "SHORT";
  const order = a.side === 1 ? "BUY LIMIT" : "SELL LIMIT";
  const tfTxt = a.tf === "5" ? "5m" : `${a.tf}m`;
  const risk = Math.abs(a.entry - a.stop);
  const r = (tp: number | null) => (tp == null || risk <= 0 ? "" : ` (${(((tp - a.entry) * a.side) / risk).toFixed(1)}R)`);
  const zone = a.zoneLo != null && a.zoneHi != null ? `${px(a.zoneLo)}–${px(a.zoneHi)}` : "—";
  const tps = `TP1 ${px(a.tp1)}${a.tp1s ? ` ${a.tp1s}` : ""}${r(a.tp1)}` + (a.tp2 != null ? ` · TP2 ${px(a.tp2)}${r(a.tp2)}` : "") + (a.tp3 != null ? ` · TP3 ${px(a.tp3)}${r(a.tp3)}` : "");
  const head = `ICT ${a.symbol} ${tfTxt}`;
  const untested = a.tf === "5" ? "" : ` ⚠️ ${tfTxt} chart — untested; the 15-yr tested version is the 5m chart.`;
  switch (a.action) {
    case "PREPARE":
      return `🟡 ${head} · PREPARE ${side} — ${a.side === 1 ? "bullish" : "bearish"} iFVG ${zone}. Nothing to place yet. ` +
        `If a candle retests the zone and CLOSES holding it, it becomes ENTRY READY: ${order} ${px(a.entry)} · stop ${px(a.stop)} (${px(risk)} pts) · ${tps}.${untested}`;
    case "ENTRY_READY":
      return `🟢 ${head} · ENTRY READY ${side} — place ${order} ${px(a.entry)} now (not market). Stop ${px(a.stop)} (${px(risk)} pts) · ${tps}. ` +
        `Fills only if price comes back to ${px(a.entry)}.` + (a.cancelAt ? ` Cancel at ${etParts(a.cancelAt).hhmm} ET if unfilled — do not chase.` : " Cancel after 3 candles if unfilled — do not chase.") +
        ` Not a proven edge (15-yr test negative).${untested}`;
    case "MISSED":
      return `⚪ ${head} · MISSED — DO NOT CHASE (${side}). Cancel the ${order} at ${px(a.entry)} if it is still working.${a.why ? ` ${a.why}` : ""}`;
    case "INVALIDATED":
      return `🔴 ${head} · INVALIDATED — CANCEL the ${order} at ${px(a.entry)}.${a.why ? ` ${a.why}` : ""}`;
  }
}
