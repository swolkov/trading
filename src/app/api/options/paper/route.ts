export const dynamic = "force-dynamic";

export async function GET() {
  return Response.json({ retired: true, message: "Options paper trading has been retired. Use /api/options/live for the real account." }, { status: 410 });
}
