// THE REPLAY: one round trip, the 1-minute bars around it, his fills, the level set as it stood at entry,
// and the stop the room saw. Read-only, assembled on request for the journal's replay panel.
import { prisma } from "@/lib/db";
import { getHistoricalBars, getIntradayBars } from "@/lib/yahoo";
import { INSTRUMENTS, buildLevels, type Bar, type LevelSet, type RoomSymbol } from "@/lib/trading-room-rules";

export interface ReplayFill { id: number; ts: string; action: "Buy" | "Sell"; qty: number; price: number }
export interface ReplayView {
  trip: { id: string; symbol: RoomSymbol; side: "long" | "short"; qty: number; entryTs: string; exitTs: string; entryPx: number; exitPx: number; netUsd: number; netR: number | null; stopPx: number | null; riskUsd: number | null; riskSource: string; mfeR: number | null; maeR: number | null; open: boolean };
  bars: Bar[];                // 1-minute, from an hour before entry to an hour after exit (or now)
  fills: ReplayFill[];
  levels: { name: string; price: number }[];
  levelsAt: string | null;    // when the level set is measured (entry time)
  note: string | null;
}

const PAD_MS = 60 * 60_000;

export async function replayView(id: string): Promise<ReplayView | null> {
  const rows = await prisma.$queryRawUnsafe<Record<string, unknown>[]>(`SELECT * FROM trading_room_trades WHERE id = $1`, id);
  const r = rows[0];
  if (!r) return null;
  const symbol = String(r.symbol) as RoomSymbol;
  const spec = INSTRUMENTS[symbol];
  if (!spec) return null;
  const entryMs = new Date(r.entry_ts as Date).getTime(), exitMs = new Date(r.exit_ts as Date).getTime();
  const fillIds: number[] = (() => { try { return JSON.parse(String(r.fill_ids ?? "[]")); } catch { return []; } })();
  const fills = fillIds.length
    ? (await prisma.$queryRawUnsafe<{ id: number; ts: Date; action: string; qty: number; price: number }[]>(`SELECT id, ts, action, qty, price FROM trading_room_fills WHERE id = ANY($1::bigint[]) ORDER BY ts`, fillIds))
      .map((f): ReplayFill => ({ id: Number(f.id), ts: new Date(f.ts).toISOString(), action: f.action === "Buy" ? "Buy" : "Sell", qty: Number(f.qty), price: Number(f.price) }))
    : [];
  // One click at the broker can land as several fills in the same second (18 + 2). Shown as one: the sum, at the average price.
  const merged: ReplayFill[] = [];
  for (const f of fills) {
    const last = merged[merged.length - 1];
    if (last && last.action === f.action && Math.abs(Date.parse(f.ts) - Date.parse(last.ts)) < 60_000) { const q = last.qty + f.qty; last.price = (last.price * last.qty + f.price * f.qty) / q; last.qty = q; }
    else merged.push({ ...f });
  }
  const levels: { name: string; price: number }[] = [];
  let bars: Bar[] = [], note: string | null = null, levelsAt: string | null = null;
  try {
    const y = spec.yahoo;
    const [i1, i5, hist] = await Promise.all([getIntradayBars(y, "1m", "7d"), getIntradayBars(y, "5m", "5d"), getHistoricalBars(y, 45)]);
    const conv = (b: { t: number; o: number; h: number; l: number; c: number; v: number }): Bar => ({ t: b.t * 1000, o: b.o, h: b.h, l: b.l, c: b.c, v: b.v });
    const from = entryMs - PAD_MS, to = Math.min(Date.now(), (r.open ? Date.now() : exitMs) + PAD_MS);
    bars = i1.filter((b) => b.t > 0).map(conv).filter((b) => b.t >= from && b.t <= to);
    if (!bars.length) note = "Yahoo keeps 1-minute bars for about 7 days; this trade is older than that, so there is no chart to replay. The numbers on the row are the record.";
    const daily = hist.filter((b) => b.t).map((b) => ({ t: Date.parse(b.t), o: b.o, h: b.h, l: b.l, c: b.c, v: b.v ?? 0 }));
    const lv: LevelSet = buildLevels(spec, i5.filter((b) => b.t > 0).map(conv).filter((b) => b.t <= entryMs), daily.filter((b) => b.t <= entryMs), entryMs);
    levelsAt = new Date(entryMs).toISOString();
    if (lv.priorDay) levels.push({ name: "Prior-day high", price: lv.priorDay.high }, { name: "Prior-day low", price: lv.priorDay.low }, { name: "Prior-day close", price: lv.priorDay.close });
    if (lv.overnight) levels.push({ name: "Overnight high", price: lv.overnight.high }, { name: "Overnight low", price: lv.overnight.low });
    if (lv.week) levels.push({ name: "Week high", price: lv.week.high }, { name: "Week low", price: lv.week.low });
    if (lv.openingRange?.complete) levels.push({ name: "OR high", price: lv.openingRange.high }, { name: "OR low", price: lv.openingRange.low });
    if (lv.vwap != null) levels.push({ name: "VWAP", price: lv.vwap });
  } catch (e) { note = `Bars could not be loaded: ${String(e).slice(0, 120)}`; }
  return {
    trip: {
      id: String(r.id), symbol, side: r.side === "short" ? "short" : "long", qty: Number(r.qty), entryTs: new Date(entryMs).toISOString(), exitTs: new Date(exitMs).toISOString(),
      entryPx: Number(r.entry_px), exitPx: Number(r.exit_px), netUsd: Number(r.net_usd), netR: r.net_r == null ? null : Number(r.net_r), stopPx: r.stop_px == null ? null : Number(r.stop_px),
      riskUsd: r.risk_usd == null ? null : Number(r.risk_usd), riskSource: String(r.risk_source ?? "none"), mfeR: r.mfe_r == null ? null : Number(r.mfe_r), maeR: r.mae_r == null ? null : Number(r.mae_r), open: Boolean(r.open),
    },
    bars, fills: merged.map((f) => ({ ...f, price: Math.round(f.price * 100) / 100 })), levels, levelsAt, note,
  };
}

// ---- the replay as a PNG for Slack: candles, fills, levels, entry / exit / stop ----
import { Raster, type RGBA } from "@/lib/trading-room-png";
import { createHmac, timingSafeEqual } from "node:crypto";

const C = {
  bg: [17, 19, 24, 255] as RGBA, grid: [255, 255, 255, 14] as RGBA, fg: [220, 222, 228, 255] as RGBA, muted: [140, 144, 155, 255] as RGBA,
  up: [74, 222, 128, 255] as RGBA, down: [248, 113, 113, 255] as RGBA, gold: [226, 182, 74, 255] as RGBA, level: [255, 255, 255, 110] as RGBA, stop: [248, 113, 113, 255] as RGBA,
};

export function renderReplayPng(v: ReplayView): Buffer {
  const W = 960, H = 480, L = 12, R = 88, T = 34, B = 26;
  const r = new Raster(W, H, C.bg);
  const bars = v.bars;
  const title = `${v.trip.symbol} ${v.trip.side.toUpperCase()} X${v.trip.qty}  ${v.trip.entryPx} TO ${v.trip.exitPx}  NET ${v.trip.netUsd >= 0 ? "+" : "-"}$${Math.abs(Math.round(v.trip.netUsd))}${v.trip.netR != null ? `  ${v.trip.netR >= 0 ? "+" : "-"}${Math.abs(v.trip.netR).toFixed(2)}R` : ""}`;
  r.text(L, 10, title, C.fg, 2);
  if (!bars.length) { r.text(L, T + 20, "NO 1-MINUTE BARS FOR THIS TRADE", C.muted, 2); return r.png(); }
  const prices = [...bars.flatMap((b) => [b.h, b.l]), v.trip.entryPx, v.trip.exitPx, ...(v.trip.stopPx != null ? [v.trip.stopPx] : [])];
  let lo = Math.min(...prices), hi = Math.max(...prices);
  const near = v.levels.filter((l) => l.price >= lo - (hi - lo) * 0.6 && l.price <= hi + (hi - lo) * 0.6);   // levels close to the action only
  for (const l of near) { lo = Math.min(lo, l.price); hi = Math.max(hi, l.price); }
  const pad = (hi - lo) * 0.06 || 1; lo -= pad; hi += pad;
  const t0 = bars[0].t, t1 = bars[bars.length - 1].t + 60_000;
  const X = (t: number) => L + ((t - t0) / (t1 - t0)) * (W - L - R);
  const Y = (p: number) => T + ((hi - p) / (hi - lo)) * (H - T - B);
  // grid + price labels
  const steps = 6;
  for (let i = 0; i <= steps; i++) { const p = lo + ((hi - lo) * i) / steps, y = Y(p); r.line(L, y, W - R, y, C.grid); r.text(W - R + 6, y - 3, fmtPx(v.trip.symbol, p), C.muted, 1); }
  // time labels every ~15 minutes
  const span = t1 - t0, step = span > 4 * 3_600_000 ? 60 * 60_000 : span > 90 * 60_000 ? 15 * 60_000 : 5 * 60_000;
  for (let t = Math.ceil(t0 / step) * step; t < t1; t += step) { const x = X(t); r.line(x, T, x, H - B, C.grid); r.text(x - 10, H - B + 8, etHm(t), C.muted, 1); }
  // levels at entry
  for (const l of near) { const y = Y(l.price); r.line(L, y, W - R, y, C.level, 4); r.text(L + 4, y - 7, l.name.toUpperCase(), C.muted, 1); }
  // candles
  const bw = Math.max(1, Math.floor((W - L - R) / bars.length) - 1);
  for (const b of bars) {
    const x = X(b.t), c = b.c >= b.o ? C.up : C.down;
    r.line(x + bw / 2, Y(b.h), x + bw / 2, Y(b.l), c);
    const yo = Y(b.o), yc = Y(b.c);
    r.rect(x, Math.min(yo, yc), bw, Math.max(1, Math.abs(yc - yo)), c);
  }
  // entry / exit / stop
  r.line(L, Y(v.trip.entryPx), W - R, Y(v.trip.entryPx), C.gold); r.text(W - R - 40, Y(v.trip.entryPx) - 7, "ENTRY", C.gold, 1);
  if (!v.trip.open) { r.line(L, Y(v.trip.exitPx), W - R, Y(v.trip.exitPx), C.gold); r.text(W - R - 36, Y(v.trip.exitPx) - 7, "EXIT", C.gold, 1); }
  if (v.trip.stopPx != null) { r.line(L, Y(v.trip.stopPx), W - R, Y(v.trip.stopPx), C.stop); r.text(W - R - 36, Y(v.trip.stopPx) - 7, "STOP", C.stop, 1); }
  // fills
  for (const f of v.fills) {
    const x = X(Date.parse(f.ts)) + bw / 2, y = Y(f.price);
    if (f.action === "Buy") { r.triangle(x, y + 10, 6, true, C.up); r.text(x - 8, y + 18, `B${f.qty}`, C.up, 1); }
    else { r.triangle(x, y - 10, 6, false, C.down); r.text(x - 8, y - 24, `S${f.qty}`, C.down, 1); }
  }
  return r.png();
}
const fmtPx = (sym: string, p: number) => (sym === "MGC" ? p.toFixed(1) : p.toFixed(2));
const etHm = (ms: number) => new Date(ms).toLocaleTimeString("en-US", { timeZone: "America/New_York", hour12: false, hour: "2-digit", minute: "2-digit" });

/** A short signature so the replay image can be served on the public webhook path without a session. */
export function replaySignature(id: string): string | null {
  const secret = process.env.TRADING_ROOM_WEBHOOK_SECRET;
  if (!secret) return null;
  return createHmac("sha256", secret).update(`replay:${id}`).digest("hex").slice(0, 32);
}
export function replaySignatureOk(id: string, sig: string): boolean {
  const want = replaySignature(id);
  if (!want || sig.length !== want.length) return false;
  return timingSafeEqual(Buffer.from(want), Buffer.from(sig));
}
export function replayImageUrl(id: string): string | null {
  const sig = replaySignature(id);
  if (!sig) return null;
  const base = (process.env.PUBLIC_APP_URL ?? "https://trading-eta-snowy.vercel.app").replace(/\/$/, "");
  return `${base}/api/webhook/trading-room/replay?id=${encodeURIComponent(id)}&sig=${sig}`;
}
