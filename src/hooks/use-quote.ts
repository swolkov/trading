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

export function useQuote(symbol: string | null) {
  return useSWR<QuoteData>(
    symbol ? `/api/quotes/${symbol}` : null,
    fetcher,
    { refreshInterval: 10000 }
  );
}
