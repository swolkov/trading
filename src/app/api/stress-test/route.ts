import { runStressTest } from "@/lib/stress-test";

export const maxDuration = 60;

export async function GET() {
  try {
    const result = await runStressTest();
    return Response.json(result);
  } catch (error) {
    console.error("[/api/stress-test]", error);
    return Response.json({ error: String(error) }, { status: 500 });
  }
}
