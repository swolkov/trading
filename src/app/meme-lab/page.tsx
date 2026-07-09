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
          <h1 className="text-xl font-bold tracking-tight">Meme Lab <span className="text-[10px] font-semibold uppercase tracking-wider text-fuchsia-300/70 align-middle ml-1">Experiment</span></h1>
          <p className="text-sm text-muted-foreground">Paper-testing whether we can catch meme jumps like Cash Cat. Zero real money.</p>
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
          throws out the obvious rugs (too little liquidity, already collapsing, more sellers than
          buyers), and <span className="text-foreground/80">paper-buys</span> the survivors showing a real move —
          logging the entry with realistic slippage baked in (memecoins cost ~5% just to get in or out).
          Each bet is then managed mechanically: take profit on a big run, trail the peak, cut at −40%,
          bail on a 24-hour timer, and dump instantly if liquidity drains. Every result is tracked above.
        </p>
      </div>

      {/* The honest point */}
      <div className="rounded-lg border border-amber-500/20 bg-amber-500/[0.03] p-5 space-y-2">
        <div className="flex items-center gap-2">
          <AlertTriangle className="w-4 h-4 text-amber-400" />
          <h2 className="font-semibold">Why it&apos;s paper — and what we&apos;re actually measuring</h2>
        </div>
        <p className="text-sm text-muted-foreground leading-relaxed">
          Catching meme jumps is a game dominated by insiders and millisecond-fast bots colocated next to
          the blockchain — a slow web app buying minutes later is usually their exit liquidity, and ~99%
          of these tokens go to zero. So instead of betting real money on a hunch, this runs the exact
          strategy on paper and keeps an honest scoreboard. If — after weeks of real forward data on our
          own setup — it shows a genuine edge after fees, we&apos;d fund a tiny bucket by hand. If it
          bleeds (the likely outcome), we&apos;ll have proven it cost-free instead of learning it the
          expensive way. <span className="text-foreground/70">This is not connected to Kraken or any real account.</span>
        </p>
      </div>
    </div>
  );
}
