import assert from "node:assert/strict";
import test from "node:test";
import { matchLiveFills, divergenceSummary, journalBlock, type PaperLiveRow, type TradeRow } from "../src/lib/margin-synthesis";

const row = (id: number, liveTxid: string, time: string, extra: Partial<PaperLiveRow> = {}): PaperLiveRow => ({
  id, time, symbol: "BTC/USD", side: "buy", source: "selective", leverage: 2, markPrice: 100_100, shadowStatus: "resolved", shadowExit: 103_000, shadowPnl: 50, shadowFees: 4, shadowReason: "trail", shadowResolvedAt: null, liveTxid, ...extra,
});
const trade = (txid: string, ordertxid: string, time: string, type: string, price: number, vol: number, extra: Partial<TradeRow> = {}): TradeRow => ({
  txid, ordertxid, pair: "XBTUSD", time, type, price, cost: price * vol, fee: price * vol * 0.0025, vol, margin: 0, posstatus: "", ...extra,
});

test("a live entry matches its fills and the next FIFO close on the pair; spot fills are ignored", () => {
  const rows = [row(1, "O1", "2026-09-06T10:00:00Z")];
  const trades = [
    trade("T1", "O1", "2026-09-06T10:00:01Z", "buy", 100_150, 0.001, { margin: 50 }),
    trade("TSPOT", "OX", "2026-09-06T10:30:00Z", "sell", 101_000, 0.001),                 // spot, not a close
    trade("T2", "O2", "2026-09-06T11:00:00Z", "sell", 102_000, 0.001, { posstatus: "closed" }),
  ];
  const [f] = matchLiveFills(rows, trades);
  assert.equal(f.closed, true);
  assert.equal(f.realEntry, 100_150);
  assert.equal(f.realExit, 102_000);
  assert.ok(Math.abs((f.entrySlipBp ?? 0) - 15) < 0.01, `slippage vs the 100,000 signal should be 15bp, got ${f.entrySlipBp}`);
  assert.ok(f.realNet != null && f.realNet > 0);
  assert.equal(f.side, "long");
});

test("two entries, one big close: the close is allocated FIFO and never reused", () => {
  const rows = [row(1, "O1", "2026-09-06T10:00:00Z"), row(2, "O2", "2026-09-06T10:05:00Z")];
  const trades = [
    trade("T1", "O1", "2026-09-06T10:00:01Z", "buy", 100_000, 0.001, { margin: 50 }),
    trade("T2", "O2", "2026-09-06T10:05:01Z", "buy", 100_500, 0.001, { margin: 50 }),
    trade("T3", "O9", "2026-09-06T12:00:00Z", "sell", 101_000, 0.0015, { posstatus: "closed" }),
    trade("T4", "O9", "2026-09-06T12:00:01Z", "sell", 101_100, 0.0005, { posstatus: "closed" }),
  ];
  const [a, b] = matchLiveFills(rows, trades);
  assert.equal(a.closed, true); assert.equal(a.realExit, 101_000);
  assert.equal(b.closed, true);
  assert.ok(Math.abs((b.realExit ?? 0) - 101_050) < 1e-6, `second exit is half of T3 and all of T4 → 101,050, got ${b.realExit}`);
});

test("an open live position is reported open, with no exit and no net", () => {
  const [f] = matchLiveFills([row(1, "O1", "2026-09-06T10:00:00Z")], [trade("T1", "O1", "2026-09-06T10:00:01Z", "buy", 100_000, 0.001, { margin: 50 })]);
  assert.equal(f.closed, false); assert.equal(f.realExit, null); assert.equal(f.realNet, null);
});

test("divergence: round-trip fills are excluded; big slippage or fees flag STOP", () => {
  const fills = matchLiveFills(
    [row(1, "O1", "2026-09-06T10:00:00Z"), row(2, "ORT", "2026-09-06T09:00:00Z", { source: "roundtrip" })],
    [trade("T1", "O1", "2026-09-06T10:00:01Z", "buy", 100_400, 0.001, { margin: 50 }), trade("TR", "ORT", "2026-09-06T09:00:01Z", "buy", 100_000, 0.0002, { margin: 5 })],
  );
  const d = divergenceSummary(fills);
  assert.equal(d.fills, 1, "the round trip is not a measured fill");
  assert.match(d.verdict, /DIVERGES/);
  assert.match(d.verdict, /slippage 40bp/);
  assert.equal(divergenceSummary([]).verdict, "no live fills yet");
});

test("journal block carries both books", () => {
  const [f] = matchLiveFills([row(1, "O1", "2026-09-06T10:00:00Z")], [trade("T1", "O1", "2026-09-06T10:00:01Z", "buy", 100_000, 0.001, { margin: 50 }), trade("T2", "O2", "2026-09-06T11:00:00Z", "sell", 102_000, 0.001, { posstatus: "closed" })]);
  const b = journalBlock(f);
  assert.match(b, /book: "live"/); assert.match(b, /paper_pnl: 50.00/); assert.match(b, /strategy: "kraken-margin\/selective"/);
});

test("a pyramid add-on's fills belong to the parent row: combined entry, combined close, paper rescaled by the FIRST unit", () => {
  const rows = [row(1, "O1", "2026-09-12T04:02:00Z", { source: "swing-pyr", paperNotional: 100, shadowPnl: 10 })];
  const trades = [
    trade("T1", "O1", "2026-09-12T04:02:01Z", "buy", 100, 1, { margin: 50 }),            // unit 1: $100
    trade("T2", "OADD", "2026-09-12T08:00:30Z", "buy", 104, 0.5, { margin: 25 }),       // the add: $52
    trade("T3", "O9", "2026-09-13T00:00:00Z", "sell", 110, 1.5, { posstatus: "closed" }), // one close for both
  ];
  const withLedger = matchLiveFills(rows, trades, (o) => (o === "OADD" ? "O1" : null));
  assert.equal(withLedger.length, 1);
  const f = withLedger[0];
  assert.equal(f.closed, true);
  assert.equal(f.realVol, 1.5, "both units");
  assert.ok(Math.abs(f.realEntry - 152 / 1.5) < 1e-9, "blended entry");
  assert.equal(f.realExit, 110);
  // net = (110 − 101.33) × 1.5 − fees(entry 0.38 + exit 0.4125)
  assert.ok(f.realNet != null && Math.abs(f.realNet - ((110 - 152 / 1.5) * 1.5 - (152 * 0.0025) - (165 * 0.0025))) < 1e-9);
  assert.ok(Math.abs((f.paperPnlAtLiveSize ?? 0) - 10 * (100 / 100)) < 1e-9, "paper rescaled by unit 1's $100, not the $152 combined");
  // Without the ledger the add is invisible: only unit 1 matches and the close is consumed for 1.0 only.
  const without = matchLiveFills(rows, trades);
  assert.equal(without[0].realVol, 1);
});
