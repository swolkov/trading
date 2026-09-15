import { createHash } from "node:crypto";
import { prisma } from "./db";
import { OPTIONS_OBSERVATION_PREFIX, parseOptionsObservation, validScoredCandidates, type OptionsObservation } from "./options-evidence-model";
import type { LedgerObservation } from "./options-score-ledger";

export function observationKey(rawCapture: string): string {
  // Identity comes from the captured broker event stream, never mutable prior display data.
  return OPTIONS_OBSERVATION_PREFIX + createHash("sha256").update(rawCapture).digest("hex");
}
export async function saveOptionsObservation(observation: OptionsObservation, rawCapture: string): Promise<void> {
  // Dedicated storage: engine configuration reads must never load a growing quote archive.
  await prisma.$executeRawUnsafe(`CREATE TABLE IF NOT EXISTS options_research_observations (
    source_key text PRIMARY KEY, captured_at timestamptz NOT NULL, screened_at timestamptz NOT NULL,
    payload jsonb NOT NULL)`);
  await prisma.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS options_research_observations_time
    ON options_research_observations(captured_at DESC, source_key DESC)`);
  await prisma.$executeRawUnsafe(`INSERT INTO options_research_observations(source_key,captured_at,screened_at,payload)
    VALUES($1,$2,$3,$4::jsonb) ON CONFLICT(source_key) DO NOTHING`, observationKey(rawCapture),
    new Date(observation.capturedAt), new Date(observation.screenedAt), JSON.stringify(observation));
}
export async function readOptionsObservationHistory(limit = 120) {
  const rows = await prisma.$queryRawUnsafe<{payload: unknown}[]>(
    `SELECT payload FROM options_research_observations ORDER BY captured_at DESC, source_key DESC LIMIT $1`,
    Math.min(120, Math.max(1, Math.floor(limit))));
  const observations = rows.map(r => parseOptionsObservation(JSON.stringify(r.payload))).filter(o => o !== null);
  return { observations, invalidRecords: rows.length - observations.length, windowLimit: 120, available: true };
}
/** The D7 ledger rows only (`payload->'candidates'`), oldest first, without loading the quote archive. Rows are small; the cap is generous. */
export async function readOptionsScoredHistory(limit = 4000): Promise<LedgerObservation[]> {
  const rows = await prisma.$queryRawUnsafe<{ screened_at: Date; candidates: unknown }[]>(
    `SELECT screened_at, payload->'candidates' AS candidates FROM options_research_observations WHERE payload ? 'candidates' ORDER BY screened_at ASC LIMIT $1`,
    Math.min(20000, Math.max(1, Math.floor(limit))));
  return rows.map(r => ({ screenedAt: r.screened_at.toISOString(), candidates: validScoredCandidates(r.candidates) ?? [] }));
}
/** Capture day + per-symbol IVs for the IV-rank archive, without the rest of the payload. */
export async function readOptionsIvHistory(limit = 400): Promise<{ capturedAt: string; quotes: { symbol: string; iv: number | null }[] }[]> {
  const rows = await prisma.$queryRawUnsafe<{ captured_at: Date; quotes: unknown }[]>(
    `SELECT captured_at, (SELECT jsonb_agg(jsonb_build_object('symbol', q->>'symbol', 'iv', q->'iv')) FROM jsonb_array_elements(payload->'quotes') q) AS quotes
     FROM options_research_observations ORDER BY captured_at DESC LIMIT $1`, Math.min(2000, Math.max(1, Math.floor(limit))));
  return rows.map(r => ({ capturedAt: r.captured_at.toISOString(), quotes: (Array.isArray(r.quotes) ? r.quotes : []).flatMap((q) => {
    const o = q as { symbol?: unknown; iv?: unknown };
    return typeof o.symbol === "string" ? [{ symbol: o.symbol, iv: typeof o.iv === "number" && Number.isFinite(o.iv) ? o.iv : null }] : [];
  }) }));
}
