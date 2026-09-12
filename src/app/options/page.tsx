"use client";

import useSWR from "swr";
import { OptionsResearchDesk } from "@/components/options/research-desk";
import { Chip } from "@/components/ui/chip";
import { DataTable, Row, Td, Th } from "@/components/ui/data-table";
import { Empty, Explainer, Note, PageHeader, Panel, PanelBody, PanelHeader, Stat } from "@/components/ui/panel";
import { ago, money, usd, when } from "@/lib/format";

// ROBINHOOD · LIVE ACCOUNT. The counterpart of the Kraken Live Account page: what the
// BROKER says — cash, buying power, option level, open option positions, recent orders —
// as the desk session last pushed it. Everything on this page is a snapshot with an age.
// Nothing on this page can place, cancel or modify an order, and the page says so.

const fetcher = (u: string) => fetch(u).then((r) => r.json());

interface Account {
  accountNumber: string; type: string; optionLevel: string; cash: number;
  buyingPower: number; optionsValue: number; totalValue: number; at: string; minutesAgo: number;
}
interface LivePosition {
  symbol: string; type: "long" | "short"; optionType: "call" | "put" | null; strike: number | null;
  expiry: string | null; quantity: number; averagePrice: number; pendingQuantity: number;
}
interface LiveOrder {
  id: string; symbol: string; state: string; strategy: string | null; side: string | null;
  quantity: number; processedQuantity: number; premium: number | null; price: number | null;
  orderType: string; placedAgent: string | null; createdAt: string | null;
}
interface Payload {
  account: Account | null;
  live: { positions: LivePosition[]; orders: LiveOrder[]; at: string; minutesAgo: number } | null;
  lastRun: string | null;
  foreignOrders: LiveOrder[];
  execution: { canPlaceOrders: boolean; why: string; maxLossUsd: number | null };
}

const levelLabel = (l: string) => l === "option_level_3" ? "Level 3 — spreads unlocked" : l === "option_level_2" ? "Level 2 — long premium only" : l;
const orderTone = (state: string) => state === "filled" ? "green" : ["rejected", "failed", "cancelled", "voided"].includes(state) ? "red" : ["queued", "confirmed", "partially_filled", "pending_cancelled"].includes(state) ? "amber" : "grey";

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
        sub="Your real Robinhood account: positions, orders and buying power from the latest broker snapshot. Live order placement is not active yet."
        right={<>
          <Chip tone="grey" size="md" title="Robinhood holds the money; the app holds no credentials and reads only what the desk pushes">Real account · read only</Chip>
          {acct && <Chip tone={acct.optionLevel === "option_level_3" ? "green" : "amber"} size="md">{levelLabel(acct.optionLevel)}</Chip>}
          <Chip tone={snapshotStale ? "red" : "green"} size="md" dot={snapshotStale} title="Pushed by the scheduled desk session after each close">
            {live ? `Snapshot ${ago(live.at)}` : acct ? `Account ${ago(acct.at)} · positions not pushed yet` : "Nothing pushed yet"}
          </Chip>
        </>}
      />

      {data && data.foreignOrders.length > 0 && (
        <Panel tone="red"><PanelBody className="py-3">
          <p className="text-[13px] font-semibold text-down">{data.foreignOrders.length} order{data.foreignOrders.length === 1 ? "" : "s"} on this account were NOT placed by you.</p>
          <Note className="mt-1">Nothing in this system is allowed to place a Robinhood order. An order with a non-&ldquo;user&rdquo; agent means a session was given an order tool. Check the Robinhood app, then check the desk runner&apos;s allowlist.</Note>
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

      {/* ── Positions ── */}
      <Panel>
        <PanelHeader title="Open option positions — what the broker holds" aside={<span>{live ? `as of ${ago(live.at)}` : "not pushed yet"}</span>} />
        {positions.length === 0 ? (
          <PanelBody><Empty>{live ? "No open option positions on the real account." : "Positions have not been pushed yet."}</Empty>

          </PanelBody>
        ) : (
          <DataTable>
            <thead><tr><Th>Contract</Th><Th>Side</Th><Th num>Qty</Th><Th num>Avg price</Th><Th num>Pending</Th></tr></thead>
            <tbody>
              {positions.map((p, i) => (
                <Row key={`${p.symbol}-${p.strike}-${p.expiry}-${i}`}>
                  <Td strong>{p.symbol} {p.strike != null ? `$${p.strike}` : ""}{p.optionType ? p.optionType[0] : ""} {p.expiry ?? ""}</Td>
                  <Td><Chip tone={p.type === "short" ? "red" : "green"}>{p.type}</Chip></Td>
                  <Td num>{p.quantity}</Td>
                  <Td num>{usd(p.averagePrice)}</Td>
                  <Td num className={p.pendingQuantity ? "text-warn" : ""}>{p.pendingQuantity || "—"}</Td>
                </Row>
              ))}
            </tbody>
          </DataTable>
        )}
      </Panel>

      {/* ── Orders ── */}
      <Panel>
        <PanelHeader title="Orders — last 30 days" aside={<span>newest first · placed by you in the Robinhood app, or by nothing</span>} />
        {orders.length === 0 ? (
          <PanelBody><Empty>{live ? "No orders in the last 30 days." : "Orders have not been pushed yet."}</Empty></PanelBody>
        ) : (
          <DataTable>
            <thead><tr><Th>When</Th><Th>Contract</Th><Th>Strategy</Th><Th>Type</Th><Th num>Qty</Th><Th num>Premium</Th><Th>State</Th><Th>Placed by</Th></tr></thead>
            <tbody>
              {orders.map((o) => (
                <Row key={o.id}>
                  <Td title={o.createdAt ? when(o.createdAt) : ""}>{o.createdAt ? ago(o.createdAt) : "—"}</Td>
                  <Td strong>{o.symbol}</Td>
                  <Td>{o.strategy ?? "—"}{o.side ? <span className="ml-1 text-muted-foreground">{o.side}</span> : null}</Td>
                  <Td>{o.orderType}{o.price != null ? ` @ ${usd(o.price)}` : ""}</Td>
                  <Td num>{o.processedQuantity && o.processedQuantity !== o.quantity ? `${o.processedQuantity}/${o.quantity}` : o.quantity}</Td>
                  <Td num>{o.premium != null ? usd(o.premium) : "—"}</Td>
                  <Td><Chip tone={orderTone(o.state)}>{o.state}</Chip></Td>
                  <Td><Chip tone={!o.placedAgent || o.placedAgent === "user" ? "grey" : "red"}>{o.placedAgent ?? "user"}</Chip></Td>
                </Row>
              ))}
            </tbody>
          </DataTable>
        )}
      </Panel>

      <OptionsResearchDesk />
      <Panel><PanelHeader title="Live trading limits" /><PanelBody>
        <Stat label="Maximum loss per trade" value={data?.execution.maxLossUsd != null ? money(data.execution.maxLossUsd) : "Not set"} sub="Includes fees. One position at a time." />
        <Note className="mt-3">Long calls, long puts and defined-risk spreads. Profit targets are not guaranteed returns.</Note>
      </PanelBody></Panel>
      <Explainer title="Live execution status">
        <p>{data?.execution.why ?? "Checking execution status..."}</p>
        <p className="mt-2">Your approved loss limit is a ceiling. An order must also fit available buying power, pass broker review and have active position monitoring.</p>
      </Explainer>
    </div>
  );
}
