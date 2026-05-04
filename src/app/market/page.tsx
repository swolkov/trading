"use client";

import { useEffect, useState, useCallback } from "react";
import Link from "next/link";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { formatCurrency, pnlColor } from "@/lib/utils";

interface MarketMover {
  symbol: string;
  percent_change: number;
  change: number;
  price: number;
  trade_count?: number;
  volume?: number;
}

interface NewsArticle {
  headline: string;
  summary: string;
  url: string;
  source: string;
  created_at: string;
  symbols: string[];
}

interface MarketClock {
  is_open: boolean;
  next_open: string;
  next_close: string;
}

export default function MarketPage() {
  const [movers, setMovers] = useState<{
    mostActive: MarketMover[];
    gainers: MarketMover[];
    losers: MarketMover[];
  }>({ mostActive: [], gainers: [], losers: [] });
  const [news, setNews] = useState<NewsArticle[]>([]);
  const [clock, setClock] = useState<MarketClock | null>(null);
  const [loading, setLoading] = useState(true);

  const loadData = useCallback(async () => {
    try {
      const [moversData, newsData, clockData] = await Promise.all([
        fetch("/api/movers").then((r) => r.json()),
        fetch("/api/news?limit=15").then((r) => r.json()),
        fetch("/api/clock").then((r) => r.json()),
      ]);
      setMovers(moversData);
      setNews(Array.isArray(newsData) ? newsData : []);
      setClock(clockData);
    } catch {
      // ignore
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    loadData();
  }, [loadData]);

  function MoverTable({ items, showVolume }: { items: MarketMover[]; showVolume?: boolean }) {
    return (
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Symbol</TableHead>
            <TableHead className="text-right">Price</TableHead>
            <TableHead className="text-right">Change %</TableHead>
            {showVolume && (
              <TableHead className="text-right">Volume</TableHead>
            )}
            <TableHead></TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {items.slice(0, 15).map((m) => (
            <TableRow key={m.symbol}>
              <TableCell className="font-medium">{m.symbol}</TableCell>
              <TableCell className="text-right">
                {formatCurrency(m.price)}
              </TableCell>
              <TableCell
                className={`text-right font-medium ${pnlColor(
                  m.percent_change
                )}`}
              >
                {m.percent_change >= 0 ? "+" : ""}
                {m.percent_change.toFixed(2)}%
              </TableCell>
              {showVolume && (
                <TableCell className="text-right text-xs text-muted-foreground">
                  {(m.trade_count || m.volume || 0).toLocaleString()}
                </TableCell>
              )}
              <TableCell>
                <div className="flex gap-1">
                  <Link
                    href={`/research/${m.symbol}`}
                    className="text-xs text-primary hover:underline"
                  >
                    Research
                  </Link>
                  <span className="text-muted-foreground">&middot;</span>
                  <Link
                    href={`/trade?symbol=${m.symbol}`}
                    className="text-xs text-emerald-500 hover:underline"
                  >
                    Trade
                  </Link>
                </div>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    );
  }

  if (loading) {
    return (
      <div className="space-y-6">
        <h2 className="text-2xl font-bold">Market Intelligence</h2>
        <div className="text-muted-foreground">Loading market data...</div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h2 className="text-2xl font-bold tracking-tight">
          Market Intelligence
        </h2>
        {clock && (
          <Badge
            variant={clock.is_open ? "default" : "secondary"}
            className={clock.is_open ? "bg-emerald-600" : ""}
          >
            Market {clock.is_open ? "Open" : "Closed"}
            {!clock.is_open &&
              ` — Opens ${new Date(clock.next_open).toLocaleString()}`}
          </Badge>
        )}
      </div>

      {/* Movers Grid */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <Card>
          <CardHeader>
            <CardTitle className="text-sm flex items-center gap-2">
              Top Gainers
              <Badge variant="outline" className="text-emerald-500">
                {movers.gainers.length}
              </Badge>
            </CardTitle>
          </CardHeader>
          <CardContent>
            <MoverTable items={movers.gainers} />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-sm flex items-center gap-2">
              Top Losers
              <Badge variant="outline" className="text-red-500">
                {movers.losers.length}
              </Badge>
            </CardTitle>
          </CardHeader>
          <CardContent>
            <MoverTable items={movers.losers} />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-sm flex items-center gap-2">
              Most Active
              <Badge variant="outline">{movers.mostActive.length}</Badge>
            </CardTitle>
          </CardHeader>
          <CardContent>
            <MoverTable items={movers.mostActive} showVolume />
          </CardContent>
        </Card>
      </div>

      {/* Market News */}
      <Card>
        <CardHeader>
          <CardTitle>Market News</CardTitle>
        </CardHeader>
        <CardContent>
          {news.length > 0 ? (
            <div className="space-y-4">
              {news.map((article, i) => (
                <div
                  key={i}
                  className="border-b border-border/50 pb-4 last:border-0"
                >
                  <div className="flex items-start justify-between gap-4">
                    <div className="flex-1">
                      <a
                        href={article.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-sm font-medium hover:underline"
                      >
                        {article.headline}
                      </a>
                      <p className="text-xs text-muted-foreground mt-1">
                        {article.source} &middot;{" "}
                        {new Date(article.created_at).toLocaleString()}
                      </p>
                      {article.summary && (
                        <p className="text-xs text-muted-foreground mt-1 line-clamp-2">
                          {article.summary}
                        </p>
                      )}
                    </div>
                    {article.symbols?.length > 0 && (
                      <div className="flex gap-1 flex-wrap">
                        {article.symbols.slice(0, 3).map((s) => (
                          <Link key={s} href={`/research/${s}`}>
                            <Badge
                              variant="outline"
                              className="text-xs hover:bg-accent cursor-pointer"
                            >
                              {s}
                            </Badge>
                          </Link>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">No news available.</p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
