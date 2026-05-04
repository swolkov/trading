import useSWR from "swr";
import type { Position } from "@/lib/alpaca";

const fetcher = (url: string) => fetch(url).then((r) => r.json());

export function usePositions() {
  return useSWR<Position[]>("/api/positions", fetcher, {
    refreshInterval: 15000,
  });
}
