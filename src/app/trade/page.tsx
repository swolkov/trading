"use client";

import { useState } from "react";
import dynamic from "next/dynamic";
import { SymbolSearch } from "@/components/trading/symbol-search";
import { OrderForm } from "@/components/trading/order-form";
import { useQuote } from "@/hooks/use-quote";
import { formatCurrency, pnlColor } from "@/lib/utils";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

const PriceChart = dynamic(
  () =>
    import("@/components/charts/price-chart").then((mod) => ({
      default: mod.PriceChart,
    })),
  { ssr: false }
);

export default function TradePage() {
  const [symbol, setSymbol] = useState("");
  const { data: quote } = useQuote(symbol || null);

  const midPrice = quote ? (quote.bp + quote.ap) / 2 : null;

  return (
    <div className="space-y-6">
      <div><h1 className="text-xl font-bold tracking-tight">Manual Trade</h1><p className="text-[11px] text-muted-foreground/50">Direct order entry across all brokers</p></div>
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="lg:col-span-2 space-y-4">
          <Card>
            <CardHeader className="pb-3">
              <div className="flex items-center gap-4">
                <div className="w-64">
                  <SymbolSearch onSelect={setSymbol} value={symbol} />
                </div>
                {symbol && midPrice && (
                  <div className="flex items-center gap-3">
                    <span className="text-xl font-bold">{symbol}</span>
                    <span className="text-xl">{formatCurrency(midPrice)}</span>
                    {quote && (
                      <span className="text-sm text-muted-foreground">
                        Bid: {formatCurrency(quote.bp)} / Ask:{" "}
                        {formatCurrency(quote.ap)}
                      </span>
                    )}
                  </div>
                )}
              </div>
            </CardHeader>
            <CardContent>
              {symbol ? (
                <PriceChart symbol={symbol} />
              ) : (
                <div className="h-[400px] flex items-center justify-center text-muted-foreground">
                  Search for a symbol to view its chart
                </div>
              )}
            </CardContent>
          </Card>
        </div>

        <div>
          <Card>
            <CardHeader>
              <CardTitle>Place Order</CardTitle>
            </CardHeader>
            <CardContent>
              <OrderForm symbol={symbol} />
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
