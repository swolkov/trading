import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

export function formatCurrency(n: number | string): string {
  const num = typeof n === "string" ? parseFloat(n) : n;
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
  }).format(num);
}

export function formatPercent(n: number | string): string {
  const num = typeof n === "string" ? parseFloat(n) : n;
  const sign = num >= 0 ? "+" : "";
  return `${sign}${(num * 100).toFixed(2)}%`;
}

export function formatDate(d: string | Date): string {
  const date = typeof d === "string" ? new Date(d) : d;
  return date.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export function pnlColor(n: number | string): string {
  const num = typeof n === "string" ? parseFloat(n) : n;
  if (num > 0) return "text-emerald-500";
  if (num < 0) return "text-red-500";
  return "text-muted-foreground";
}
