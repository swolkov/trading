"use client";

import { useState } from "react";
import { SymbolSearch } from "@/components/trading/symbol-search";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { formatCurrency } from "@/lib/utils";

interface InsiderTrade {
  name: string;
  change: number;
  transactionDate: string;
  transactionCode: string;
  transactionPrice: number;
}

interface CongressionalTrade {
  name: string;
  transactionType: string;
  transactionDate: string;
  amount: string;
}

export default function InsiderPage() {
  const [symbol, setSymbol] = useState("");
  const [insider, setInsider] = useState<InsiderTrade[]>([]);
  const [congressional, setCongressional] = useState<CongressionalTrade[]>([]);
  const [loading, setLoading] = useState(false);

  async function loadData(sym: string) {
    setSymbol(sym);
    setLoading(true);
    try {
      const res = await fetch(`/api/finnhub/insider?symbol=${sym}`);
      const data = await res.json();
      setInsider(data.insider || []);
      setCongressional(data.congressional || []);
    } catch { /* ignore */ }
    setLoading(false);
  }

  const netInsider = insider.reduce((sum, t) => sum + t.change, 0);

  return (
    <div className="space-y-6">
      <h2 className="text-2xl font-bold tracking-tight">Insider & Congressional Trading</h2>

      <Card>
        <CardContent className="pt-6">
          <div className="w-80">
            <SymbolSearch onSelect={loadData} value={symbol} />
          </div>
        </CardContent>
      </Card>

      {loading && <p className="text-muted-foreground">Loading insider data...</p>}

      {symbol && !loading && (
        <>
          {/* Net Activity Summary */}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm text-muted-foreground">Net Insider Activity</CardTitle>
              </CardHeader>
              <CardContent>
                <div className={`text-2xl font-bold ${netInsider > 0 ? "text-emerald-500" : netInsider < 0 ? "text-red-500" : ""}`}>
                  {netInsider > 0 ? "NET BUYING" : netInsider < 0 ? "NET SELLING" : "NEUTRAL"}
                </div>
                <p className="text-xs text-muted-foreground">
                  {Math.abs(netInsider).toLocaleString()} shares net {netInsider > 0 ? "purchased" : "sold"}
                </p>
              </CardContent>
            </Card>
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm text-muted-foreground">Total Transactions</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-bold">{insider.length}</div>
              </CardContent>
            </Card>
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm text-muted-foreground">Congressional Trades</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-bold">{congressional.length}</div>
              </CardContent>
            </Card>
          </div>

          {/* Insider Trades */}
          <Card>
            <CardHeader>
              <CardTitle className="text-sm">Insider Transactions — {symbol}</CardTitle>
            </CardHeader>
            <CardContent>
              {insider.length > 0 ? (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Date</TableHead>
                      <TableHead>Name</TableHead>
                      <TableHead>Action</TableHead>
                      <TableHead className="text-right">Shares</TableHead>
                      <TableHead className="text-right">Price</TableHead>
                      <TableHead className="text-right">Value</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {insider.map((t, i) => {
                      const isBuy = t.transactionCode === "P" || t.change > 0;
                      return (
                        <TableRow key={i}>
                          <TableCell className="text-xs">{t.transactionDate}</TableCell>
                          <TableCell className="font-medium">{t.name}</TableCell>
                          <TableCell>
                            <Badge className={isBuy ? "bg-emerald-600" : "bg-red-600"}>
                              {isBuy ? "BUY" : "SELL"}
                            </Badge>
                          </TableCell>
                          <TableCell className="text-right">
                            {Math.abs(t.change).toLocaleString()}
                          </TableCell>
                          <TableCell className="text-right">
                            {t.transactionPrice > 0 ? formatCurrency(t.transactionPrice) : "N/A"}
                          </TableCell>
                          <TableCell className="text-right">
                            {t.transactionPrice > 0 ? formatCurrency(Math.abs(t.change) * t.transactionPrice) : "N/A"}
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              ) : (
                <p className="text-sm text-muted-foreground text-center py-4">No insider transactions found.</p>
              )}
            </CardContent>
          </Card>

          {/* Congressional */}
          {congressional.length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle className="text-sm">Congressional Trading — {symbol}</CardTitle>
              </CardHeader>
              <CardContent>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Date</TableHead>
                      <TableHead>Member</TableHead>
                      <TableHead>Type</TableHead>
                      <TableHead>Amount</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {congressional.map((t, i) => (
                      <TableRow key={i}>
                        <TableCell className="text-xs">{t.transactionDate}</TableCell>
                        <TableCell className="font-medium">{t.name}</TableCell>
                        <TableCell>
                          <Badge variant="outline">{t.transactionType}</Badge>
                        </TableCell>
                        <TableCell>{t.amount}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
          )}
        </>
      )}
    </div>
  );
}
