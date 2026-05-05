"use client";

import { useState, useEffect } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";

interface FuturesStatus {
  connected: boolean;
  accountId?: string;
  message?: string;
}

interface FuturesResult {
  trades: { symbol: string; action: string; contracts: number; price: number; stopLoss: number; target: number; reasoning: string; success: boolean }[];
  managed: number;
  details: string[];
}

const CONTRACTS = [
  { symbol: "MES", name: "Micro E-mini S&P 500", multiplier: "$5/pt", margin: "$1,320" },
  { symbol: "MNQ", name: "Micro E-mini Nasdaq 100", multiplier: "$2/pt", margin: "$1,630" },
  { symbol: "MYM", name: "Micro E-mini Dow", multiplier: "$0.50/pt", margin: "$880" },
  { symbol: "M2K", name: "Micro E-mini Russell 2000", multiplier: "$5/pt", margin: "$730" },
];

export default function FuturesPage() {
  const [status, setStatus] = useState<FuturesStatus | null>(null);
  const [result, setResult] = useState<FuturesResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [running, setRunning] = useState(false);

  useEffect(() => {
    fetch("/api/futures")
      .then((r) => r.json())
      .then(setStatus)
      .catch(() => setStatus({ connected: false, message: "Failed to check connection" }));
  }, []);

  const runAgent = async () => {
    setRunning(true);
    try {
      const res = await fetch("/api/futures", { method: "POST" });
      const data = await res.json();
      setResult(data);
    } catch (err) {
      setResult({ trades: [], managed: 0, details: [`Error: ${err}`] });
    }
    setRunning(false);
  };

  return (
    <div className="space-y-6 animate-fade-up">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Futures Trading</h1>
          <p className="text-sm text-muted-foreground">Micro E-mini futures via Interactive Brokers</p>
        </div>
        <Button onClick={runAgent} disabled={running || !status?.connected} size="sm">
          {running ? "Running..." : "Run Futures Agent"}
        </Button>
      </div>

      {/* Connection Status */}
      <Card>
        <CardHeader>
          <CardTitle className="text-sm flex items-center gap-2">
            <span className={`w-2 h-2 rounded-full ${status?.connected ? "bg-emerald-500 live-dot" : "bg-red-500"}`} />
            IBKR Connection
          </CardTitle>
        </CardHeader>
        <CardContent>
          {status?.connected ? (
            <p className="text-sm text-emerald-400">Connected — Account {status.accountId}</p>
          ) : (
            <div className="space-y-2">
              <p className="text-sm text-muted-foreground">{status?.message || "Checking..."}</p>
              <div className="text-xs text-muted-foreground/60 space-y-1">
                <p>To connect IBKR:</p>
                <p>1. Download the <a href="https://www.interactivebrokers.com/campus/ibkr-api-page/cpapi-v1/" className="text-primary hover:underline" target="_blank">Client Portal Gateway</a></p>
                <p>2. Run: <code className="bg-white/5 px-1 rounded">bin/run.sh root/conf.yaml</code></p>
                <p>3. Set env vars: <code className="bg-white/5 px-1 rounded">IBKR_BASE_URL</code> and <code className="bg-white/5 px-1 rounded">IBKR_ACCOUNT_ID</code></p>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Available Contracts */}
      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Micro Futures Contracts</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            {CONTRACTS.map((c) => (
              <div key={c.symbol} className="bg-white/[0.03] border border-white/[0.06] rounded-lg p-3 space-y-1">
                <p className="text-sm font-bold text-emerald-400">{c.symbol}</p>
                <p className="text-[11px] text-muted-foreground">{c.name}</p>
                <div className="flex justify-between text-[10px] text-muted-foreground/60">
                  <span>{c.multiplier}</span>
                  <span>{c.margin} margin</span>
                </div>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      {/* Agent Results */}
      {result && (
        <>
          {/* Trades */}
          {result.trades.length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle className="text-sm">Trades Placed</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                {result.trades.map((trade, i) => (
                  <div key={i} className="bg-white/[0.03] border border-white/[0.06] rounded-lg p-3">
                    <div className="flex items-center justify-between mb-1">
                      <div className="flex items-center gap-2">
                        <span className="font-bold">{trade.symbol}</span>
                        <span className={`text-xs px-2 py-0.5 rounded-full ${trade.action === "long" ? "bg-emerald-500/15 text-emerald-400" : "bg-red-500/15 text-red-400"}`}>
                          {trade.action.toUpperCase()} {trade.contracts}x
                        </span>
                      </div>
                      <span className={`text-xs ${trade.success ? "text-emerald-400" : "text-red-400"}`}>
                        {trade.success ? "Filled" : "Failed"}
                      </span>
                    </div>
                    <div className="grid grid-cols-3 gap-2 text-[11px] text-muted-foreground">
                      <span>Entry: ${trade.price.toFixed(2)}</span>
                      <span>Stop: <span className="text-red-400">${trade.stopLoss.toFixed(2)}</span></span>
                      <span>Target: <span className="text-emerald-400">${trade.target.toFixed(2)}</span></span>
                    </div>
                    <p className="text-[11px] text-muted-foreground/60 mt-1">{trade.reasoning}</p>
                  </div>
                ))}
              </CardContent>
            </Card>
          )}

          {/* Agent Log */}
          <Card>
            <CardHeader>
              <CardTitle className="text-sm">Agent Log</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="bg-black/30 rounded-lg p-3 max-h-96 overflow-y-auto font-mono text-[11px] text-muted-foreground space-y-0.5">
                {result.details.map((d, i) => (
                  <div key={i} className={d.includes("TRADE:") ? "text-emerald-400 font-medium" : d.includes("STOP") ? "text-red-400" : ""}>
                    {d}
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}
