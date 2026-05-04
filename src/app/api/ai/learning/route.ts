import { generateLearningInsights } from "@/lib/learning-engine";

export async function GET() {
  try {
    const insights = await generateLearningInsights();
    return Response.json(insights);
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "Failed" },
      { status: 500 }
    );
  }
}
