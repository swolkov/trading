import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * The admin's layout primitives. Every page is built from these so type sizes, padding
 * and borders match everywhere:
 *   PageHeader  — 20px title + 13px subtitle, optional right-hand slot
 *   Panel       — rounded card; PanelHeader is a 13px title row with an aside
 *   Stat        — label (11px caps) over a number (tabular)
 *   Note        — 12px muted explainer text
 */

export function PageHeader({ title, sub, right }: { title: string; sub?: ReactNode; right?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div className="min-w-0">
        <h1 className="text-xl font-semibold leading-tight">{title}</h1>
        {sub && <p className="mt-1 text-[13px] text-muted-foreground">{sub}</p>}
      </div>
      {right && <div className="flex flex-wrap items-center gap-2">{right}</div>}
    </div>
  );
}

export function Panel({ children, className, tone }: { children: ReactNode; className?: string; tone?: "paper" | "red" | "amber" | "green" }) {
  const toneCls =
    tone === "paper" ? "border-paper/25 bg-paper/[0.04]"
    : tone === "red" ? "border-down/35 bg-down/[0.06]"
    : tone === "amber" ? "border-warn/35 bg-warn/[0.06]"
    : tone === "green" ? "border-up/30 bg-up/[0.05]"
    : "border-border bg-card";
  return <section className={cn("overflow-hidden rounded-xl border", toneCls, className)}>{children}</section>;
}

export function PanelHeader({ title, aside, className }: { title: ReactNode; aside?: ReactNode; className?: string }) {
  return (
    <div className={cn("flex flex-wrap items-center justify-between gap-x-3 gap-y-1 border-b border-border px-4 py-2.5", className)}>
      <h2 className="text-[13px] font-semibold">{title}</h2>
      {aside && <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">{aside}</div>}
    </div>
  );
}

export function PanelBody({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn("p-4", className)}>{children}</div>;
}

export function Label({ children, className, title }: { children: ReactNode; className?: string; title?: string }) {
  return <p title={title} className={cn("text-[11px] font-medium uppercase tracking-wide text-muted-foreground", className)}>{children}</p>;
}

export function Stat({ label, value, sub, valueCls, size = "md", title }: {
  label: ReactNode; value: ReactNode; sub?: ReactNode; valueCls?: string; size?: "md" | "lg"; title?: string;
}) {
  return (
    <div title={title} className="min-w-0">
      <Label>{label}</Label>
      <p className={cn("mt-0.5 font-semibold tabular-nums leading-none", size === "lg" ? "text-[28px]" : "text-lg", valueCls)}>{value}</p>
      {sub && <div className="mt-1.5 text-xs text-muted-foreground">{sub}</div>}
    </div>
  );
}

export function Note({ children, className }: { children: ReactNode; className?: string }) {
  return <p className={cn("text-xs leading-relaxed text-muted-foreground", className)}>{children}</p>;
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className="px-4 py-5 text-[13px] text-muted-foreground">{children}</p>;
}

/** Collapsed-by-default explainer. Keeps the "how to read this page" prose off the first screen. */
export function Explainer({ title, children, open = false }: { title: string; children: ReactNode; open?: boolean }) {
  return (
    <details open={open} className="group rounded-xl border border-border bg-card">
      <summary className="cursor-pointer select-none px-4 py-2.5 text-[13px] font-semibold text-foreground/85 marker:text-muted-foreground">
        {title}
      </summary>
      <div className="space-y-2 border-t border-border px-4 py-3 text-xs leading-relaxed text-muted-foreground [&_li]:ml-4 [&_li]:list-disc [&_strong]:font-semibold [&_strong]:text-foreground/85">
        {children}
      </div>
    </details>
  );
}
