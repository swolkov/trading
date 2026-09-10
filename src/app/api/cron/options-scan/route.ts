import { runOptionsScan } from "@/lib/options-run";

// THE OPTIONS PAPER BOOK — once a day after the close (vercel.json: 0 22 * * 1-5, which is
// 6pm ET in summer and 5pm ET in winter, comfortably past 4pm either way).
//
// This route is now a thin authenticated wrapper. The run itself lives in
// `src/lib/options-run.ts` so the scheduled Robinhood agent executes exactly the same code
// after it pushes fresh quotes — see that file's header for why.
export const maxDuration = 300;
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const authHeader = request.headers.get("authorization");
  if (!process.env.CRON_SECRET || authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }
  return Response.json(await runOptionsScan());
}
