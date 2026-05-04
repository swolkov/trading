import useSWR from "swr";
import type { Order } from "@/lib/alpaca";

const fetcher = (url: string) => fetch(url).then((r) => r.json());

export function useOrders(status: "open" | "closed" | "all" = "all") {
  return useSWR<Order[]>(`/api/orders?status=${status}`, fetcher, {
    refreshInterval: 15000,
  });
}
