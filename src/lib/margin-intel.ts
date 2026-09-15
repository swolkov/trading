// THE INTELLIGENCE STAMP (Sep 15 2026) — what the scan knew about the market when it opened a
// paper row, written onto the row so it can be measured against the outcome later. Gathered
// once per scan tick from data the tick already holds (scanUniverse's features) plus the
// guardian-written policies; NOTHING here fetches. Sections land step by step:
//   mtf   — multi-timeframe direction (B1, here)
//   event — the economic-calendar policy (B2)
//   btc   — the BTC-shock state (B3)
//   deriv — funding / open interest (B4)
// stampSql() keeps the scan route's INSERT thin: it hands back the column names and values
// for whatever sections are present, so a section that is not built yet stamps nothing.
import type { UniverseScan } from "@/lib/margin-scanner";
import { mtfState, type MtfState } from "@/lib/margin-mtf";
import { SCAN_COINS } from "@/lib/margin-scanner";

/** Bumped whenever a stamp's MEANING changes, so slices never pool two definitions. */
export const INTEL_VERSION = "i1";

export interface EventStamp { mode: "normal" | "reduced" | "paused" }
/** btc_state: unknown | calm | shock-up | shock-down (margin-btc-shock.ts btcStateStamp). */
export interface BtcStamp { state: string }
export interface Intel {
  version: string;
  mtf: Record<string, MtfState>;
  event: EventStamp | null;
  btc: BtcStamp | null;
  deriv: null;
}

export function gatherIntel(scan: Pick<UniverseScan, "features">, event: EventStamp | null = null, btc: BtcStamp | null = null): Intel {
  const mtf: Record<string, MtfState> = {};
  for (const c of SCAN_COINS) mtf[c.name] = mtfState(scan.features, c.name);
  return { version: INTEL_VERSION, mtf, event, btc, deriv: null };
}

export type StampValue = string | number | null;
/** Columns + values to append to the paper row INSERT for `coin`. Always mtf_state and intel_version. */
export function stampSql(intel: Intel, coin: string): { columns: string[]; values: StampValue[] } {
  const columns = ["mtf_state", "intel_version"];
  const values: StampValue[] = [intel.mtf[coin]?.text ?? null, intel.version];
  if (intel.event) { columns.push("event_mode"); values.push(intel.event.mode); }
  if (intel.btc) { columns.push("btc_state"); values.push(intel.btc.state); }
  return { columns, values };
}
