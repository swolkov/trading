import useSWR from "swr";

interface QuoteData {
  symbol: string;
  ap: number;
  as: number;
  bp: number;
  bs: number;
  t: string;
}

const fetcher = (url: string) => fetch(url).then((r) => r.json());

export function useQuote(_symbol: string | null) {
  // The Alpaca quote feed was removed and no live stock-quote source is wired, so this no longer
  // fetches (avoids polling a now-deleted route). Callers degrade to "…" in the price columns.
  return useSWR<QuoteData>(null, fetcher, { refreshInterval: 0 });
}
