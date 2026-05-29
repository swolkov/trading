"use client";

import useSWR from "swr";
import { Card, CardContent } from "@/components/ui/card";
import { VolumeProfile } from "./volume-profile";
import { TimeAndSales } from "./time-and-sales";
import { OrderBookLadder } from "./order-book-ladder";
import { TrendingUp, TrendingDown, Wifi } from "lucide-react";

interface DepthResponse {
  symbol: string;
  live: { bid: number | null; ask: number | null; mid: number | null; ts: number | null; source: string | null; cumVol: number | null } | null;
  tape: { ts: number; price: number; size: number; side: "B" | "S" | "?" }[];
  volumeProfile: { price: number; buyVol: number; sellVol: number; total: number }[];
  meta: { tradeCount: number; hoursBack: number; dataLag: string };
  error?: string;
}

const fetcher = (u: string) => fetch(u).then((r) => r.json());

export function DepthTapeView({ symbol }: { symbol: string }) {
  const { data, isLoading, error } = useSWR<DepthResponse>(
    `/api/databento/depth?symbol=${symbol}&hours=24`,
    fetcher,
    { refreshInterval: 60_000 }, // historical data refreshes infrequently
  );

  if (isLoading) {
    return <Card className="border-white/[0.06]"><CardContent className="py-8 text-xs text-muted-foreground text-center">Loading Databento depth data…</CardContent></Card>;
  }
  if (error || data?.error) {
    return <Card className="border-red-500/30"><CardContent className="py-4 text-xs text-red-400">{data?.error ?? String(error)}</CardContent></Card>;
  }
  if (!data) return null;

  // Cumulative buy vs sell pressure in tape
  const tapeBuys = data.tape.filter((t) => t.side === "B").reduce((s, t) => s + t.size, 0);
  const tapeSells = data.tape.filter((t) => t.side === "S").reduce((s, t) => s + t.size, 0);
  const pressureRatio = tapeBuys + tapeSells > 0 ? tapeBuys / (tapeBuys + tapeSells) : 0.5;
  const dominantSide = pressureRatio > 0.55 ? "buy" : pressureRatio < 0.45 ? "sell" : "neutral";

  return (
    <div className="space-y-3">
      {/* Live snapshot bar */}
      <Card className="border-white/[0.06]">
        <CardContent className="py-2.5">
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <div className="flex items-center gap-3">
              <div className="text-xs">
                <span className="text-muted-foreground/60">{symbol} live · </span>
                {data.live ? (
                  <>
                    <span className="text-red-400 font-mono tabular-nums">{data.live.bid?.toFixed(2)}</span>
                    <span className="text-muted-foreground/40 mx-1">×</span>
                    <span className="text-emerald-400 font-mono tabular-nums">{data.live.ask?.toFixed(2)}</span>
                    {data.live.cumVol !== null && data.live.cumVol > 0 && (
                      <span className="text-muted-foreground/50 ml-2 text-[10px]">cum vol {data.live.cumVol.toLocaleString()}</span>
                    )}
                  </>
                ) : (
                  <span className="text-muted-foreground/40">no live quote</span>
                )}
              </div>
              {data.live?.source && (
                <span className="inline-flex items-center gap-1 text-[9px] uppercase tracking-wider text-emerald-400">
                  <Wifi className="w-2.5 h-2.5" />
                  {data.live.source}
                </span>
              )}
            </div>

            {/* Tape pressure indicator */}
            <div className="flex items-center gap-2 text-[10px]">
              <span className="text-muted-foreground/60">Last {data.tape.length} trades pressure:</span>
              <div className="flex items-center gap-1">
                {dominantSide === "buy" ? <TrendingUp className="w-3 h-3 text-emerald-400" /> : dominantSide === "sell" ? <TrendingDown className="w-3 h-3 text-red-400" /> : null}
                <span className={`tabular-nums font-semibold ${dominantSide === "buy" ? "text-emerald-400" : dominantSide === "sell" ? "text-red-400" : "text-muted-foreground"}`}>
                  {(pressureRatio * 100).toFixed(0)}% buy
                </span>
              </div>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Order book + Volume profile + Time & sales */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        <Card className="border-white/[0.06]">
          <CardContent className="py-3">
            <OrderBookLadder symbol={symbol} height={420} />
          </CardContent>
        </Card>
        <Card className="border-white/[0.06]">
          <CardContent className="py-3">
            <VolumeProfile data={data.volumeProfile} currentPrice={data.live?.mid} height={420} />
          </CardContent>
        </Card>
        <Card className="border-white/[0.06]">
          <CardContent className="py-3">
            <TimeAndSales trades={data.tape} height={420} />
          </CardContent>
        </Card>
      </div>

      <div className="text-[10px] text-muted-foreground/40 px-1">
        {data.meta.tradeCount} trades aggregated over last {data.meta.hoursBack}h. {data.meta.dataLag}
      </div>
    </div>
  );
}
