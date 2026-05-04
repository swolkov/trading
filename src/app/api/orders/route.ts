import { getOrders, placeOrder, cancelOrder } from "@/lib/alpaca";
import type { PlaceOrderParams } from "@/lib/alpaca";

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const status = (searchParams.get("status") || "all") as
      | "open"
      | "closed"
      | "all";
    const orders = await getOrders(status);
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
    const body: PlaceOrderParams = await request.json();
    const order = await placeOrder(body);
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
