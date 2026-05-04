import { alpacaStream } from "@/lib/alpaca-stream";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const symbolsParam = searchParams.get("symbols") || "";
  const symbols = symbolsParam
    .split(",")
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean);

  if (symbols.length === 0) {
    return Response.json({ error: "symbols parameter required" }, { status: 400 });
  }

  alpacaStream.connect();
  alpacaStream.subscribe(symbols);

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      const unsubscribe = alpacaStream.onQuote((data) => {
        if (symbols.includes(data.symbol)) {
          try {
            controller.enqueue(
              encoder.encode(`data: ${JSON.stringify(data)}\n\n`)
            );
          } catch {
            // stream closed
          }
        }
      });

      request.signal.addEventListener("abort", () => {
        unsubscribe();
        alpacaStream.unsubscribe(symbols);
        try {
          controller.close();
        } catch {
          // already closed
        }
      });
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}
