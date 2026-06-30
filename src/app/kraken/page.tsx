import Link from "next/link";
import { Bitcoin, TrendingUp, ShieldCheck, AlertTriangle, PlugZap } from "lucide-react";

// Kraken — crypto trend-following. NOT day-trading. Crypto day-trading tested at PF 0.73 (loses);
// the trend-following version is the one edge that survived out-of-sample, so that's what this is.
// Kraken isn't wired/funded yet, so this page is an honest status + strategy explainer — no fake
// "live" numbers. It flips to a real dashboard once the account is funded and the API is connected.

export default function KrakenPage() {
  return (
    <div className="max-w-3xl mx-auto px-4 py-8 space-y-6">
      {/* Header */}
      <div className="flex items-center gap-3">
        <div className="w-10 h-10 rounded-lg bg-purple-500/15 border border-purple-500/30 flex items-center justify-center">
          <Bitcoin className="w-5 h-5 text-purple-400" />
        </div>
        <div>
          <h1 className="text-xl font-bold tracking-tight">Kraken — Crypto Trend Following</h1>
          <p className="text-sm text-muted-foreground">Multi-day trend strategy. Long-only. Not day-trading.</p>
        </div>
      </div>

      {/* Status */}
      <div className="rounded-lg border border-amber-500/30 bg-amber-500/[0.06] px-4 py-3 flex items-start gap-3">
        <AlertTriangle className="w-4 h-4 text-amber-400 mt-0.5 shrink-0" />
        <div className="text-sm">
          <span className="font-semibold text-amber-300">Not connected yet.</span>{" "}
          <span className="text-muted-foreground">
            Kraken isn&apos;t funded or wired in. This is the strategy that activates here once the
            account is connected on the{" "}
            <Link href="/connect" className="text-amber-300 underline underline-offset-2">Connections</Link>{" "}
            page. No money is at work on Kraken today.
          </span>
        </div>
      </div>

      {/* The edge */}
      <div className="rounded-lg border border-border bg-card p-5 space-y-4">
        <div className="flex items-center gap-2">
          <TrendingUp className="w-4 h-4 text-emerald-400" />
          <h2 className="font-semibold">The edge: 50-day trend following</h2>
        </div>
        <p className="text-sm text-muted-foreground leading-relaxed">
          Hold BTC and ETH while price is above its 50-day average; sit in cash when it&apos;s below.
          Simple, slow, and the one crypto approach that beat buy-and-hold on <em>both</em> return and
          drawdown through the 2022 bear market — because it sidesteps the worst crashes instead of
          riding them down.
        </p>

        <div className="grid grid-cols-2 gap-3">
          <div className="rounded-md border border-border bg-background/40 p-3">
            <div className="text-[11px] uppercase tracking-wider text-muted-foreground/60 mb-1">BTC — trend vs buy &amp; hold</div>
            <div className="text-sm"><span className="text-emerald-400 font-semibold">+21%</span> return · <span className="text-emerald-400 font-semibold">−57%</span> max drawdown</div>
            <div className="text-[11px] text-muted-foreground/70 mt-0.5">buy &amp; hold: +13% · −77% drawdown</div>
          </div>
          <div className="rounded-md border border-border bg-background/40 p-3">
            <div className="text-[11px] uppercase tracking-wider text-muted-foreground/60 mb-1">ETH — trend vs buy &amp; hold</div>
            <div className="text-sm"><span className="text-emerald-400 font-semibold">+22%</span> return · <span className="text-emerald-400 font-semibold">−53%</span> max drawdown</div>
            <div className="text-[11px] text-muted-foreground/70 mt-0.5">buy &amp; hold: +15% · −79% drawdown</div>
          </div>
        </div>
        <p className="text-[11px] text-muted-foreground/60">
          Holds last days to weeks — not minutes. The win is smaller drawdowns, not bigger returns.
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
          a reliable money-loser. Trend-following is the version that survived. This page trades the
          edge that works, not the one that feels exciting.
        </p>
      </div>

      {/* Activation */}
      <div className="rounded-lg border border-border bg-card p-5 space-y-3">
        <div className="flex items-center gap-2">
          <PlugZap className="w-4 h-4 text-purple-400" />
          <h2 className="font-semibold">To turn it on</h2>
        </div>
        <ol className="text-sm text-muted-foreground space-y-1.5 list-decimal list-inside">
          <li>Fund the Kraken account.</li>
          <li>Connect the Kraken API on the <Link href="/connect" className="text-purple-300 underline underline-offset-2">Connections</Link> page.</li>
          <li>The trend agent activates on a daily check and reports its positions here.</li>
        </ol>
      </div>
    </div>
  );
}
