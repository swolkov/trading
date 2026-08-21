/**
 * Production deploy gate for the Databento sidecar.
 * Requires six coherent quote rows continuously for three minutes before an engine may deploy.
 */
import pg from "pg";

const REQUIRED = ["ES", "MES", "NQ", "MNQ", "GC", "MGC"] as const;
const MAX_AGE_MS = 90_000;
const READY_TIMEOUT_MS = 120_000;
const OBSERVE_MS = 180_000;
const POLL_MS = 5_000;

const url = process.env.DATABASE_URL || process.env.POSTGRES_URL;
if (!url) throw new Error("DATABASE_URL is required");

const client = new pg.Client({
  connectionString: url,
  ssl: /localhost|127\.0\.0\.1/.test(url) ? undefined : { rejectUnauthorized: false },
});

type QuoteRow = { symbol: string; bid: number; ask: number; ts: bigint | number; raw_contract: string | null };

function assertHealthy(rows: QuoteRow[]): void {
  const bySymbol = new Map(rows.map((row) => [row.symbol, row]));
  const now = Date.now();
  for (const symbol of REQUIRED) {
    const row = bySymbol.get(symbol);
    if (!row) throw new Error(`${symbol} row missing`);
    const age = now - Number(row.ts);
    if (age < 0 || age >= MAX_AGE_MS) throw new Error(`${symbol} quote age ${age}ms`);
    if (!(Number(row.bid) > 0 && Number(row.ask) >= Number(row.bid))) throw new Error(`${symbol} invalid spread`);
    if (!row.raw_contract?.startsWith(symbol)) throw new Error(`${symbol} raw_contract missing or invalid`);
  }
}

async function main(): Promise<void> {
  await client.connect();
  const readyDeadline = Date.now() + READY_TIMEOUT_MS;
  while (true) {
    try {
      const result = await client.query<QuoteRow>(
        `SELECT symbol, bid, ask, ts, raw_contract
           FROM live_quotes
          WHERE symbol = ANY($1::text[])`,
        [[...REQUIRED]],
      );
      assertHealthy(result.rows);
      break;
    } catch (error) {
      if (Date.now() >= readyDeadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    }
  }
  const startedAt = Date.now();
  while (Date.now() - startedAt < OBSERVE_MS) {
    const result = await client.query<QuoteRow>(
      `SELECT symbol, bid, ask, ts, raw_contract
         FROM live_quotes
        WHERE symbol = ANY($1::text[])`,
      [[...REQUIRED]],
    );
    assertHealthy(result.rows);
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
  console.log(`Sidecar gate passed: ${REQUIRED.join(", ")} stayed fresh with valid contract mappings for ${OBSERVE_MS / 60_000} minutes.`);
}

main()
  .finally(() => client.end())
  .catch((error) => {
    console.error(`Sidecar gate failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
