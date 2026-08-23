import Link from "next/link";
import { Bitcoin, TrendingUp, ShieldCheck, PlugZap } from "lucide-react";
import { AccumulatorPanel } from "@/components/kraken/accumulator-panel";

// Kraken — a 50-day trend follower on BTC and ETH. It holds a coin while that coin is above its
// 50-day average and sells to cash when it drops below. Spot, long-only, no leverage. It BUYS AND
// SELLS — the DCA accumulator this page used to describe was replaced in July 2026.

export default function KrakenPage() {
  return (
    <div className="max-w-3xl mx-auto px-4 py-8 space-y-6">
      {/* Header */}
      <div className="flex items-center gap-3">
        <div className="w-10 h-10 rounded-lg bg-purple-500/15 border border-purple-500/30 flex items-center justify-center">
          <Bitcoin className="w-5 h-5 text-purple-400" />
        </div>
        <div>
          <h1 className="text-xl font-bold tracking-tight">Kraken — BTC/ETH Trend Follower</h1>
          <p className="text-sm text-muted-foreground">Holds each coin while it&apos;s above its 50-day average. Sells to cash when it drops below.</p>
        </div>
      </div>

      <AccumulatorPanel />

      {/* The strategy */}
      <div className="rounded-lg border border-border bg-card p-5 space-y-4">
        <div className="flex items-center gap-2">
          <TrendingUp className="w-4 h-4 text-emerald-400" />
          <h2 className="font-semibold">The strategy: follow the 50-day trend</h2>
        </div>
        <p className="text-sm text-muted-foreground leading-relaxed">
          One rule, checked automatically every 30 minutes. If Bitcoin is trading above its average
          price of the last 50 days, hold Bitcoin. If it falls clearly below that line, sell it and
          sit in cash. Same rule for Ethereum, judged separately. That&apos;s the whole thing — no
          predictions, no news, no discretion.
        </p>
        <p className="text-sm text-muted-foreground leading-relaxed">
          The point isn&apos;t to earn more than simply holding crypto — it&apos;s to sit out the
          worst of the crashes. Over the tested period this returned about the same as buy-and-hold
          while cutting the worst peak-to-trough loss from roughly 68% to 36%. You give up some
          upside in exchange for not living through the full drawdown.
        </p>

        <div className="grid grid-cols-2 gap-3">
          <div className="rounded-md border border-border bg-background/40 p-3">
            <div className="text-[11px] uppercase tracking-wider text-muted-foreground/60 mb-1">Above the 50-day</div>
            <div className="text-sm"><span className="text-emerald-400 font-semibold">Hold</span> — and top up toward target</div>
            <div className="text-[11px] text-muted-foreground/70 mt-0.5">winners above target are left to run</div>
          </div>
          <div className="rounded-md border border-border bg-background/40 p-3">
            <div className="text-[11px] uppercase tracking-wider text-muted-foreground/60 mb-1">Below the 50-day</div>
            <div className="text-sm"><span className="text-red-400 font-semibold">Sell to cash</span></div>
            <div className="text-[11px] text-muted-foreground/70 mt-0.5">waits, then buys back when the trend returns</div>
          </div>
        </div>
        <p className="text-[11px] text-muted-foreground/60">
          Each coin targets a share of the account rather than a fixed dollar amount, so money added
          to the account is deployed automatically on the next check. A 1.5% buffer around the
          50-day line stops it flip-flopping when price hovers right at the average.
        </p>
      </div>

      {/* Why only two coins */}
      <div className="rounded-lg border border-border bg-card p-5 space-y-2">
        <div className="flex items-center gap-2">
          <ShieldCheck className="w-4 h-4 text-blue-400" />
          <h2 className="font-semibold">Why only Bitcoin and Ethereum?</h2>
        </div>
        <p className="text-sm text-muted-foreground leading-relaxed">
          Because everything else was tested and failed. The same rule was run coin-by-coin across
          370 cryptocurrencies, and twelve different ways of ranking the whole market — momentum,
          volatility, closeness to all-time highs, trading volume and more — were checked on data
          the selection never saw. <span className="font-semibold text-red-400">Every one of them lost money</span> out
          of sample. Holding an equal slice of every liquid coin lost about 45% a year over that
          stretch while Bitcoin gained.
        </p>
        <p className="text-sm text-muted-foreground leading-relaxed">
          Picking coins by what did well recently is worse than useless: past performance ranked
          slightly <span className="italic">negatively</span> against future performance. Broadening the
          universe has been measured, repeatedly, and it makes results worse — so this account holds
          the two coins that survive the test and nothing else.
        </p>
      </div>

      {/* Honest expectations */}
      <div className="rounded-lg border border-border bg-card p-5 space-y-2">
        <div className="flex items-center gap-2">
          <ShieldCheck className="w-4 h-4 text-amber-400" />
          <h2 className="font-semibold">What to expect — honestly</h2>
        </div>
        <p className="text-sm text-muted-foreground leading-relaxed">
          Roughly <span className="font-semibold text-foreground/80">20% a year</span> with a
          drawdown near <span className="font-semibold text-red-400">36%</span> that you should
          expect to actually live through. Crypto day-trading was tested and loses to fees; leverage
          was tested and made both returns and drawdowns worse. This is a way to compound capital
          patiently, not a way to get rich quickly — the honest lever on the outcome is how much
          capital is in the account, not how aggressively it&apos;s traded.
        </p>
      </div>

      {/* Where positions live */}
      <div className="rounded-lg border border-border bg-card p-5 space-y-3">
        <div className="flex items-center gap-2">
          <PlugZap className="w-4 h-4 text-purple-400" />
          <h2 className="font-semibold">Where Kraken positions show</h2>
        </div>
        <p className="text-sm text-muted-foreground leading-relaxed">
          Right here — in the panel at the top of this page, which shows each coin&apos;s live trend
          state and what the strategy is aiming to hold. Each broker&apos;s tab shows its own
          positions: <Link href="/futures" className="text-purple-300 underline underline-offset-2">Futures</Link> for
          Tradovate, and this tab for Kraken crypto. When both coins are below their 50-day the
          account sits in cash and shows no holdings — that is the drawdown protection working, not
          a fault.
        </p>
      </div>
    </div>
  );
}
