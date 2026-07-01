import { getOrders, placeOrder, cancelOrder } from "@/lib/alpaca";
import type { PlaceOrderParams } from "@/lib/alpaca";
import type { TradingMode } from "@/lib/trading-mode";

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const status = (searchParams.get("status") || "all") as
      | "open"
      | "closed"
      | "all";
    // Alpaca is live-only — always show real live order history (no paper/demo).
    const orders = await getOrders(status, "live");
    return Response.json(orders);
  } catch (error) {
    console.error("[/api/orders GET]", error);
    return Response.json(
      { error: error instanceof Error ? error.message : "Unknown error" },
      { status: 500 }
    );
  }
}

export async function POST(request: Request) {
  try {
    // `mode` is an optional routing hint (e.g. the options page forces "live").
    // Strip it out so it isn't sent to Alpaca as an order field. When absent,
    // placeOrder(orderParams, undefined) preserves the exact prior behavior for
    // all other callers (e.g. the positions-table close buttons).
    const { mode, ...orderParams }: PlaceOrderParams & { mode?: TradingMode } =
      await request.json();
    const order = await placeOrder(orderParams, mode);
    return Response.json(order);
  } catch (error) {
    console.error("[/api/orders POST]", error);
    return Response.json(
      { error: error instanceof Error ? error.message : "Unknown error" },
      { status: 500 }
    );
  }
}

export async function DELETE(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const orderId = searchParams.get("orderId");
    if (!orderId) {
      return Response.json({ error: "orderId required" }, { status: 400 });
    }
    await cancelOrder(orderId);
    return Response.json({ success: true });
  } catch (error) {
    console.error("[/api/orders DELETE]", error);
    return Response.json(
      { error: error instanceof Error ? error.message : "Unknown error" },
      { status: 500 }
    );
  }
}
