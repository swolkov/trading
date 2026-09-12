import { createHash } from "node:crypto";
import { prisma } from "./db";
import { OPTIONS_OBSERVATION_PREFIX, parseOptionsObservation, type OptionsObservation } from "./options-evidence-model";

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
