import useSWR from "swr";
import type { Account } from "@/lib/alpaca";

const fetcher = (url: string) => fetch(url).then((r) => r.json());

export function useAccount() {
  return useSWR<Account>("/api/account", fetcher, {
    refreshInterval: 30000,
  });
}
