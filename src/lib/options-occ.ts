// OCC SYMBOL CODEC. PURE: no imports, no I/O.
//
// Kept separate from the data adapter on purpose. OCC is an exchange standard, not a vendor
// format, so it survived the move off Alpaca untouched — and the paper-book test suite
// exercises it without needing a database or a market-data dependency, exactly as it does
// for options-paper-model.ts.

/** Parse an OCC symbol from the RIGHT — the root is variable length, so left-anchored
 *  parsing breaks on any root that is not the plain ticker (which is why the first version
 *  of the screen threw on a month out of range). */
export function parseOcc(occ: string): { root: string; expiry: string; type: "call" | "put"; strike: number } | null {
  if (occ.length < 16) return null;
  const strike = Number(occ.slice(-8)) / 1000;
  const cp = occ.slice(-9, -8);
  const ymd = occ.slice(-15, -9);
  const root = occ.slice(0, -15);
  if (!Number.isFinite(strike) || (cp !== "C" && cp !== "P")) return null;
  const yy = Number(ymd.slice(0, 2)), mm = Number(ymd.slice(2, 4)), dd = Number(ymd.slice(4, 6));
  if (!(mm >= 1 && mm <= 12 && dd >= 1 && dd <= 31)) return null;
  const expiry = `20${String(yy).padStart(2, "0")}-${String(mm).padStart(2, "0")}-${String(dd).padStart(2, "0")}`;
  return { root, expiry, type: cp === "C" ? "call" : "put", strike };
}

/**
 * Build an OCC symbol. Needed because Robinhood identifies contracts by its own UUID and
 * by (symbol, expiry, strike, type) — it does not hand back an OCC string — while this
 * book's table, its open positions and its quote inbox are all keyed on OCC.
 *
 * The strike field is EIGHT digits in THOUSANDTHS, zero padded. Getting that wrong does not
 * throw: it produces a symbol that simply never matches a stored quote, so positions would
 * quietly stop marking. `parseOcc(toOcc(...))` round-trips in the tests for that reason.
 */
export function toOcc(root: string, expiry: string, type: "call" | "put", strike: number): string {
  const [y, m, d] = expiry.split("-");
  const thousandths = Math.round(strike * 1000);
  return `${root.toUpperCase()}${y.slice(2)}${m}${d}${type === "call" ? "C" : "P"}${String(thousandths).padStart(8, "0")}`;
}
