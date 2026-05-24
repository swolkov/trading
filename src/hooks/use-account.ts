import useSWR from "swr";
import type { Account } from "@/lib/alpaca";

// Throw on error/non-ok so SWR surfaces `error` and KEEPS the last good data on transient
// failures — instead of resolving an {error} object as data and rendering $NaN for equity.
const fetcher = async (url: string) => {
  const r = await fetch(url);
  const data = await r.json().catch(() => null);
  if (!r.ok || (data && typeof data === "object" && "error" in data)) {
    throw new Error((data && (data as { error?: string }).error) || `Request failed (${r.status})`);
  }
  return data;
};

export function useAccount() {
  return useSWR<Account>("/api/account", fetcher, {
    refreshInterval: 30000,
  });
}
