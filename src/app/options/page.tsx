"use client";

import { Suspense, useState, useEffect, useCallback } from "react";
import { useSearchParams } from "next/navigation";
import { SymbolSearch } from "@/components/trading/symbol-search";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { formatCurrency } from "@/lib/utils";

interface OptionsContract {
  symbol: string;
  type: "call" | "put";
  strike_price: string;
  expiration_date: string;
  open_interest: string | null;
}

interface OptionsSnapshot {
  latestQuote?: { ap: number; bp: number };
  latestTrade?: { p: number };
  greeks?: {
    delta: number;
    gamma: number;
    theta: number;
    vega: number;
  };
  impliedVolatility?: number;
}

export default function OptionsPageWrapper() {
  return (
    <Suspense fallback={<div className="text-muted-foreground p-6">Loading options...</div>}>
      <OptionsPage />
    </Suspense>
  );
}

function OptionsPage() {
  const searchParams = useSearchParams();
  const [symbol, setSymbol] = useState(searchParams.get("symbol") || "");
  const [expirations, setExpirations] = useState<string[]>([]);
  const [selectedExp, setSelectedExp] = useState("");
  const [contracts, setContracts] = useState<OptionsContract[]>([]);
  const [snapshots, setSnapshots] = useState<Record<string, OptionsSnapshot>>({});
  const [loading, setLoading] = useState(false);

  const loadExpirations = useCallback(async (sym: string) => {
    const res = await fetch(`/api/options/${sym}?expirations=true`);
    const data = await res.json();
    setExpirations(data.expirations || []);
    if (data.expirations?.length > 0) {
      setSelectedExp(data.expirations[0]);
    }
  }, []);

  const loadChain = useCallback(async (sym: string, exp: string) => {
    setLoading(true);
    const res = await fetch(`/api/options/${sym}?expiration=${exp}`);
    const data = await res.json();
    setContracts(data.contracts || []);
    setSnapshots(data.snapshots || {});
    setLoading(false);
  }, []);

  useEffect(() => {
    if (symbol) loadExpirations(symbol);
  }, [symbol, loadExpirations]);

  useEffect(() => {
    if (symbol && selectedExp) loadChain(symbol, selectedExp);
  }, [symbol, selectedExp, loadChain]);

  const calls = contracts.filter((c) => c.type === "call");
  const puts = contracts.filter((c) => c.type === "put");

  function OptionsTable({ items }: { items: OptionsContract[] }) {
    return (
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Strike</TableHead>
            <TableHead className="text-right">Bid</TableHead>
            <TableHead className="text-right">Ask</TableHead>
            <TableHead className="text-right">Last</TableHead>
            <TableHead className="text-right">IV</TableHead>
            <TableHead className="text-right">Delta</TableHead>
            <TableHead className="text-right">Gamma</TableHead>
            <TableHead className="text-right">Theta</TableHead>
            <TableHead className="text-right">Vega</TableHead>
            <TableHead className="text-right">OI</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {items
            .sort(
              (a, b) =>
                parseFloat(a.strike_price) - parseFloat(b.strike_price)
            )
            .map((contract) => {
              const snap = snapshots[contract.symbol];
              const greeks = snap?.greeks;
              return (
                <TableRow key={contract.symbol}>
                  <TableCell className="font-medium">
                    ${parseFloat(contract.strike_price).toFixed(2)}
                  </TableCell>
                  <TableCell className="text-right">
                    {snap?.latestQuote
                      ? formatCurrency(snap.latestQuote.bp)
                      : "-"}
                  </TableCell>
                  <TableCell className="text-right">
                    {snap?.latestQuote
                      ? formatCurrency(snap.latestQuote.ap)
                      : "-"}
                  </TableCell>
                  <TableCell className="text-right">
                    {snap?.latestTrade
                      ? formatCurrency(snap.latestTrade.p)
                      : "-"}
                  </TableCell>
                  <TableCell className="text-right">
                    {snap?.impliedVolatility
                      ? `${(snap.impliedVolatility * 100).toFixed(1)}%`
                      : "-"}
                  </TableCell>
                  <TableCell className="text-right">
                    {greeks?.delta?.toFixed(3) || "-"}
                  </TableCell>
                  <TableCell className="text-right">
                    {greeks?.gamma?.toFixed(4) || "-"}
                  </TableCell>
                  <TableCell className="text-right">
                    {greeks?.theta?.toFixed(4) || "-"}
                  </TableCell>
                  <TableCell className="text-right">
                    {greeks?.vega?.toFixed(4) || "-"}
                  </TableCell>
                  <TableCell className="text-right">
                    {contract.open_interest || "-"}
                  </TableCell>
                </TableRow>
              );
            })}
        </TableBody>
      </Table>
    );
  }

  return (
    <div className="space-y-6">
      <h2 className="text-2xl font-bold tracking-tight">Options Chain</h2>

      <Card>
        <CardContent className="pt-6">
          <div className="flex items-center gap-4">
            <div className="w-64">
              <SymbolSearch onSelect={setSymbol} value={symbol} />
            </div>
            {expirations.length > 0 && (
              <div className="w-48">
                <Select value={selectedExp} onValueChange={(v) => v && setSelectedExp(v)}>
                  <SelectTrigger>
                    <SelectValue placeholder="Expiration" />
                  </SelectTrigger>
                  <SelectContent>
                    {expirations.map((exp) => (
                      <SelectItem key={exp} value={exp}>
                        {exp}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}
            {symbol && (
              <Badge variant="secondary">
                {calls.length} calls &middot; {puts.length} puts
              </Badge>
            )}
          </div>
        </CardContent>
      </Card>

      {loading ? (
        <div className="text-sm text-muted-foreground">
          Loading options chain...
        </div>
      ) : contracts.length > 0 ? (
        <Tabs defaultValue="calls">
          <TabsList>
            <TabsTrigger value="calls">Calls ({calls.length})</TabsTrigger>
            <TabsTrigger value="puts">Puts ({puts.length})</TabsTrigger>
          </TabsList>
          <TabsContent value="calls">
            <Card>
              <CardContent className="pt-4">
                <OptionsTable items={calls} />
              </CardContent>
            </Card>
          </TabsContent>
          <TabsContent value="puts">
            <Card>
              <CardContent className="pt-4">
                <OptionsTable items={puts} />
              </CardContent>
            </Card>
          </TabsContent>
        </Tabs>
      ) : symbol ? (
        <Card>
          <CardContent className="py-8 text-center text-sm text-muted-foreground">
            No options contracts found for {symbol}. Try a different symbol or
            expiration date.
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}
