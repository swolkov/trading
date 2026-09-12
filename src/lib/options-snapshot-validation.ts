// Display snapshots are not execution evidence. Reject incomplete collections rather
// than making a failed broker read look like a fresh, flat account.
export const OPTIONS_ACCOUNT_NUMBER = "685528705";

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function numeric(value: unknown): boolean {
  return (typeof value === "number" || (typeof value === "string" && value.trim() !== ""))
    && Number.isFinite(Number(value));
}

export function assertCompleteOptionsSnapshot(payload: unknown): void {
  if (!record(payload) || !record(payload.account)
    || payload.account.accountNumber !== OPTIONS_ACCOUNT_NUMBER
    || payload.positionsComplete !== true || payload.ordersComplete !== true
    || !Array.isArray(payload.positions) || !Array.isArray(payload.orders)) {
    throw new Error("Snapshot requires the configured account and complete positions/orders with pagination confirmed");
  }
  const account = payload.account;
  if (typeof account.type !== "string" || typeof account.optionLevel !== "string"
    || ["cash", "buyingPower", "optionsValue", "totalValue"].some((key) =>
      typeof account[key] !== "number" || !Number.isFinite(account[key]))) {
    throw new Error("Invalid account balances or permissions in snapshot");
  }
  for (const position of payload.positions) {
    if (!record(position) || typeof position.chain_symbol !== "string" || !position.chain_symbol.trim()
      || !["long", "short"].includes(String(position.type))
      || !numeric(position.quantity) || !numeric(position.average_price)
      || (position.pending_quantity != null && !numeric(position.pending_quantity))) {
      throw new Error("Invalid position in snapshot; previous snapshot retained");
    }
  }
  for (const order of payload.orders) {
    if (!record(order) || typeof order.id !== "string" || !order.id.trim()
      || typeof order.chain_symbol !== "string" || !order.chain_symbol.trim()
      || typeof order.state !== "string" || !order.state.trim() || !numeric(order.quantity)
      || (order.processed_quantity != null && !numeric(order.processed_quantity))) {
      throw new Error("Invalid order in snapshot; previous snapshot retained");
    }
  }
}
