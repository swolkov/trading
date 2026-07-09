import { FlaskConical, AlertTriangle, Search } from "lucide-react";
import { MemeLabPanel } from "@/components/meme/meme-lab-panel";

// Meme Lab — OBSERVATION ONLY. A paper harness that watches Solana meme launches and tests whether
// any signal we can actually see pays off, before risking a dollar. No exchange, no keys, no money.

export default function MemeLabPage() {
  return (
    <div className="max-w-3xl mx-auto px-4 py-8 space-y-6">
      <div className="flex items-center gap-3">
        <div className="w-10 h-10 rounded-lg bg-fuchsia-500/15 border border-fuchsia-500/30 flex items-center justify-center">
          <FlaskConical className="w-5 h-5 text-fuchsia-400" />
        </div>
        <div>
          <h1 className="text-xl font-bold tracking-tight">Meme Lab <span className="text-[10px] font-semibold uppercase tracking-wider text-fuchsia-300/70 align-middle ml-1">Live · $100 cap</span></h1>
          <p className="text-sm text-muted-foreground">An automated bot that hunts Solana meme jumps and trades them with real money — hard-capped at $100.</p>
        </div>
      </div>

      <MemeLabPanel />

      {/* What this is */}
      <div className="rounded-lg border border-border bg-card p-5 space-y-3">
        <div className="flex items-center gap-2">
          <Search className="w-4 h-4 text-fuchsia-400" />
          <h2 className="font-semibold">What it does</h2>
        </div>
        <p className="text-sm text-muted-foreground leading-relaxed">
          Every 10 minutes it reads brand-new and trending Solana tokens straight from the blockchain,
          throws out the obvious rugs (too little liquidity, unlocked liquidity, already collapsing, more
          sellers than buyers), scores the survivors with an AI conviction check, and — only for the
          highest-conviction ones — <span className="text-foreground/80">buys them with real money</span> via
          Jupiter. Before every buy it simulates a sell, so it never touches a coin it can&apos;t exit.
          Each position is managed mechanically: take profit on a big run, trail the peak, cut at −40%,
          bail on a 24-hour timer, and dump instantly if liquidity drains. Every fill hits Slack.
        </p>
      </div>

      {/* The honest warning */}
      <div className="rounded-lg border border-amber-500/20 bg-amber-500/[0.03] p-5 space-y-2">
        <div className="flex items-center gap-2">
          <AlertTriangle className="w-4 h-4 text-amber-400" />
          <h2 className="font-semibold">The honest risk</h2>
        </div>
        <p className="text-sm text-muted-foreground leading-relaxed">
          This is a bet with a negative expected return. Catching meme jumps is dominated by insiders and
          millisecond-fast bots — a bot buying minutes later is often their exit liquidity, and ~99% of
          these tokens go to zero. The honest expectation is that this bleeds. What makes it survivable:
          a <span className="text-foreground/80">hard $100 wallet cap</span> (worst case, that&apos;s the whole loss),
          a honeypot check before every buy, a daily-loss auto-halt, and a one-click kill switch. It runs
          on its own isolated wallet — <span className="text-foreground/70">never your Kraken or futures money.</span>
        </p>
      </div>
    </div>
  );
}
