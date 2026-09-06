import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export type ChipTone = "green" | "red" | "amber" | "grey" | "paper" | "blue";

const TONES: Record<ChipTone, string> = {
  green: "border-up/30 bg-up/10 text-up",
  red: "border-down/40 bg-down/10 text-down",
  amber: "border-warn/40 bg-warn/10 text-warn",
  grey: "border-border bg-muted/60 text-muted-foreground",
  paper: "border-paper/35 bg-paper/10 text-paper",
  blue: "border-primary/35 bg-primary/10 text-primary",
};

/**
 * Status chip — the one way a state is shown (ARMED, PASSED, 3 of 4, open, retired…).
 * Replaces coloured prose. `dot` adds a pulsing indicator for live states.
 */
export function Chip({ tone = "grey", children, dot = false, size = "sm", className, title }: {
  tone?: ChipTone; children: ReactNode; dot?: boolean; size?: "sm" | "md"; className?: string; title?: string;
}) {
  return (
    <span
      title={title}
      className={cn(
        "inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border font-semibold tabular-nums",
        size === "sm" ? "h-5 px-2 text-[11px]" : "h-6 px-2.5 text-xs",
        TONES[tone],
        className,
      )}
    >
      {dot && <span className={cn("h-1.5 w-1.5 rounded-full bg-current", tone === "red" && "live-dot")} />}
      {children}
    </span>
  );
}

/** Map a scoreboard verdict string to a chip tone. */
export function verdictTone(v: string): ChipTone {
  if (v.startsWith("REAL EDGE")) return "green";
  if (v.startsWith("promising")) return "amber";
  if (v.startsWith("not paying")) return "red";
  if (v.startsWith("retired")) return "grey";
  return "grey";
}
