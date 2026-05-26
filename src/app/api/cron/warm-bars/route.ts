import { getDatabentoIntradayBars } from "@/lib/databento";
import { getFuturesDailyBars } from "@/lib/futures-data";
import type { TradingMode } from "@/lib/trading-mode";
import { prisma } from "@/lib/db";

// Keeps the chart's bars_cache hot in the background so user loads NEVER wait on the slow Databento pull.
export const maxDuration = 120;

const SYMS = ["ES", "NQ", "GC", "MES", "MNQ"];
const INTRADAY: ("1s" | "1m" | "5m")[] = ["5m", "1m", "1s"];

async function writeCache(key: string, data: unknown) {
  try {
    await prisma.$executeRawUnsafe("CREATE TABLE IF NOT EXISTS bars_cache(key text PRIMARY KEY, payload jsonb, ts timestamptz DEFAULT now())");
    await prisma.$executeRawUnsafe("INSERT INTO bars_cache(key,payload,ts) VALUES($1,$2::jsonb,now()) ON CONFLICT(key) DO UPDATE SET payload=$2::jsonb, ts=now()", key, JSON.stringify(data));
  } catch { /* best-effort */ }
}

export async function GET(request: Request) {
  const authHeader = request.headers.get("authorization");
  if (!process.env.CRON_SECRET || authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return new Response("Unauthorized", { status: 401 });
  }
  let warmed = 0;
  // Intraday bars — the slow part. Warm the common symbol×interval combos in parallel.
  await Promise.allSettled(SYMS.flatMap(s => INTRADAY.map(async iv => {
    const range = "1d";
    const bars = await getDatabentoIntradayBars(s, iv, range);
    if (bars.length) { await writeCache(`dbn|${s}|${iv}|${range}`, bars); warmed++; }
  })));
  // Daily levels (both view modes share the same key space)
  await Promise.allSettled(SYMS.flatMap(s => (["live", "demo"] as const).map(async vm => {
    const d = await getFuturesDailyBars(s, 5, vm as TradingMode);
    if (d.length) await writeCache(`daily|${s}|${vm}`, d);
  })));
  return Response.json({ ok: true, warmed, at: new Date().toISOString() });
}
