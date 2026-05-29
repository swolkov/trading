"use client";

import useSWR from "swr";
import { Card, CardContent } from "@/components/ui/card";
import { Activity, AlertTriangle, Pause, ShieldCheck } from "lucide-react";

interface AccountInfo {
  key: string;
  label: string;
  broker: "Tradovate" | "Alpaca";
  balance: number | null;
  viewMode: "paper" | "live";
  tradingMode: "paper" | "live" | "disabled";
  liveTradingActivated: boolean;
}

interface AccountsResponse {
  accounts: AccountInfo[];
  summary: {
    anyLiveTrading: boolean;
    futuresLiveActivated: boolean;
    viewingLive: boolean;
  };
}

const fetcher = (u: string) => fetch(u).then((r) => r.json());

function modeBadge(m: "paper" | "live" | "disabled") {
  if (m === "live") return (
    <span className="inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded bg-red-500/15 text-red-300 border border-red-500/30">
      <Activity className="w-2.5 h-2.5" />
      LIVE TRADING
    </span>
  );
  if (m === "paper") return (
    <span className="inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded bg-emerald-500/15 text-emerald-300 border border-emerald-500/30">
      <ShieldCheck className="w-2.5 h-2.5" />
      PAPER
    </span>
  );
  return (
    <span className="inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded bg-muted/40 text-muted-foreground border border-border">
      <Pause className="w-2.5 h-2.5" />
      DISABLED
    </span>
  );
}

function brokerBadge(b: string) {
  return (
    <span className={`text-[9px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded ${
      b === "Tradovate" ? "text-amber-400 bg-amber-500/[0.08]" : "text-blue-400 bg-blue-500/[0.08]"
    }`}>
      {b}
    </span>
  );
}

export function AccountsPanel() {
  const { data, isLoading } = useSWR<AccountsResponse>(
    "/api/admin/accounts",
    fetcher,
    { refreshInterval: 30_000 },
  );

  if (isLoading) {
    return (
      <Card>
        <CardContent className="py-3 text-xs text-muted-foreground">Loading accounts…</CardContent>
      </Card>
    );
  }

  if (!data) return null;

  const showLiveAlert = data.summary.futuresLiveActivated;

  return (
    <div className="space-y-2">
      {/* Master live indicator — at-a-glance "is real money at risk" */}
      <Card className={`${showLiveAlert ? "border-red-500/40 bg-red-500/[0.04]" : "border-emerald-500/30 bg-emerald-500/[0.03]"}`}>
        <CardContent className="py-2.5">
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <div className="flex items-center gap-2">
              {showLiveAlert ? (
                <AlertTriangle className="w-4 h-4 text-red-400" />
              ) : (
                <ShieldCheck className="w-4 h-4 text-emerald-400" />
              )}
              <div>
                <div className={`text-xs font-bold ${showLiveAlert ? "text-red-300" : "text-emerald-300"}`}>
                  {showLiveAlert ? "LIVE TRADING ACTIVATED" : "All trading in paper/demo mode"}
                </div>
                <div className="text-[10px] text-muted-foreground/70 mt-0.5">
                  {showLiveAlert
                    ? "Real money at risk — futures engine fires live trades to Tradovate live account."
                    : "Engines run trades to paper/demo accounts only. Flip via Agent Hub → LIVE TRADING."}
                </div>
              </div>
            </div>
            {showLiveAlert && (
              <span className="text-[10px] uppercase tracking-wider text-red-300/70">
                ● real $
              </span>
            )}
          </div>
        </CardContent>
      </Card>

      {/* Per-account grid */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
        {data.accounts.map((acc) => {
          const isLive = acc.liveTradingActivated;
          return (
            <Card key={acc.key} className={isLive ? "border-red-500/30" : ""}>
              <CardContent className="py-2.5 px-3 space-y-1.5">
                <div className="flex items-center justify-between gap-1">
                  <div className="text-[11px] font-semibold truncate">{acc.label}</div>
                  {brokerBadge(acc.broker)}
                </div>
                <div className="text-base font-bold tabular-nums">
                  {acc.balance !== null ? `$${acc.balance.toLocaleString(undefined, { maximumFractionDigits: 0 })}` : <span className="text-muted-foreground/50 text-xs">—</span>}
                </div>
                <div className="flex items-center gap-1 flex-wrap">
                  {modeBadge(acc.tradingMode)}
                </div>
              </CardContent>
            </Card>
          );
        })}
      </div>
    </div>
  );
}
