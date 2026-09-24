import assert from "node:assert/strict";
import test from "node:test";
import { ictText, parseIctAlert, type IctAlert } from "../src/lib/ict-alert-rules";

// Thu Sep 24 2026, 11:30 ET = 15:30Z (EDT). The 5-minute bar opened 11:30; the order window ends 11:50.
const BAR = Date.parse("2026-09-24T15:30:00Z");
const body = (o: Record<string, unknown> = {}) => ({
  secret: "x", room: "trading", kind: "ict", symbol: "MES", tf: "5", action: "ENTRY_READY", side: "short",
  zoneLo: 7729.25, zoneHi: 7731.75, entry: 7729.25, stop: 7739.25, tp1: 7722, tp1s: "15M SL", tp2: 7716.5, tp3: null,
  cancelAt: BAR + 20 * 60_000, bar: BAR, why: "", ...o,
});
const alert = (o: Record<string, unknown> = {}): IctAlert => (parseIctAlert(body(o)) as { ok: true; alert: IctAlert }).alert;

test("parse: a good ENTRY READY, ES maps to MES, the id is symbol|tf|action|side|bar", () => {
  const p = parseIctAlert(body({ symbol: "ES" }));
  assert.ok(p.ok);
  if (p.ok) { assert.equal(p.alert.symbol, "MES"); assert.equal(p.alert.side, -1); assert.equal(p.alert.id, `MES|5|ENTRY_READY|S|${BAR}`); assert.equal(p.alert.tp3, null); }
});

test("parse refuses: stop on the wrong side, unknown action/symbol/side, missing bar", () => {
  assert.equal(parseIctAlert(body({ stop: 7720 })).ok, false);
  assert.equal(parseIctAlert(body({ action: "BUY" })).ok, false);
  assert.equal(parseIctAlert(body({ symbol: "CL" })).ok, false);
  assert.equal(parseIctAlert(body({ side: "up" })).ok, false);
  assert.equal(parseIctAlert(body({ bar: null })).ok, false);
  assert.equal(parseIctAlert(body({ kind: "setup" })).ok, false);
  assert.equal(parseIctAlert(body({ side: "long", stop: 7719.25 })).ok, true);
});

test("ENTRY READY line: the order, where, stop distance, targets with R, cancel time in ET, not a call", () => {
  const t = ictText(alert());
  assert.match(t, /ENTRY READY SHORT/);
  assert.match(t, /place SELL LIMIT 7,729\.25 now \(not market\)/);
  assert.match(t, /Stop 7,739\.25 \(10\.00 pts\)/);
  assert.match(t, /TP1 7,722\.00 15M SL \(0\.7R\)/);
  assert.match(t, /TP2 7,716\.50 \(1\.3R\)/);
  assert.doesNotMatch(t, /TP3/);
  assert.match(t, /Cancel at 11:50 ET if unfilled — do not chase/);
  assert.match(t, /Not a proven edge/);
  assert.doesNotMatch(t, /untested/);
});

test("PREPARE says nothing to place yet and gives the planned order; MISSED/INVALIDATED say cancel", () => {
  const p = ictText(alert({ action: "PREPARE", side: "long", entry: 7731.75, stop: 7721.75, tp1: 7740, tp2: null, cancelAt: 0 }));
  assert.match(p, /PREPARE LONG — bullish iFVG 7,729\.25–7,731\.75\. Nothing to place yet/);
  assert.match(p, /BUY LIMIT 7,731\.75/);
  assert.match(ictText(alert({ action: "MISSED", why: "MISSED — limit not filled within 3 bars (cancelled)" })), /MISSED — DO NOT CHASE \(SHORT\)\. Cancel the SELL LIMIT at 7,729\.25.*not filled within 3 bars/);
  assert.match(ictText(alert({ action: "INVALIDATED" })), /INVALIDATED — CANCEL the SELL LIMIT at 7,729\.25/);
});

test("a 1-minute chart is flagged untested; gold prints one decimal; Slack markup is stripped", () => {
  assert.match(ictText(alert({ tf: "1" })), /ICT MES 1m .*⚠️ 1m chart — untested/);
  const g = ictText(alert({ symbol: "MGC", zoneLo: 4289.1, zoneHi: 4292.3, entry: 4289.1, stop: 4295.4, tp1: 4280, tp2: null }));
  assert.match(g, /SELL LIMIT 4,289\.1 now/);
  assert.match(ictText(alert({ action: "MISSED", why: "<!channel> *bold*" })), /MISSED.*!channel bold$/);
});
