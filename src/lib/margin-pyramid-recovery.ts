import { symbolBase } from "./kraken-pairs";

export interface PyramidMarker { parent: string; ts: number; txid?: string; ledgered?: boolean }
export interface PyramidPosition { ordertxid: string; id: string; pair: string; side: string }
export type PyramidRecovery =
  | { status: "clear" }
  | { status: "recovered"; note: string }
  | { status: "unresolved"; reason: string; pair?: string };

export function parsePyramidMarker(raw: string | null): PyramidMarker | null {
  if (raw == null || raw === "") return null;
  const m = JSON.parse(raw) as Partial<PyramidMarker> | null;
  if (!m || typeof m.parent !== "string" || !m.parent.trim() || !Number.isFinite(m.ts) || !(m.ts! > 0)
    || (m.txid != null && (typeof m.txid !== "string" || !m.txid.trim()))
    || (m.ledgered != null && typeof m.ledgered !== "boolean")) throw new Error("invalid pyramid marker");
  return m as PyramidMarker;
}

export function recoveryBlocksPair(result: PyramidRecovery, pair: string): boolean {
  return result.status === "unresolved" && (!result.pair || symbolBase(result.pair) === symbolBase(pair));
}

// Unknown acceptance never expires into permission. A matching ledger link is the receipt;
// the marker's own ledgered flag is not proof that the ownership ledger still contains it.
export async function recoverPyramidWithIO(positions: PyramidPosition[], io: {
  readMarker: () => Promise<PyramidMarker | null>;
  ledgerCorrupt: boolean;
  isOurs: (p: PyramidPosition) => boolean;
  ledgerHas: (txid: string) => boolean;
  parentOf: (txid: string) => string | null;
  record: (marker: PyramidMarker, parent: PyramidPosition) => Promise<boolean>;
  markLedgered: (marker: PyramidMarker) => Promise<void>;
}): Promise<PyramidRecovery> {
  let pair: string | undefined;
  const blocked = (reason: string): PyramidRecovery => ({ status: "unresolved", reason, ...(pair ? { pair } : {}) });
  try {
    const marker = await io.readMarker();
    if (!marker) return { status: "clear" };
    const parent = positions.find((p) => p.ordertxid === marker.parent);
    const add = marker.txid ? positions.find((p) => p.ordertxid === marker.txid) : undefined;
    pair = parent?.pair ?? add?.pair;
    if (io.ledgerCorrupt) return blocked("ownership ledger is corrupt");
    if (!marker.txid) return blocked("pending add has no confirmed order transaction ID");
    if (io.ledgerHas(marker.txid)) {
      if (io.parentOf(marker.txid) !== marker.parent) return blocked("pending add's ledger parent does not match its marker");
      // Already durable: failure to tidy the marker does not invalidate the ledger receipt.
      await io.markLedgered(marker).catch(() => {});
      return { status: "clear" };
    }
    if (!parent || !io.isOurs(parent)) return blocked("pending add's owned parent is not confirmed");
    if (!add || symbolBase(add.pair) !== symbolBase(parent.pair) || add.side !== parent.side) return blocked("pending add's exact position is not confirmed on its parent's pair and side");
    if (!(await io.record(marker, parent))) return blocked("pending add ownership could not be persisted");
    await io.markLedgered(marker).catch(() => {});
    return { status: "recovered", note: `recovered pyramid add ${marker.txid} on ${parent.pair} as an add-on of ${marker.parent}` };
  } catch (e) {
    return blocked(`pyramid recovery unavailable: ${String(e).slice(0, 120)}`);
  }
}

// A new tranche, including an unledgered add, invalidates the snapshot book. Never replace
// pair-wide stops with cover for just the subset the old snapshot happened to recognise.
export function bookExposureMatches(book: number, pairSide: number): boolean {
  return Number.isFinite(book) && Number.isFinite(pairSide) && book >= 0 && pairSide >= 0
    && Math.abs(pairSide - book) <= Math.max(1e-10, pairSide * 1e-8);
}

export function entryExposureRefusal(positions: { side: string; owned: boolean }[], wantSide: string): string | null {
  if (positions.some((p) => !p.owned)) return "manual or unconfirmed position already exists on the pair";
  if (positions.some((p) => p.side !== wantSide)) return "opposing position already exists on the pair; entry would net against it";
  return null;
}
