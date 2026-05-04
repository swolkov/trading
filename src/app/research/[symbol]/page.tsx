"use client";

import { useEffect, useState, use } from "react";
import Link from "next/link";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { formatCurrency, pnlColor } from "@/lib/utils";

interface ResearchData {
  profile: {
    symbol: string;
    name: string;
    sector: string;
    industry: string;
    description: string;
    website: string;
    marketCap: number;
    employees: number;
    country: string;
    exchange: string;
  } | null;
  stats: Record<string, number | string | null> | null;
  income: {
    date: string;
    revenue: number;
    grossProfit: number;
    operatingIncome: number;
    netIncome: number;
    ebitda: number;
  }[];
  earnings: {
    quarterly: {
      date: string;
      actual: number | null;
      estimate: number | null;
      surprise: number | null;
      surprisePercent: number | null;
    }[];
    annual: { year: number; earnings: number; revenue: number }[];
  } | null;
  analysts: {
    period: string;
    strongBuy: number;
    buy: number;
    hold: number;
    sell: number;
    strongSell: number;
  }[];
}

function formatLargeNumber(n: number | null | undefined): string {
  if (n == null) return "N/A";
  if (Math.abs(n) >= 1e12) return `$${(n / 1e12).toFixed(2)}T`;
  if (Math.abs(n) >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
  if (Math.abs(n) >= 1e6) return `$${(n / 1e6).toFixed(2)}M`;
  return formatCurrency(n);
}

function formatRatio(n: number | null | undefined): string {
  if (n == null) return "N/A";
  return n.toFixed(2);
}

function formatPct(n: number | null | undefined): string {
  if (n == null) return "N/A";
  return `${(n * 100).toFixed(2)}%`;
}

function ratingColor(key: string | null | undefined): string {
  if (!key) return "text-muted-foreground";
  if (key.includes("buy") || key === "strong_buy") return "text-emerald-500";
  if (key === "hold") return "text-amber-500";
  if (key.includes("sell")) return "text-red-500";
  return "text-muted-foreground";
}

function StatRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between py-1.5 border-b border-border/50 last:border-0">
      <span className="text-sm text-muted-foreground">{label}</span>
      <span className="text-sm font-medium">{value}</span>
    </div>
  );
}

export default function ResearchPage({
  params,
}: {
  params: Promise<{ symbol: string }>;
}) {
  const { symbol } = use(params);
  const [data, setData] = useState<ResearchData | null>(null);
  const [loading, setLoading] = useState(true);
  const [news, setNews] = useState<
    { headline: string; summary: string; url: string; created_at: string; source: string }[]
  >([]);

  useEffect(() => {
    setLoading(true);
    Promise.all([
      fetch(`/api/research/${symbol}`).then((r) => r.json()),
      fetch(`/api/news?symbols=${symbol}&limit=10`).then((r) => r.json()),
    ]).then(([researchData, newsData]) => {
      setData(researchData);
      setNews(Array.isArray(newsData) ? newsData : []);
      setLoading(false);
    });
  }, [symbol]);

  if (loading) {
    return (
      <div className="space-y-6">
        <h2 className="text-2xl font-bold">Researching {symbol.toUpperCase()}...</h2>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          {[...Array(6)].map((_, i) => (
            <Card key={i}>
              <CardContent className="pt-6">
                <div className="h-24 bg-muted animate-pulse rounded" />
              </CardContent>
            </Card>
          ))}
        </div>
      </div>
    );
  }

  if (!data?.profile) {
    return (
      <div className="space-y-6">
        <h2 className="text-2xl font-bold">Symbol not found: {symbol.toUpperCase()}</h2>
        <p className="text-muted-foreground">
          Could not find research data for this symbol.
        </p>
      </div>
    );
  }

  const { profile, stats, income, earnings, analysts } = data;
  const currentAnalyst = analysts?.[0];
  const totalRatings = currentAnalyst
    ? currentAnalyst.strongBuy +
      currentAnalyst.buy +
      currentAnalyst.hold +
      currentAnalyst.sell +
      currentAnalyst.strongSell
    : 0;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-start justify-between">
        <div>
          <div className="flex items-center gap-3">
            <h2 className="text-2xl font-bold">{profile.name}</h2>
            <Badge variant="secondary">{profile.symbol}</Badge>
            <Badge variant="outline">{profile.exchange}</Badge>
          </div>
          <p className="text-sm text-muted-foreground mt-1">
            {profile.sector} &middot; {profile.industry} &middot;{" "}
            {profile.country}
          </p>
        </div>
        <div className="flex gap-2">
          <Link
            href={`/trade?symbol=${profile.symbol}`}
            className="px-4 py-2 bg-emerald-600 text-white rounded-md text-sm font-medium hover:bg-emerald-700"
          >
            Trade {profile.symbol}
          </Link>
          <Link
            href={`/options?symbol=${profile.symbol}`}
            className="px-4 py-2 bg-primary text-primary-foreground rounded-md text-sm font-medium hover:bg-primary/90"
          >
            Options Chain
          </Link>
        </div>
      </div>

      {/* Analyst Rating + Key Metrics Row */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm text-muted-foreground">
              Analyst Rating
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div
              className={`text-2xl font-bold capitalize ${ratingColor(
                stats?.recommendationKey as string
              )}`}
            >
              {(stats?.recommendationKey as string)?.replace("_", " ") || "N/A"}
            </div>
            <p className="text-xs text-muted-foreground">
              {stats?.numberOfAnalysts || 0} analysts &middot; Target{" "}
              {formatCurrency(stats?.targetMeanPrice as number || 0)}
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm text-muted-foreground">
              Market Cap
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">
              {formatLargeNumber(profile.marketCap)}
            </div>
            <p className="text-xs text-muted-foreground">
              {profile.employees?.toLocaleString() || "N/A"} employees
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm text-muted-foreground">
              P/E Ratio
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">
              {formatRatio(stats?.pe as number)}
            </div>
            <p className="text-xs text-muted-foreground">
              Forward: {formatRatio(stats?.forwardPe as number)}
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm text-muted-foreground">
              EPS
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">
              ${formatRatio(stats?.eps as number)}
            </div>
            <p className="text-xs text-muted-foreground">
              Forward: ${formatRatio(stats?.forwardEps as number)}
            </p>
          </CardContent>
        </Card>
      </div>

      {/* Main Content Tabs */}
      <Tabs defaultValue="overview">
        <TabsList>
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="financials">Financials</TabsTrigger>
          <TabsTrigger value="earnings">Earnings</TabsTrigger>
          <TabsTrigger value="analysts">Analysts</TabsTrigger>
          <TabsTrigger value="news">News</TabsTrigger>
        </TabsList>

        {/* Overview Tab */}
        <TabsContent value="overview" className="space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <Card>
              <CardHeader>
                <CardTitle className="text-sm">Valuation</CardTitle>
              </CardHeader>
              <CardContent>
                <StatRow label="P/E (TTM)" value={formatRatio(stats?.pe as number)} />
                <StatRow label="Forward P/E" value={formatRatio(stats?.forwardPe as number)} />
                <StatRow label="PEG Ratio" value={formatRatio(stats?.peg as number)} />
                <StatRow label="Price/Book" value={formatRatio(stats?.priceToBook as number)} />
                <StatRow label="Price/Sales" value={formatRatio(stats?.priceToSales as number)} />
                <StatRow label="EV/EBITDA" value="N/A" />
              </CardContent>
            </Card>
            <Card>
              <CardHeader>
                <CardTitle className="text-sm">Profitability</CardTitle>
              </CardHeader>
              <CardContent>
                <StatRow label="Gross Margin" value={formatPct(stats?.grossMargin as number)} />
                <StatRow label="Operating Margin" value={formatPct(stats?.operatingMargin as number)} />
                <StatRow label="Profit Margin" value={formatPct(stats?.profitMargin as number)} />
                <StatRow label="ROE" value={formatPct(stats?.returnOnEquity as number)} />
                <StatRow label="ROA" value={formatPct(stats?.returnOnAssets as number)} />
                <StatRow label="Revenue Growth" value={formatPct(stats?.revenueGrowth as number)} />
              </CardContent>
            </Card>
            <Card>
              <CardHeader>
                <CardTitle className="text-sm">Financial Health</CardTitle>
              </CardHeader>
              <CardContent>
                <StatRow label="Debt/Equity" value={formatRatio(stats?.debtToEquity as number)} />
                <StatRow label="Current Ratio" value={formatRatio(stats?.currentRatio as number)} />
                <StatRow label="Free Cash Flow" value={formatLargeNumber(stats?.freeCashFlow as number)} />
                <StatRow label="Revenue" value={formatLargeNumber(stats?.revenue as number)} />
                <StatRow label="Beta" value={formatRatio(stats?.beta as number)} />
                <StatRow label="Short Ratio" value={formatRatio(stats?.shortRatio as number)} />
              </CardContent>
            </Card>
            <Card>
              <CardHeader>
                <CardTitle className="text-sm">Trading Info</CardTitle>
              </CardHeader>
              <CardContent>
                <StatRow label="52W High" value={formatCurrency(stats?.fiftyTwoWeekHigh as number || 0)} />
                <StatRow label="52W Low" value={formatCurrency(stats?.fiftyTwoWeekLow as number || 0)} />
                <StatRow label="50D Avg" value={formatCurrency(stats?.fiftyDayAvg as number || 0)} />
                <StatRow label="200D Avg" value={formatCurrency(stats?.twoHundredDayAvg as number || 0)} />
                <StatRow label="Avg Volume" value={(stats?.avgVolume as number)?.toLocaleString() || "N/A"} />
                <StatRow
                  label="Dividend Yield"
                  value={stats?.dividendYield ? formatPct(stats.dividendYield as number) : "N/A"}
                />
              </CardContent>
            </Card>
          </div>

          {/* Company Description */}
          <Card>
            <CardHeader>
              <CardTitle className="text-sm">About {profile.name}</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-sm text-muted-foreground leading-relaxed">
                {profile.description || "No description available."}
              </p>
              {profile.website && (
                <a
                  href={profile.website}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-sm text-primary hover:underline mt-2 inline-block"
                >
                  {profile.website}
                </a>
              )}
            </CardContent>
          </Card>

          {/* Price Target */}
          {stats?.targetMeanPrice && (
            <Card>
              <CardHeader>
                <CardTitle className="text-sm">Analyst Price Targets</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="flex items-center gap-8">
                  <div>
                    <p className="text-xs text-muted-foreground">Low</p>
                    <p className="text-lg font-semibold">
                      {formatCurrency(stats.targetLowPrice as number || 0)}
                    </p>
                  </div>
                  <div className="flex-1 h-2 bg-muted rounded-full relative">
                    <div
                      className="absolute h-4 w-1 bg-primary rounded top-1/2 -translate-y-1/2"
                      style={{
                        left: `${
                          (((stats.targetMeanPrice as number) - (stats.targetLowPrice as number)) /
                            ((stats.targetHighPrice as number) - (stats.targetLowPrice as number))) *
                          100
                        }%`,
                      }}
                    />
                  </div>
                  <div>
                    <p className="text-xs text-muted-foreground">High</p>
                    <p className="text-lg font-semibold">
                      {formatCurrency(stats.targetHighPrice as number || 0)}
                    </p>
                  </div>
                </div>
                <p className="text-center text-sm mt-2">
                  Mean Target:{" "}
                  <span className="font-semibold">
                    {formatCurrency(stats.targetMeanPrice as number)}
                  </span>{" "}
                  ({stats.numberOfAnalysts} analysts)
                </p>
              </CardContent>
            </Card>
          )}
        </TabsContent>

        {/* Financials Tab */}
        <TabsContent value="financials">
          <Card>
            <CardHeader>
              <CardTitle>Income Statement (Annual)</CardTitle>
            </CardHeader>
            <CardContent>
              {income && income.length > 0 ? (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Year</TableHead>
                      <TableHead className="text-right">Revenue</TableHead>
                      <TableHead className="text-right">Gross Profit</TableHead>
                      <TableHead className="text-right">Operating Income</TableHead>
                      <TableHead className="text-right">Net Income</TableHead>
                      <TableHead className="text-right">EBITDA</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {income.map((row) => (
                      <TableRow key={row.date}>
                        <TableCell className="font-medium">
                          {row.date.slice(0, 4)}
                        </TableCell>
                        <TableCell className="text-right">
                          {formatLargeNumber(row.revenue)}
                        </TableCell>
                        <TableCell className="text-right">
                          {formatLargeNumber(row.grossProfit)}
                        </TableCell>
                        <TableCell
                          className={`text-right ${pnlColor(row.operatingIncome)}`}
                        >
                          {formatLargeNumber(row.operatingIncome)}
                        </TableCell>
                        <TableCell
                          className={`text-right ${pnlColor(row.netIncome)}`}
                        >
                          {formatLargeNumber(row.netIncome)}
                        </TableCell>
                        <TableCell className="text-right">
                          {formatLargeNumber(row.ebitda)}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              ) : (
                <p className="text-sm text-muted-foreground">
                  No financial data available.
                </p>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* Earnings Tab */}
        <TabsContent value="earnings" className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>Quarterly Earnings</CardTitle>
            </CardHeader>
            <CardContent>
              {earnings?.quarterly && earnings.quarterly.length > 0 ? (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Quarter</TableHead>
                      <TableHead className="text-right">EPS Actual</TableHead>
                      <TableHead className="text-right">EPS Estimate</TableHead>
                      <TableHead className="text-right">Surprise</TableHead>
                      <TableHead className="text-right">Surprise %</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {earnings.quarterly.map((q, i) => (
                      <TableRow key={i}>
                        <TableCell className="font-medium">{q.date}</TableCell>
                        <TableCell className="text-right">
                          ${q.actual?.toFixed(2) || "N/A"}
                        </TableCell>
                        <TableCell className="text-right">
                          ${q.estimate?.toFixed(2) || "N/A"}
                        </TableCell>
                        <TableCell
                          className={`text-right ${pnlColor(q.surprise || 0)}`}
                        >
                          {q.surprise != null
                            ? `${q.surprise >= 0 ? "+" : ""}$${q.surprise.toFixed(2)}`
                            : "N/A"}
                        </TableCell>
                        <TableCell
                          className={`text-right ${pnlColor(
                            q.surprisePercent || 0
                          )}`}
                        >
                          {q.surprisePercent != null
                            ? `${q.surprisePercent >= 0 ? "+" : ""}${(
                                q.surprisePercent * 100
                              ).toFixed(1)}%`
                            : "N/A"}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              ) : (
                <p className="text-sm text-muted-foreground">
                  No earnings data available.
                </p>
              )}
            </CardContent>
          </Card>

          {earnings?.annual && earnings.annual.length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle>Annual Earnings & Revenue</CardTitle>
              </CardHeader>
              <CardContent>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Year</TableHead>
                      <TableHead className="text-right">Earnings</TableHead>
                      <TableHead className="text-right">Revenue</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {earnings.annual.map((a) => (
                      <TableRow key={a.year}>
                        <TableCell className="font-medium">{a.year}</TableCell>
                        <TableCell
                          className={`text-right ${pnlColor(a.earnings)}`}
                        >
                          {formatLargeNumber(a.earnings)}
                        </TableCell>
                        <TableCell className="text-right">
                          {formatLargeNumber(a.revenue)}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
          )}
        </TabsContent>

        {/* Analysts Tab */}
        <TabsContent value="analysts">
          <Card>
            <CardHeader>
              <CardTitle>Analyst Recommendations</CardTitle>
            </CardHeader>
            <CardContent>
              {currentAnalyst && totalRatings > 0 ? (
                <div className="space-y-4">
                  {[
                    { label: "Strong Buy", value: currentAnalyst.strongBuy, color: "bg-emerald-500" },
                    { label: "Buy", value: currentAnalyst.buy, color: "bg-emerald-400" },
                    { label: "Hold", value: currentAnalyst.hold, color: "bg-amber-500" },
                    { label: "Sell", value: currentAnalyst.sell, color: "bg-red-400" },
                    { label: "Strong Sell", value: currentAnalyst.strongSell, color: "bg-red-500" },
                  ].map((item) => (
                    <div key={item.label} className="flex items-center gap-3">
                      <span className="text-sm w-24">{item.label}</span>
                      <div className="flex-1 h-6 bg-muted rounded-full overflow-hidden">
                        <div
                          className={`h-full ${item.color} rounded-full flex items-center justify-end pr-2`}
                          style={{
                            width: `${(item.value / totalRatings) * 100}%`,
                            minWidth: item.value > 0 ? "24px" : "0",
                          }}
                        >
                          {item.value > 0 && (
                            <span className="text-xs font-medium text-white">
                              {item.value}
                            </span>
                          )}
                        </div>
                      </div>
                    </div>
                  ))}
                  <p className="text-sm text-muted-foreground mt-2">
                    Based on {totalRatings} analyst ratings for the current
                    period
                  </p>
                </div>
              ) : (
                <p className="text-sm text-muted-foreground">
                  No analyst data available.
                </p>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* News Tab */}
        <TabsContent value="news">
          <Card>
            <CardHeader>
              <CardTitle>Latest News</CardTitle>
            </CardHeader>
            <CardContent>
              {news.length > 0 ? (
                <div className="space-y-4">
                  {news.map((article, i) => (
                    <div key={i} className="border-b border-border/50 pb-4 last:border-0">
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
                        {new Date(article.created_at).toLocaleDateString()}
                      </p>
                      {article.summary && (
                        <p className="text-xs text-muted-foreground mt-1 line-clamp-2">
                          {article.summary}
                        </p>
                      )}
                    </div>
                  ))}
                </div>
              ) : (
                <p className="text-sm text-muted-foreground">
                  No recent news found.
                </p>
              )}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}
