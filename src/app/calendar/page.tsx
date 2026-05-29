"use client";

import { useEffect, useState, useCallback } from "react";
import Link from "next/link";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";

interface EarningsItem {
  symbol: string;
  date: string;
  epsActual: number | null;
  epsEstimate: number | null;
  revenueActual: number | null;
  revenueEstimate: number | null;
  hour: string;
}

interface EconomicEvent {
  country: string;
  event: string;
  time: string;
  impact: string;
  actual: number | null;
  estimate: number | null;
  prev: number | null;
  unit: string;
}

function impactBadge(impact: string) {
  const colors: Record<string, string> = {
    high: "bg-red-600",
    medium: "bg-amber-500",
    low: "bg-muted text-muted-foreground",
  };
  return <Badge className={colors[impact] || "bg-muted"}>{impact}</Badge>;
}

export default function CalendarPage() {
  const [earnings, setEarnings] = useState<EarningsItem[]>([]);
  const [economic, setEconomic] = useState<EconomicEvent[]>([]);
  const [loading, setLoading] = useState(true);

  const loadData = useCallback(async () => {
    try {
      const res = await fetch("/api/finnhub/calendar");
      const data = await res.json();
      setEarnings(data.earnings || []);
      setEconomic(data.economic || []);
    } catch { /* ignore */ }
    setLoading(false);
  }, []);

  useEffect(() => { loadData(); }, [loadData]);

  if (loading) return <div className="p-6 text-muted-foreground">Loading calendars...</div>;

  return (
    <div className="space-y-6">
      <div><h1 className="text-xl font-bold tracking-tight">Market Calendar</h1><p className="text-[11px] text-muted-foreground/50">Economic events, earnings, and market holidays</p></div>

      <Tabs defaultValue="earnings">
        <TabsList>
          <TabsTrigger value="earnings">Earnings Calendar ({earnings.length})</TabsTrigger>
          <TabsTrigger value="economic">Economic Events ({economic.length})</TabsTrigger>
        </TabsList>

        <TabsContent value="earnings">
          <Card>
            <CardHeader>
              <CardTitle className="text-sm">Upcoming Earnings (Next 2 Weeks)</CardTitle>
            </CardHeader>
            <CardContent>
              {earnings.length > 0 ? (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Date</TableHead>
                      <TableHead>Symbol</TableHead>
                      <TableHead>Time</TableHead>
                      <TableHead className="text-right">EPS Est</TableHead>
                      <TableHead className="text-right">Rev Est</TableHead>
                      <TableHead></TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {earnings.map((e, i) => (
                      <TableRow key={i}>
                        <TableCell className="font-medium">{e.date}</TableCell>
                        <TableCell>
                          <Link href={`/research/${e.symbol}`} className="text-primary hover:underline font-medium">
                            {e.symbol}
                          </Link>
                        </TableCell>
                        <TableCell>
                          <Badge variant="outline">
                            {e.hour === "bmo" ? "Pre-Market" : e.hour === "amc" ? "After Close" : e.hour || "TBD"}
                          </Badge>
                        </TableCell>
                        <TableCell className="text-right">
                          {e.epsEstimate != null ? `$${e.epsEstimate.toFixed(2)}` : "N/A"}
                        </TableCell>
                        <TableCell className="text-right">
                          {e.revenueEstimate != null ? `$${(e.revenueEstimate / 1e9).toFixed(2)}B` : "N/A"}
                        </TableCell>
                        <TableCell>
                          <Link href={`/trade?symbol=${e.symbol}`} className="text-xs text-emerald-500 hover:underline">
                            Trade
                          </Link>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              ) : (
                <p className="text-sm text-muted-foreground text-center py-4">No upcoming earnings.</p>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="economic">
          <Card>
            <CardHeader>
              <CardTitle className="text-sm">US Economic Events (Next 7 Days)</CardTitle>
            </CardHeader>
            <CardContent>
              {economic.length > 0 ? (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Time</TableHead>
                      <TableHead>Event</TableHead>
                      <TableHead>Impact</TableHead>
                      <TableHead className="text-right">Estimate</TableHead>
                      <TableHead className="text-right">Previous</TableHead>
                      <TableHead className="text-right">Actual</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {economic.map((e, i) => (
                      <TableRow key={i}>
                        <TableCell className="text-xs text-muted-foreground whitespace-nowrap">
                          {new Date(e.time).toLocaleString()}
                        </TableCell>
                        <TableCell className="font-medium">{e.event}</TableCell>
                        <TableCell>{impactBadge(e.impact)}</TableCell>
                        <TableCell className="text-right">
                          {e.estimate != null ? `${e.estimate}${e.unit}` : "N/A"}
                        </TableCell>
                        <TableCell className="text-right">
                          {e.prev != null ? `${e.prev}${e.unit}` : "N/A"}
                        </TableCell>
                        <TableCell className="text-right font-medium">
                          {e.actual != null ? `${e.actual}${e.unit}` : "-"}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              ) : (
                <p className="text-sm text-muted-foreground text-center py-4">No upcoming economic events.</p>
              )}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}
