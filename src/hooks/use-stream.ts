"use client";

import { useEffect, useRef, useState } from "react";

interface StreamQuote {
  symbol: string;
  bp: number;
  ap: number;
  bs: number;
  as: number;
  t: string;
}

export function useStream(symbols: string[]) {
  const [quotes, setQuotes] = useState<Record<string, StreamQuote>>({});
  const eventSourceRef = useRef<EventSource | null>(null);

  useEffect(() => {
    if (symbols.length === 0) return;

    const url = `/api/stream?symbols=${symbols.join(",")}`;
    const es = new EventSource(url);
    eventSourceRef.current = es;

    es.onmessage = (event) => {
      try {
        const data: StreamQuote = JSON.parse(event.data);
        setQuotes((prev) => ({ ...prev, [data.symbol]: data }));
      } catch {
        // ignore
      }
    };

    es.onerror = () => {
      es.close();
      // Reconnect after 3s
      setTimeout(() => {
        if (eventSourceRef.current === es) {
          eventSourceRef.current = new EventSource(url);
        }
      }, 3000);
    };

    return () => {
      es.close();
      eventSourceRef.current = null;
    };
  }, [symbols.join(",")]);

  return quotes;
}
