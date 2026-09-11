"use client";

import useSWR from "swr";
import { Chip, type ChipTone } from "@/components/ui/chip";
import { Explainer, Note, PageHeader, Panel, PanelBody, PanelHeader, Stat } from "@/components/ui/panel";
import { ago } from "@/lib/format";

// ============ FUTURES DESK — PARKED ============
// The Tradovate desk's place in the admin while it is parked (Aug 2026): are the engines
// alive, what mode are they in, is anything open — and the verdicts that parked it, so the
// question "should we trade futures again?" has its answer on the page. Reads the DB only;
// no broker polls (they were what tripped Tradovate's rate limit).
//
// The full trading dashboard this replaced (charts, plan, edge scoreboard, depth tape) is
// in git history at 51baca4 — src/app/futures/page.tsx — and its sibling components stay
// in this directory, unlinked.

const fetcher = (u: string) => fetch(u).then((r) => r.json());
interface Parked {
  heartbeats: { demo: string | null; live: string | null; cron: string | null };
  mode: string | null;
  positions: { live: number | null; demo: number | null };
  error?: string;
}

function hbTone(iso: string | null | undefined): ChipTone {
  if (!iso) return "grey";
  const m = (Date.now() - new Date(iso).getTime()) / 60_000;
  return m <= 15 ? "green" : m <= 60 ? "amber" : "red";
}

export default function FuturesParkedPage() {
  const { data } = useSWR<Parked>("/api/futures/parked", fetcher, { refreshInterval: 60_000 });
  const hb = data?.heartbeats;
  return (
    <div className="space-y-4 p-4 md:p-6">
      <PageHeader
        title="Futures Desk"
        sub="Tradovate · ES/NQ minis on demo, MGC micro on live · PARKED since Aug 2026. Live is dark by decision, not by outage."
        right={
          <>
            <Chip tone="grey" size="md">parked</Chip>
            <Chip tone={hbTone(hb?.demo)} size="md" title="Railway demo engine heartbeat">demo engine {hb?.demo ? ago(hb.demo) : "—"}</Chip>
            <Chip tone={hbTone(hb?.live)} size="md" title="Railway live engine heartbeat">live engine {hb?.live ? ago(hb.live) : "—"}</Chip>
          </>
        }
      />

      <Panel>
        <PanelHeader title="Engines" aside={<span>mode flag: {data?.mode ?? "—"} · cron {hb?.cron ? ago(hb.cron) : "—"}</span>} />
        <PanelBody className="grid gap-4 sm:grid-cols-3">
          <Stat label="Live positions (engine record)" value={data?.positions.live ?? "—"} sub="live engine's own ledger; 0 = flat by design" />
          <Stat label="Demo positions (engine record)" value={data?.positions.demo ?? "—"} sub="demo runs as a faithful clone of live for research" />
          <Stat label="Capital" value="parked" sub="the Tradovate balance is untouched; no deposits, no trading" />
        </PanelBody>
      </Panel>

      <Panel>
        <PanelHeader title="Why it is parked" />
        <PanelBody className="space-y-2">
          <Note>Nine strategy families were tested on 15 years of futures data; every one lost after costs. Trend and mean-reversion on ES/NQ, SMC/ICT, commodity carry, the overnight effect, gold oversold-long with a stop — all negative or arbitraged to exactly transaction cost. The one survivor (long-only Donchian on 60-minute bars) was buy-and-hold with extra steps.</Note>
          <Note>The finding that mattered: bar size is first-order and fees are the whole game. That is why the crypto desk runs 4-hour breakouts, and why the prop account&apos;s 0.04% fee changes the arithmetic.</Note>
        </PanelBody>
      </Panel>

      <Explainer title="What would turn this desk back on">
        <ul>
          <li>A signal on ES, NQ, gold or oil that clears the same bar swing-lev had to clear: 30+ resolved trades, t-stat ≥ 2, forward-tested, on data the engine actually trades on.</li>
          <li>Those markets are also available on the Prop Desk&apos;s account (S&amp;P 500, Nasdaq 100, gold, oil, 24/7). A paper sleeve there is the cheapest place to look — no eval fee, no exchange fees.</li>
          <li>Not: a new prop firm, a new leverage rung, a new platform. The venue was never the problem.</li>
        </ul>
      </Explainer>
    </div>
  );
}
