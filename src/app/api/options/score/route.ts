import { optionsScoreReport } from "@/lib/options-score-report";

// "Does the 0–100 score rank?" — the paper ranker's measurement: buckets, settlement-proxy P&L, the promotion verdict. Read-only.
export const dynamic = "force-dynamic";
export async function GET() { return Response.json(await optionsScoreReport()); }
