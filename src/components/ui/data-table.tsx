import type { ReactNode, ThHTMLAttributes, TdHTMLAttributes } from "react";
import { cn } from "@/lib/utils";

/**
 * The one table style. 12px rows, 11px uppercase header, numbers right-aligned and tabular,
 * horizontal scroll inside the panel (never the page). Use:
 *
 *   <DataTable sticky maxH="60vh">
 *     <thead><tr><Th>Coin</Th><Th num>P&L</Th></tr></thead>
 *     <tbody><Row><Td>BTC</Td><Td num className={tone(x)}>{pnl2(x)}</Td></Row></tbody>
 *   </DataTable>
 */
export function DataTable({ children, className, sticky = false, maxH, dense = false }: {
  children: ReactNode; className?: string; sticky?: boolean; maxH?: string; dense?: boolean;
}) {
  return (
    <div className={cn("w-full overflow-x-auto", maxH && "overflow-y-auto")} style={maxH ? { maxHeight: maxH } : undefined}>
      <table
        className={cn(
          "w-full border-collapse text-xs tabular-nums",
          "[&_thead_th]:text-[11px] [&_thead_th]:font-medium [&_thead_th]:uppercase [&_thead_th]:tracking-wide [&_thead_th]:text-muted-foreground",
          "[&_thead_tr]:border-b [&_thead_tr]:border-border",
          "[&_tbody_tr]:border-b [&_tbody_tr]:border-border/60 [&_tbody_tr:last-child]:border-0",
          dense ? "[&_th]:py-1 [&_td]:py-1" : "[&_th]:py-2 [&_td]:py-2",
          "[&_th]:px-3 [&_td]:px-3 [&_th:first-child]:pl-4 [&_td:first-child]:pl-4 [&_th:last-child]:pr-4 [&_td:last-child]:pr-4",
          sticky && "[&_thead]:sticky [&_thead]:top-0 [&_thead]:z-10 [&_thead]:bg-card",
          className,
        )}
      >
        {children}
      </table>
    </div>
  );
}

export function Th({ num = false, className, children, ...rest }: ThHTMLAttributes<HTMLTableCellElement> & { num?: boolean }) {
  return <th className={cn("whitespace-nowrap align-middle", num ? "text-right" : "text-left", className)} {...rest}>{children}</th>;
}

export function Td({ num = false, muted = false, strong = false, className, children, ...rest }: TdHTMLAttributes<HTMLTableCellElement> & { num?: boolean; muted?: boolean; strong?: boolean }) {
  return (
    <td className={cn("whitespace-nowrap align-middle", num && "text-right", muted && "text-muted-foreground", strong && "font-semibold", className)} {...rest}>
      {children}
    </td>
  );
}

export function Row({ className, children, onClick }: { className?: string; children: ReactNode; onClick?: () => void }) {
  return <tr onClick={onClick} className={cn("transition-colors hover:bg-foreground/[0.03]", onClick && "cursor-pointer", className)}>{children}</tr>;
}
