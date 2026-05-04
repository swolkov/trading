import { chatWithAnalyst } from "@/lib/ai-analyst";

export async function POST(request: Request) {
  try {
    const { message, history } = await request.json();
    if (!message) {
      return Response.json({ error: "message required" }, { status: 400 });
    }
    const response = await chatWithAnalyst(message, history || []);
    return Response.json({ response });
  } catch (error) {
    console.error("[/api/ai/chat]", error);
    return Response.json(
      { error: error instanceof Error ? error.message : "Chat failed" },
      { status: 500 }
    );
  }
}
