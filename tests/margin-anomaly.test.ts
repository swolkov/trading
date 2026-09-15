import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { ANOMALY_KEY, GUARD_COVER_FRAC, NOTIONAL_TOLERANCE, anomalyActive, bookMatchesCard, mergeAnomaly, unledgeredBesideOurStop, type BookForCard, type CardForCheck } from "../src/lib/margin-anomaly";
import { REFUSAL_RE, refusalNote } from "../src/lib/margin-risk-tiers";
import { LIVE_STOP_RATCHET_MIN_FRAC } from "../src/lib/margin-live-risk";

// An authorised swing-pyr entry: $20k at 9×, long, stop 3,840, ledgered by the guardian.
const card: CardForCheck = { leverageUsed: 9, notional: 20_000, side: "buy" };
const book = (over: Partial<BookForCard> = {}): BookForCard => ({ txid: "OABC", leverage: 8.98, notional: 20_020, side: "long", restingStop: 3840, ledgeredStop: 3840, px: 4050, ...over });

test("a book that matches its card — leverage rounds to the rung, notional within the chase, stop at the ledgered level — is clean", () => {
  assert.deepEqual(bookMatchesCard(book(), card), { ok: true, findings: [] });
  assert.equal(bookMatchesCard(book({ notional: 20_000 * (1 + NOTIONAL_TOLERANCE) }), card).ok, true, "exactly +10% passes");
  // SMALLER is never a finding: Kraken reports the REMAINING volume, so a partial close by our own
  // closeBook, a partial liquidation or a manual reduce shrinks it — and less size is never more risk.
  assert.equal(bookMatchesCard(book({ notional: 17_000 }), card).ok, true, "15% short of the card = a partial close, not an anomaly");
  assert.equal(bookMatchesCard(book({ notional: 1_000 }), card).ok, true);
});

test("leverage 20 vs authorised 9 is the canonical finding; size and side mismatches are named per tranche", () => {
  const lev = bookMatchesCard(book({ leverage: 20 }), card);
  assert.equal(lev.ok, false);
  assert.deepEqual(lev.findings, ["OABC: leverage 20 vs authorised 9"]);
  const size = bookMatchesCard(book({ notional: 30_000 }), card);
  assert.equal(size.ok, false);
  assert.match(size.findings[0], /^OABC: notional \$30000 is LARGER than the authorised \$20000 \(\+10% allowed\)$/);
  assert.equal(bookMatchesCard(book({ notional: 22_001 }), card).ok, false, "a hair over +10% is a finding");
  const side = bookMatchesCard(book({ side: "short", restingStop: null }), card);
  assert.deepEqual(side.findings, ["OABC: side short vs authorised long"]);
  // Several findings accumulate.
  assert.equal(bookMatchesCard(book({ leverage: 20, notional: 40_000 }), card).findings.length, 2);
});

test("the resting stop may only ratchet in the trade's favour: wider than the ledgered level (beyond the ratchet tolerance) is a finding, better is not, missing is not judged here", () => {
  const tol = 4050 * LIVE_STOP_RATCHET_MIN_FRAC;   // ~2.0 at $4,050
  assert.equal(bookMatchesCard(book({ restingStop: 3840 - tol * 0.9 }), card).ok, true, "inside the tolerance");
  const wider = bookMatchesCard(book({ restingStop: 3800 }), card);
  assert.equal(wider.ok, false);
  assert.match(wider.findings[0], /resting stop 3800 is WIDER than the ledgered 3840/);
  assert.equal(bookMatchesCard(book({ restingStop: 3950 }), card).ok, true, "ratcheted up since — fine");
  // A short: wider = higher.
  const shortCard: CardForCheck = { ...card, side: "sell" };
  assert.equal(bookMatchesCard(book({ side: "short", restingStop: 4160, ledgeredStop: 4160 }), shortCard).ok, true);
  assert.equal(bookMatchesCard(book({ side: "short", restingStop: 4200, ledgeredStop: 4160 }), shortCard).ok, false);
  assert.equal(bookMatchesCard(book({ side: "short", restingStop: 4100, ledgeredStop: 4160 }), shortCard).ok, true);
  // The breach-guard state and a guard cover hugging the market are NOT widened stops: the guardian
  // (breach) and the executor's close path (0.3% re-cover of a remainder) both place them by design.
  assert.equal(bookMatchesCard(book({ restingStop: 3800, breachGuard: true }), card).ok, true, "breach-guard state: the stop rule is skipped");
  assert.equal(bookMatchesCard(book({ restingStop: 4050 * (1 - 0.003), px: 4050 }), card).ok, true, "a 0.3% guard cover below the market is exempt");
  assert.equal(bookMatchesCard(book({ restingStop: 4050 * (1 - 0.003), ledgeredStop: 4045, px: 4050 }), card).ok, true, "even against a tighter ledgered level, a guard cover is exempt");
  assert.equal(bookMatchesCard(book({ restingStop: 4050 * (1 - GUARD_COVER_FRAC * 1.5), ledgeredStop: 4045, px: 4050 }), card).ok, false, "past the guard band it is a widened stop again");
  assert.equal(bookMatchesCard(book({ side: "short", restingStop: 4050 * (1 + 0.003), ledgeredStop: 3950, px: 4050 }), { ...card, side: "sell" }).ok, true, "short: a guard cover just above the market is exempt");
  // No resting stop / no ledgered level: the naked-position guard owns that, not this check.
  assert.equal(bookMatchesCard(book({ restingStop: null }), card).ok, true);
  assert.equal(bookMatchesCard(book({ ledgeredStop: null }), card).ok, true);
  // No card (a pre-card entry): only the stop rule applies.
  assert.equal(bookMatchesCard(book({ leverage: 20, notional: 1 }), null).ok, true);
  assert.equal(bookMatchesCard(book({ leverage: 20, restingStop: 3700 }), null).findings.length, 1);
});

test("the orphan-sweep exception: our stop beside a position the ledger does not know that PREDATES the stop; a position opened after our stop falls through to the sweep", () => {
  const same = (a: string, b: string) => a.replace(/:.*$/, "") === b.replace(/:.*$/, "");
  const ours = new Set(["OMINE"]);
  const isOurs = (p: { ordertxid: string; id: string }) => ours.has(p.ordertxid);
  const stopAt = 1_760_000_000;   // the stop's opentm (epoch s)
  const stop = { pair: "XBTUSD:BTNL", side: "sell", opentm: stopAt };
  const iso = (sec: number) => new Date(sec * 1000).toISOString();
  // Bot-shaped: the position was open BEFORE our stop (an attached close[] is never older than its position).
  const before = { ordertxid: "OTHEIRS", id: "T1", pair: "XBTUSD:BTNL", side: "long", openedAt: iso(stopAt - 30) };
  assert.deepEqual(unledgeredBesideOurStop(stop, [before], isOurs, same), [{ ordertxid: "OTHEIRS", id: "T1" }], "flagged: never swept, paged with the adopt instruction");
  assert.deepEqual(unledgeredBesideOurStop(stop, [{ ...before, openedAt: iso(stopAt + 10) }], isOurs, same), [{ ordertxid: "OTHEIRS", id: "T1" }], "the same +10s slack stopProtectsLive uses");
  assert.deepEqual(unledgeredBesideOurStop(stop, [{ ...before, openedAt: "" }], isOurs, same), [{ ordertxid: "OTHEIRS", id: "T1" }], "unknown open time: cannot be proven manual, so flagged");
  // Spencer's manual trade AFTER the bot's book was hand-closed: a stale stop beside it is an orphan → the sweep path as on main.
  const after = { ...before, openedAt: iso(stopAt + 600) };
  assert.deepEqual(unledgeredBesideOurStop(stop, [after], isOurs, same), [], "provably opened after our stop: not bot-shaped, falls through to the orphan sweep");
  const manualLong = before;
  // A position of ours on the pair+side makes the stop that book's cover: the neighbour is the FIFO case, not this.
  assert.deepEqual(unledgeredBesideOurStop(stop, [manualLong, { ordertxid: "OMINE", id: "T2", pair: "XBTUSD:BTNL", side: "long", openedAt: iso(stopAt - 5) }], isOurs, same), []);
  // Wrong side (a sell-stop does not close a short) or another pair: nothing to judge.
  assert.deepEqual(unledgeredBesideOurStop(stop, [{ ...manualLong, side: "short" }], isOurs, same), []);
  assert.deepEqual(unledgeredBesideOurStop(stop, [{ ...manualLong, pair: "XETHZUSD" }], isOurs, same), []);
  // No positions at all = a plain orphan (the two-sighting sweep handles it).
  assert.deepEqual(unledgeredBesideOurStop(stop, [], isOurs, same), []);
  // Ownership unreadable this run: nothing can be judged, nothing is flagged.
  assert.deepEqual(unledgeredBesideOurStop(stop, [manualLong], null, same), []);
});

test("mergeAnomaly de-duplicates and caps; anomalyActive reads any non-blank value as set", () => {
  assert.equal(mergeAnomaly(null, ["a: x"]), "a: x");
  assert.equal(mergeAnomaly("a: x", ["a: x", "b: y"]), "a: x\nb: y");
  assert.equal(mergeAnomaly("a: x\n", []), "a: x");
  assert.equal(mergeAnomaly(null, Array.from({ length: 30 }, (_, i) => `f${i}`)).split("\n").length, 20);
  assert.equal(anomalyActive(null), false); assert.equal(anomalyActive(""), false); assert.equal(anomalyActive("  "), false);
  assert.equal(anomalyActive("OABC: leverage 20 vs authorised 9"), true);
  assert.equal(ANOMALY_KEY, "kraken_margin_anomaly");
});

test("the refusal strings match their regexes and name the first finding", () => {
  const note = refusalNote.anomaly("OABC: leverage 20 vs authorised 9\nOXYZ: notional $30000 vs authorised $20000 (±10%)");
  assert.match(note, REFUSAL_RE.anomaly);
  assert.match(note, /OABC: leverage 20 vs authorised 9 \(\+more\)/);
  assert.match(refusalNote.anomalyUnreadable("boom"), REFUSAL_RE.anomalyUnreadable);
});

test("wiring, pinned on the source: the executor reads the key STRICTLY above the exec lock and below the breaker; the guardian never sweeps an unledgered neighbour's stop; closes are untouched", () => {
  const exec = readFileSync(new URL("../src/lib/margin-executor.ts", import.meta.url), "utf8");
  const entry = exec.split("// ---- ENTRY PATH ----")[1] ?? "";
  const breaker = entry.indexOf('cfgStrict("kraken_margin_disarmed_dd")');
  const anomaly = entry.indexOf("cfgStrict(ANOMALY_KEY)");
  const lock = entry.indexOf("await acquireExecLock()");
  assert.ok(breaker > 0 && anomaly > breaker && lock > anomaly, "breaker → anomaly → exec lock");
  assert.ok(/anomalyActive\(anomaly\)\) return \{ executed: false, validated: false, note: refusalNote\.anomaly\(anomaly!\) \}/.test(entry));
  assert.ok(/refusalNote\.anomalyUnreadable\(String\(e\)\)/.test(entry), "an unreadable flag refuses");
  const closePath = exec.split("// ---- CLOSE PATH ----")[1]?.split("// ---- ENTRY PATH ----")[0] ?? "";
  assert.ok(!/ANOMALY_KEY|anomalyActive/.test(closePath), "the close path never reads the anomaly");
  const guardian = readFileSync(new URL("../src/app/api/cron/margin-watch/route.ts", import.meta.url), "utf8");
  const orphanBlock = guardian.split("for (const o of mine) {")[1]?.split("state.orphans = nextOrphans;")[0] ?? "";
  const flagged = orphanBlock.indexOf("unledgeredBesideOurStop(");
  const sweep = orphanBlock.indexOf("if (!stopProtectsLive(o)) {");
  assert.ok(flagged > 0 && sweep > flagged, "the unledgered check runs BEFORE the orphan test");
  assert.ok(/if \(unledgered\.length\) \{[\s\S]*?continue;\s*\}/.test(orphanBlock), "a flagged stop is never cancelled (continue before the sweep)");
  assert.ok(/kraken_margin_adopt_txids=\$\{ids\}/.test(orphanBlock), "the page carries the adopt instruction");
  assert.ok(/bookMatchesCard\(/.test(guardian) && /flagAnomaly\(findings, `anomaly-book-\$\{bookKey\}`/.test(guardian), "the per-book card check pages and sets the anomaly");
  assert.ok(/breachGuard: \(priorBreached\[stateKey\] \?\? 0\) > 0/.test(guardian), "the breach-guard state is passed through");
  // closeBook's remainder guard cover records the level it placed, so the next run never reads it as "wider".
  const remainder = guardian.split("remainder not re-covered")[1]?.split("if (left > 0) {")[0] ?? "";
  assert.ok(/if \(out\.placed && plan\.place\) noteStopLevel\(null, parseFloat\(plan\.place\.level\)\)/.test(remainder), "the remainder re-cover calls noteStopLevel");
  // The executor-config route exposes the key and offers the clear action; nothing in the UI tree does.
  const cfgRoute = readFileSync(new URL("../src/app/api/margin/executor-config/route.ts", import.meta.url), "utf8");
  assert.ok(/ANOMALY_KEY,\s*\]/.test(cfgRoute) || /ANOMALY_KEY,\n/.test(cfgRoute), "the GET reads the key");
  assert.ok(/action \?\? ""\) !== "clear-anomaly"/.test(cfgRoute) && /"CLEAR"/.test(cfgRoute), "clear-anomaly needs the typed word");
  assert.ok(/anomalyNote: "sticky by design/.test(cfgRoute), "the panel text says the flag is sticky and how to clear it");
  const anomalySrc = readFileSync(new URL("../src/lib/margin-anomaly.ts", import.meta.url), "utf8");
  assert.ok(/STICKY BY DESIGN/.test(anomalySrc));
});
