"use client";

import { Chip } from "@/components/ui/chip";
import { DataTable, Row, Td, Th } from "@/components/ui/data-table";
import { Empty, Panel, PanelBody, PanelHeader } from "@/components/ui/panel";
import { ago, usd, when } from "@/lib/format";

// The real Robinhood account's positions and orders — a SNAPSHOT with an age (the app holds no
// broker session of its own; the collector pushes after each close). Shared by the Robinhood
// Live Account page and the Orders page so both show the same rows. Data: GET /api/options/live.

export interface LivePosition {
  symbol: string; type: "long" | "short"; optionType: "call" | "put" | null; strike: number | null;
  expiry: string | null; quantity: number; averagePrice: number; pendingQuantity: number;
}
export interface LiveOrder {
  id: string; symbol: string; state: string; strategy: string | null; side: string | null;
  quantity: number; processedQuantity: number; premium: number | null; price: number | null;
  orderType: string; placedAgent: string | null; createdAt: string | null;
}
export const orderTone = (state: string) => state === "filled" ? "green" : ["rejected", "failed", "cancelled", "voided"].includes(state) ? "red" : ["queued", "confirmed", "partially_filled", "pending_cancelled"].includes(state) ? "amber" : "grey";

export function OptionPositionsTable({ positions, at }: { positions: LivePosition[]; at: string | null }) {
  return (
    <Panel>
      <PanelHeader title="Open option positions — what the broker holds" aside={<span>{at ? `as of ${ago(at)}` : "not pushed yet"}</span>} />
      {positions.length === 0 ? (
        <PanelBody><Empty>{at ? "No open option positions on the real account." : "Positions have not been pushed yet."}</Empty></PanelBody>
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
  );
}

export function OptionOrdersTable({ orders, at }: { orders: LiveOrder[]; at: string | null }) {
  return (
    <Panel>
      <PanelHeader title="Orders in the latest broker snapshot" aside={<span>newest first · placed by you in the Robinhood app, or by nothing</span>} />
      {orders.length === 0 ? (
        <PanelBody><Empty>{at ? "No orders returned in the latest broker snapshot." : "Orders have not been pushed yet."}</Empty></PanelBody>
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
  );
}
