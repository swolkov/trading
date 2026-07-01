"use client";

import { useState } from "react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

interface OrderFormProps {
  symbol: string;
}

export function OrderForm({ symbol }: OrderFormProps) {
  const [side, setSide] = useState<"buy" | "sell">("buy");
  const [type, setType] = useState<"market" | "limit" | "stop" | "stop_limit">("market");
  const [qty, setQty] = useState("1");
  const [limitPrice, setLimitPrice] = useState("");
  const [stopPrice, setStopPrice] = useState("");
  const [tif, setTif] = useState<"day" | "gtc">("day");
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<{ success?: boolean; error?: string; orderId?: string } | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!symbol || !qty) return;

    setSubmitting(true);
    setResult(null);

    try {
      const body: Record<string, string> = {
        symbol,
        qty,
        side,
        type,
        time_in_force: tif,
        mode: "live", // Alpaca is live-only — manual orders hit the real account
      };
      if ((type === "limit" || type === "stop_limit") && limitPrice) {
        body.limit_price = limitPrice;
      }
      if ((type === "stop" || type === "stop_limit") && stopPrice) {
        body.stop_price = stopPrice;
      }

      const res = await fetch("/api/orders", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();

      if (data.error) {
        setResult({ error: data.error });
      } else {
        setResult({ success: true, orderId: data.id });
      }
    } catch (err) {
      setResult({ error: err instanceof Error ? err.message : "Order failed" });
    } finally {
      setSubmitting(false);
    }
  }

  if (!symbol) {
    return (
      <div className="text-sm text-muted-foreground py-4">
        Search and select a symbol to place an order.
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div className="flex gap-2">
        <Button
          type="button"
          variant={side === "buy" ? "default" : "outline"}
          className={side === "buy" ? "bg-emerald-600 hover:bg-emerald-700 flex-1" : "flex-1"}
          onClick={() => setSide("buy")}
        >
          Buy
        </Button>
        <Button
          type="button"
          variant={side === "sell" ? "default" : "outline"}
          className={side === "sell" ? "bg-red-600 hover:bg-red-700 flex-1" : "flex-1"}
          onClick={() => setSide("sell")}
        >
          Sell
        </Button>
      </div>

      <div className="space-y-2">
        <label className="text-sm font-medium">Order Type</label>
        <Select value={type} onValueChange={(v) => setType(v as typeof type)}>
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="market">Market</SelectItem>
            <SelectItem value="limit">Limit</SelectItem>
            <SelectItem value="stop">Stop</SelectItem>
            <SelectItem value="stop_limit">Stop Limit</SelectItem>
          </SelectContent>
        </Select>
      </div>

      <div className="space-y-2">
        <label className="text-sm font-medium">Quantity</label>
        <Input
          type="number"
          min="1"
          step="1"
          value={qty}
          onChange={(e) => setQty(e.target.value)}
        />
      </div>

      {(type === "limit" || type === "stop_limit") && (
        <div className="space-y-2">
          <label className="text-sm font-medium">Limit Price</label>
          <Input
            type="number"
            step="0.01"
            placeholder="0.00"
            value={limitPrice}
            onChange={(e) => setLimitPrice(e.target.value)}
          />
        </div>
      )}

      {(type === "stop" || type === "stop_limit") && (
        <div className="space-y-2">
          <label className="text-sm font-medium">Stop Price</label>
          <Input
            type="number"
            step="0.01"
            placeholder="0.00"
            value={stopPrice}
            onChange={(e) => setStopPrice(e.target.value)}
          />
        </div>
      )}

      <div className="space-y-2">
        <label className="text-sm font-medium">Time in Force</label>
        <Select value={tif} onValueChange={(v) => setTif(v as typeof tif)}>
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="day">Day</SelectItem>
            <SelectItem value="gtc">Good Till Canceled</SelectItem>
          </SelectContent>
        </Select>
      </div>

      <Button
        type="submit"
        className={`w-full ${
          side === "buy"
            ? "bg-emerald-600 hover:bg-emerald-700"
            : "bg-red-600 hover:bg-red-700"
        }`}
        disabled={submitting}
      >
        {submitting
          ? "Placing order..."
          : `${side === "buy" ? "Buy" : "Sell"} ${qty} ${symbol}`}
      </Button>

      {result?.success && (
        <p className="text-sm text-emerald-500">
          Order placed successfully! ID: {result.orderId}
        </p>
      )}
      {result?.error && (
        <p className="text-sm text-red-500">Error: {result.error}</p>
      )}
    </form>
  );
}
