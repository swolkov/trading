export const dynamic = "force-dynamic";
export const maxDuration = 60; // max 60s on Vercel

const DATA_URL = process.env.ALPACA_DATA_URL || "https://data.alpaca.markets";

function headers() {
  return {
    "APCA-API-KEY-ID": process.env.ALPACA_API_KEY || "",
    "APCA-API-SECRET-KEY": process.env.ALPACA_API_SECRET || "",
  };
}

async function fetchQuotes(symbols: string[]): Promise<Record<string, { bp: number; ap: number; bs: number; as: number; t: string }>> {
  try {
    const res = await fetch(
      `${DATA_URL}/v2/stocks/quotes/latest?symbols=${symbols.join(",")}&feed=iex`,
      { headers: headers() }
    );
    if (!res.ok) return {};
    const data = await res.json();
    return data.quotes || {};
  } catch {
    return {};
  }
}

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

  const intervalMs = 3000; // poll every 3 seconds
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      let running = true;

      request.signal.addEventListener("abort", () => {
        running = false;
        try { controller.close(); } catch { /* already closed */ }
      });

      // Send initial quotes immediately
      try {
        const quotes = await fetchQuotes(symbols);
        for (const [symbol, quote] of Object.entries(quotes)) {
          const data = { symbol, ...quote };
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
        }
      } catch { /* ignore */ }

      // Poll for updates
      while (running) {
        await new Promise((resolve) => setTimeout(resolve, intervalMs));
        if (!running) break;

        try {
          const quotes = await fetchQuotes(symbols);
          for (const [symbol, quote] of Object.entries(quotes)) {
            const data = { symbol, ...quote };
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
          }
        } catch {
          // connection error, continue trying
        }
      }
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
