import Link from "next/link";
import { Bitcoin, TrendingUp, ShieldCheck, PlugZap } from "lucide-react";
import { DipScanner } from "@/components/kraken/dip-scanner";
import { AccumulatorPanel } from "@/components/kraken/accumulator-panel";

// Kraken — a dollar-cost-averaging accumulator. It buys $10 of BTC and $10 of ETH every day and
// HOLDS. It never sells. This is not day-trading and not trend-following — it's slow, mechanical
// long-term accumulation. Funded and live; positions show in the accumulator panel at the top.

export default function KrakenPage() {
  return (
    <div className="max-w-3xl mx-auto px-4 py-8 space-y-6">
      {/* Header */}
      <div className="flex items-center gap-3">
        <div className="w-10 h-10 rounded-lg bg-purple-500/15 border border-purple-500/30 flex items-center justify-center">
          <Bitcoin className="w-5 h-5 text-purple-400" />
        </div>
        <div>
          <h1 className="text-xl font-bold tracking-tight">Kraken — DCA Accumulator</h1>
          <p className="text-sm text-muted-foreground">Buys $10 of BTC and $10 of ETH every day and holds. Never sells.</p>
        </div>
      </div>

      <AccumulatorPanel />

      <DipScanner />

      {/* The strategy */}
      <div className="rounded-lg border border-border bg-card p-5 space-y-4">
        <div className="flex items-center gap-2">
          <TrendingUp className="w-4 h-4 text-emerald-400" />
          <h2 className="font-semibold">The strategy: daily dollar-cost averaging</h2>
        </div>
        <p className="text-sm text-muted-foreground leading-relaxed">
          Every day it buys a fixed $10 of Bitcoin and $10 of Ethereum, and then it holds — forever.
          No selling, no timing, no reacting to price. Buying the same dollar amount on a schedule
          means you automatically buy more coins when prices are low and fewer when they&apos;re high,
          which smooths out your average entry price over time. It&apos;s the slow, boring,
          long-term way to build a crypto position without trying to guess the market.
        </p>

        <div className="grid grid-cols-2 gap-3">
          <div className="rounded-md border border-border bg-background/40 p-3">
            <div className="text-[11px] uppercase tracking-wider text-muted-foreground/60 mb-1">What it buys</div>
            <div className="text-sm"><span className="text-emerald-400 font-semibold">$10 BTC</span> + <span className="text-emerald-400 font-semibold">$10 ETH</span> per day</div>
            <div className="text-[11px] text-muted-foreground/70 mt-0.5">a fixed amount, on a schedule</div>
          </div>
          <div className="rounded-md border border-border bg-background/40 p-3">
            <div className="text-[11px] uppercase tracking-wider text-muted-foreground/60 mb-1">What it never does</div>
            <div className="text-sm"><span className="text-red-400 font-semibold">Never sells</span></div>
            <div className="text-[11px] text-muted-foreground/70 mt-0.5">pure buy-and-hold, no cash-outs</div>
          </div>
        </div>
        <p className="text-[11px] text-muted-foreground/60">
          Holds indefinitely — not days, not weeks. The win is discipline and a smoothed cost basis, not timing.
        </p>
      </div>

      {/* What it is NOT */}
      <div className="rounded-lg border border-border bg-card p-5 space-y-2">
        <div className="flex items-center gap-2">
          <ShieldCheck className="w-4 h-4 text-blue-400" />
          <h2 className="font-semibold">Why not crypto day-trading?</h2>
        </div>
        <p className="text-sm text-muted-foreground leading-relaxed">
          Because it loses. Crypto day-trading (buy-the-dip / sell-the-rip, intraday) was tested across
          every coin and year and came out at a profit factor of <span className="font-semibold text-red-400">0.73</span> —
          a reliable money-loser. So instead of trying to trade in and out, this account just
          accumulates and holds. It runs the boring approach that doesn&apos;t bleed to fees and
          bad timing, not the exciting one that does.
        </p>
      </div>

      {/* Where positions live */}
      <div className="rounded-lg border border-border bg-card p-5 space-y-3">
        <div className="flex items-center gap-2">
          <PlugZap className="w-4 h-4 text-purple-400" />
          <h2 className="font-semibold">Where Kraken positions show</h2>
        </div>
        <p className="text-sm text-muted-foreground leading-relaxed">
          Right here — in the accumulator panel at the top of this page. Each broker&apos;s tab shows
          its own positions: <Link href="/futures" className="text-purple-300 underline underline-offset-2">Futures</Link> for
          Tradovate, <Link href="/positions" className="text-purple-300 underline underline-offset-2">Positions</Link> for
          Alpaca, and this tab for Kraken crypto. The accumulator buys a little every day, so your
          BTC and ETH holdings grow steadily right here.
        </p>
      </div>
    </div>
  );
}
