import assert from "node:assert/strict";
import test from "node:test";
import { matchLiveFills, divergenceSummary, journalBlock, MODEL_STOP_SLIP_BP, type PaperLiveRow, type TradeRow } from "../src/lib/margin-synthesis";

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

// ---- A4: stop-fill slippage against the ledgered level, and the journal's new fields ----

test("stop-fill slippage: measured against the ledgered stop level on STOP exits only, positive = worse, both sides", () => {
  // The short lives on another pair: on ONE pair Kraken nets FIFO, so a sell after a long IS its close.
  const rows = [row(1, "O1", "2026-09-06T10:00:00Z"), row(2, "O2", "2026-09-06T10:05:00Z", { side: "sell", symbol: "ETH/USD" })];
  const trades = [
    trade("T1", "O1", "2026-09-06T10:00:01Z", "buy", 100_000, 0.001, { margin: 50 }),
    trade("T2", "O2", "2026-09-06T10:05:01Z", "sell", 100_000, 0.001, { margin: 50, pair: "ETHUSD" }),
    // The long's stop at 96,000 filled at 95,904 (10bp worse); the short's stop at 104,000 filled at 104,208 (20bp worse).
    trade("T3", "OS1", "2026-09-06T12:00:00Z", "sell", 95_904, 0.001, { posstatus: "closed", ordertype: "stop-loss" }),
    trade("T4", "OS2", "2026-09-06T12:30:00Z", "buy", 104_208, 0.001, { posstatus: "closed", ordertype: "stop-loss", pair: "ETHUSD" }),
  ];
  const levels: Record<string, number> = { O1: 96_000, O2: 104_000 };
  const [a, b] = matchLiveFills(rows, trades, () => null, { lastStopLevelOf: (t) => levels[t] ?? null });
  assert.equal(a.exitKind, "stop"); assert.equal(a.lastStopLevel, 96_000);
  assert.ok(Math.abs((a.stopFillSlipBp ?? 0) - 10) < 1e-6, `long: (96,000 − 95,904) ÷ 96,000 = 10bp, got ${a.stopFillSlipBp}`);
  assert.equal(b.exitKind, "stop");
  assert.ok(Math.abs((b.stopFillSlipBp ?? 0) - 20) < 1e-6, `short: −1 × (104,000 − 104,208) ÷ 104,000 = 20bp, got ${b.stopFillSlipBp}`);
  // A market close (time stop / by hand) is not a stop fill: no slippage number, whatever the level says.
  const closedByMarket = matchLiveFills([row(1, "O1", "2026-09-06T10:00:00Z")], [trades[0], trade("T5", "OM", "2026-09-06T13:00:00Z", "sell", 95_000, 0.001, { posstatus: "closed", ordertype: "market" })], () => null, { lastStopLevelOf: () => 96_000 });
  assert.equal(closedByMarket[0].exitKind, "close"); assert.equal(closedByMarket[0].stopFillSlipBp, null);
  // No ledgered level → no number (never a guess); an open position → no exit kind.
  assert.equal(matchLiveFills(rows, trades)[0].stopFillSlipBp, null);
  assert.equal(matchLiveFills([row(1, "O1", "2026-09-06T10:00:00Z")], [trades[0]], () => null, { lastStopLevelOf: () => 96_000 })[0].exitKind, null);
});

test("divergence: stop-fill slippage over twice the replay's 70bp flags STOP; under it does not", () => {
  assert.equal(MODEL_STOP_SLIP_BP, 70);
  const mk = (slipBp: number) => {
    const level = 96_000; const fill = level * (1 - slipBp / 1e4);
    return matchLiveFills(
      [row(1, "O1", "2026-09-06T10:00:00Z")],
      [trade("T1", "O1", "2026-09-06T10:00:01Z", "buy", 100_000, 0.001, { margin: 50 }), trade("T3", "OS", "2026-09-06T12:00:00Z", "sell", fill, 0.001, { posstatus: "closed", ordertype: "stop-loss" })],
      () => null, { lastStopLevelOf: () => level },
    );
  };
  const bad = divergenceSummary(mk(150));
  assert.ok(Math.abs((bad.avgStopSlipBp ?? 0) - 150) < 1e-6); assert.equal(bad.stopSlipN, 1);
  assert.match(bad.verdict, /DIVERGES/); assert.match(bad.verdict, /stop-fill slippage 150bp vs 70bp modelled/);
  const fine = divergenceSummary(mk(100));
  assert.ok(!/stop-fill/.test(fine.verdict), "100bp is inside 2× the model");
  assert.equal(divergenceSummary([]).avgStopSlipBp, null);
});

test("journal block carries MAE/MFE, the stop-fill slippage, the regime, the risk tier and the grade", () => {
  const [f] = matchLiveFills(
    [row(1, "O1", "2026-09-06T10:00:00Z", { btcRegime: "up" })],
    [trade("T1", "O1", "2026-09-06T10:00:01Z", "buy", 100_000, 0.001, { margin: 50 }), trade("T2", "OS", "2026-09-06T11:00:00Z", "sell", 95_904, 0.001, { posstatus: "closed", ordertype: "stop-loss" })],
    () => null,
    { lastStopLevelOf: () => 96_000, journalOf: () => ({ mfeR: 0.4, maeR: 1.02, exitReason: null, riskTier: "1", grade: "A+" }) },
  );
  const b = journalBlock(f);
  for (const line of ['exit_kind: "stop"', "stop_fill_slippage_bp: 10.0", "mfe_r: 0.40", "mae_r: 1.02", 'regime: "up"', 'risk_tier: "1"', 'grade: "A+"']) assert.ok(b.includes(line), `journal is missing ${line}`);
  // The old fields are still there.
  assert.match(b, /book: "live"/); assert.match(b, /paper_pnl_at_live_size/);
  // Without any context every new field prints an empty/zero value, never throws.
  const bare = journalBlock(matchLiveFills([row(1, "O1", "2026-09-06T10:00:00Z")], [trade("T1", "O1", "2026-09-06T10:00:01Z", "buy", 100_000, 0.001, { margin: 50 })])[0]);
  assert.ok(bare.includes('regime: ""') && bare.includes("mae_r: 0") && bare.includes('exit_kind: ""'));
});
