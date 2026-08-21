export type PositionDirection = "long" | "short";
export type BrokerPositionView = { netPos: number; netPrice: number };

export type PositionResolution =
  | { status: "unresolved" }
  | { status: "flat"; quantity: 0 }
  | { status: "flipped"; direction: PositionDirection; quantity: number }
  | { status: "unchanged"; direction: PositionDirection; quantity: number }
  | { status: "increased"; direction: PositionDirection; quantity: number; delta: number; netPrice: number }
  | { status: "reduced"; direction: PositionDirection; quantity: number; delta: number; netPrice: number };

export function reconcileBrokerPosition(
  expectedDirection: PositionDirection,
  trackedQuantity: number,
  brokerPosition: BrokerPositionView | null | undefined,
): PositionResolution {
  if (brokerPosition === undefined) return { status: "unresolved" };
  if (brokerPosition === null || brokerPosition.netPos === 0) return { status: "flat", quantity: 0 };

  const direction: PositionDirection = brokerPosition.netPos > 0 ? "long" : "short";
  const quantity = Math.abs(brokerPosition.netPos);
  if (direction !== expectedDirection) return { status: "flipped", direction, quantity };
  if (quantity === trackedQuantity) return { status: "unchanged", direction, quantity };
  if (quantity > trackedQuantity) {
    return {
      status: "increased",
      direction,
      quantity,
      delta: quantity - trackedQuantity,
      netPrice: brokerPosition.netPrice,
    };
  }
  return {
    status: "reduced",
    direction,
    quantity,
    delta: trackedQuantity - quantity,
    netPrice: brokerPosition.netPrice,
  };
}
