"use client";

import useSWR from "swr";
import { OptionsResearchDesk } from "@/components/options/research-desk";
import { OptionsLiveDeskPanel } from "@/components/options/live-desk-panel";
import { OptionsScorePanel } from "@/components/options/score-panel";
import { OptionsBriefPanel } from "@/components/options/brief-panel";
import { OptionOrdersTable, OptionPositionsTable, type LiveOrder, type LivePosition } from "@/components/options/account-tables";
import { Chip } from "@/components/ui/chip";
import { Empty, Note, PageHeader, Panel, PanelBody, PanelHeader, Stat } from "@/components/ui/panel";
import { ago, money } from "@/lib/format";

// ROBINHOOD · LIVE ACCOUNT. The real-money page: what the
// BROKER says — cash, buying power, option level, open option positions, recent orders —
// as the desk session last pushed it. Everything on this page is a snapshot with an age.
// Nothing on this page can place, cancel or modify an order, and the page says so.

const fetcher = (u: string) => fetch(u).then((r) => r.json());

interface Account {
  accountNumber: string; type: string; optionLevel: string; cash: number;
  buyingPower: number; optionsValue: number; totalValue: number; at: string; minutesAgo: number;
}
interface Payload {
  account: Account | null;
  live: { positions: LivePosition[]; orders: LiveOrder[]; at: string; minutesAgo: number } | null;
  lastRun: string | null;
  foreignOrders: LiveOrder[];
  execution: { canPlaceOrders: boolean; why: string; maxLossUsd: number | null };
}

const levelLabel = (l: string) => l === "option_level_3" ? "Level 3 — spreads unlocked" : l === "option_level_2" ? "Level 2 — long premium only" : l;

export default function RobinhoodLiveAccountPage() {
  const { data } = useSWR<Payload>("/api/options/live", fetcher, { refreshInterval: 60_000 });
  const acct = data?.account ?? null;
  const live = data?.live ?? null;
  const snapshotStale = !!data && (!live || live.minutesAgo > 36 * 60);
  const positions = live?.positions ?? [];
  const orders = live?.orders ?? [];

  return (
    <div className="space-y-5">
      <PageHeader
        title="Live Account"
        sub={`Your real Robinhood account: positions, orders and buying power from the latest broker snapshot. ${data?.execution.canPlaceOrders ? "The live desk is armed: it takes every name that clears the screen — one contract each (two on a Strong grade that fits twice), up to three at once — inside the approved cap." : "Live order placement is not active."}`}
        right={<>
          <Chip tone={data?.execution.canPlaceOrders ? "red" : "grey"} size="md" dot={!!data?.execution.canPlaceOrders} title="Robinhood holds the money; orders come only from the live desk on Railway, never from this page">{data?.execution.canPlaceOrders ? "Real account · live desk armed" : "Real account · read only"}</Chip>
          {acct && <Chip tone={acct.optionLevel === "option_level_3" ? "green" : "amber"} size="md">{levelLabel(acct.optionLevel)}</Chip>}
          <Chip tone={snapshotStale ? "red" : "green"} size="md" dot={snapshotStale} title="Pushed by the scheduled desk session after each close">
            {live ? `Snapshot ${ago(live.at)}` : acct ? `Account ${ago(acct.at)} · positions not pushed yet` : "Nothing pushed yet"}
          </Chip>
        </>}
      />

      {data && data.foreignOrders.length > 0 && (
        <Panel tone="red"><PanelBody className="py-3">
          <p className="text-[13px] font-semibold text-down">{data.foreignOrders.length} order{data.foreignOrders.length === 1 ? "" : "s"} on this account were NOT placed by you.</p>
          <Note className="mt-1">Only the live desk may place a Robinhood order, and it records every one it sends. An agentic order the desk does not recognise means another session was given an order tool. Check the Robinhood app, then the desk log below.</Note>
        </PanelBody></Panel>
      )}

      {snapshotStale && (
        <Panel tone="red"><PanelBody className="py-3">
          <p className="text-[13px] font-semibold text-down">This snapshot is stale — the numbers below are what the broker said {live ? ago(live.at) : "at some earlier point"}, not now.</p>
          <Note className="mt-1">The account collector refreshes positions and orders after each close. Check the scheduled collector and Robinhood connection.</Note>
        </PanelBody></Panel>
      )}

      {/* ── The account ── */}
      <Panel>
        <PanelHeader title="Robinhood account" aside={acct ? <span>••••{acct.accountNumber.slice(-4)} · {acct.type.replace("_", " ")} · as of {ago(acct.at)}</span> : <span>not pushed yet</span>} />
        <PanelBody>
          {acct ? (
            <div className="grid grid-cols-2 gap-4 md:grid-cols-5">
              <Stat size="lg" label="Account value" value={money(acct.totalValue)} />
              <Stat label="Cash" value={money(acct.cash)} />
              <Stat label="Buying power" value={money(acct.buyingPower)} sub="what one entry could spend" />
              <Stat label="Options value" value={money(acct.optionsValue)} sub={positions.length ? `${positions.length} open` : "no positions"} />
              <Stat label="Option level" value={acct.optionLevel === "option_level_3" ? "3" : acct.optionLevel === "option_level_2" ? "2" : "—"} sub={levelLabel(acct.optionLevel)} />
            </div>
          ) : <Empty>No account snapshot yet — the desk session writes one on its first run.</Empty>}
        </PanelBody>
      </Panel>

      <OptionPositionsTable positions={positions} at={live?.at ?? null} />
      <OptionOrdersTable orders={orders} at={live?.at ?? null} />

      <OptionsLiveDeskPanel />
      <OptionsBriefPanel />
      <OptionsResearchDesk />
      <OptionsScorePanel />
    </div>
  );
}
