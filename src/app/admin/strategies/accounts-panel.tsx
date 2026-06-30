"use client";

import { useState } from "react";
import useSWR, { mutate as globalMutate } from "swr";
import { Card, CardContent } from "@/components/ui/card";
import { Sparkline } from "@/components/ui/sparkline";
import { Activity, AlertTriangle, Pause, ShieldCheck, ShieldOff, Skull, Wifi, WifiOff } from "lucide-react";

interface AccountInfo {
  key: string;
  label: string;
  broker: "Tradovate" | "Alpaca";
  balance: number | null;
  balanceSource: "broker_live" | "daily_cache" | "unavailable";
  unrealizedPnl: number;
  todayPnl: number;
  todayTrades: number;
  dailyLossLimitPct: number;
  riskUsedPct: number;
  drawdownPct: number;
  viewMode: "paper" | "live";
  tradingMode: "paper" | "live" | "disabled";
  liveTradingActivated: boolean;
  pnlSparkline: number[];
}

interface AccountsResponse {
  accounts: AccountInfo[];
  summary: { anyLiveTrading: boolean; futuresLiveActivated: boolean; viewingLive: boolean };
}

const fetcher = (u: string) => fetch(u).then((r) => r.json());

function modeBadge(m: "paper" | "live" | "disabled") {
  if (m === "live") return <span className="inline-flex items-center gap-1 text-[9px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded bg-red-500/15 text-red-300 border border-red-500/30"><Activity className="w-2.5 h-2.5" />Live</span>;
  if (m === "paper") return <span className="inline-flex items-center gap-1 text-[9px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded bg-emerald-500/15 text-emerald-300 border border-emerald-500/30"><ShieldCheck className="w-2.5 h-2.5" />Paper</span>;
  return <span className="inline-flex items-center gap-1 text-[9px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded bg-muted/40 text-muted-foreground border border-border"><Pause className="w-2.5 h-2.5" />Off</span>;
}

function brokerBadge(b: string) {
  return <span className={`text-[8px] font-bold uppercase tracking-wider px-1 py-0.5 rounded ${b === "Tradovate" ? "text-amber-400 bg-amber-500/[0.08]" : "text-blue-400 bg-blue-500/[0.08]"}`}>{b}</span>;
}

function fmtMoney(n: number) {
  return (n < 0 ? "−$" : "$") + Math.abs(n).toLocaleString(undefined, { maximumFractionDigits: 0 });
}

function KillSwitchButton({ futuresLive, currentMode }: { futuresLive: boolean; currentMode: "paper" | "live" | "disabled" }) {
  const [open, setOpen] = useState(false);
  const [pwd, setPwd] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  const execute = async (action: "kill" | "restore") => {
    setBusy(true);
    setErr("");
    try {
      const res = await fetch("/api/admin/kill-switch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password: pwd, action }),
      });
      const body = await res.json();
      if (!res.ok) {
        setErr(body.error || res.statusText);
      } else {
        setOpen(false);
        setPwd("");
        await globalMutate("/api/admin/accounts");
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const isDisabled = currentMode === "disabled";

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className={isDisabled
          ? "inline-flex items-center gap-1.5 text-xs px-2.5 py-1.5 rounded-md border border-amber-500/30 bg-amber-500/[0.06] text-amber-300 hover:bg-amber-500/[0.12] transition-colors"
          : "inline-flex items-center gap-1.5 text-xs font-semibold px-2.5 py-1.5 rounded-md border border-red-500/40 bg-red-500/[0.08] text-red-300 hover:bg-red-500/[0.16] transition-colors"
        }
      >
        {isDisabled ? <ShieldOff className="w-3.5 h-3.5" /> : <Skull className="w-3.5 h-3.5" />}
        {isDisabled ? "Trading DISABLED — restore to paper" : "Kill Switch"}
      </button>
      {open && (
        <div className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-4" onClick={() => setOpen(false)}>
          <Card className="max-w-md w-full border-red-500/40" onClick={(e) => e.stopPropagation()}>
            <CardContent className="py-5 space-y-3">
              <div className="flex items-center gap-2">
                <AlertTriangle className="w-5 h-5 text-red-400" />
                <h2 className="text-base font-bold">{isDisabled ? "Restore futures trading?" : "Kill futures trading?"}</h2>
              </div>
              <p className="text-xs text-muted-foreground">
                {isDisabled ? (
                  <>Sets <code className="bg-muted px-1 rounded text-[11px]">trading_mode_futures = paper</code>. Engine resumes paper trading within ~30s. Re-flipping to LIVE requires a separate password-gated action from Agent Hub.</>
                ) : (
                  <>Sets <code className="bg-muted px-1 rounded text-[11px]">trading_mode_futures = disabled</code>. Engine stops firing new trades within ~30s. <strong>Open positions are NOT closed</strong> — use broker app. Live: {futuresLive ? "ON (real money exposed)" : "off (paper)"}.</>
                )}
              </p>
              <input
                type="password"
                placeholder="Password"
                value={pwd}
                onChange={(e) => setPwd(e.target.value)}
                className="w-full px-3 py-2 rounded border border-border bg-background text-sm"
                autoFocus
              />
              {err && <div className="text-xs text-red-400">{err}</div>}
              <div className="flex gap-2 pt-1">
                {isDisabled ? (
                  <button
                    onClick={() => execute("restore")}
                    disabled={busy || !pwd}
                    className="flex-1 inline-flex items-center justify-center gap-1.5 text-sm font-semibold px-3 py-2 rounded-md border border-amber-500/40 bg-amber-500/15 text-amber-300 hover:bg-amber-500/25 disabled:opacity-50"
                  >
                    Restore to PAPER
                  </button>
                ) : (
                  <button
                    onClick={() => execute("kill")}
                    disabled={busy || !pwd}
                    className="flex-1 inline-flex items-center justify-center gap-1.5 text-sm font-semibold px-3 py-2 rounded-md border border-red-500/40 bg-red-500/15 text-red-300 hover:bg-red-500/25 disabled:opacity-50"
                  >
                    <Skull className="w-4 h-4" />
                    Kill trading
                  </button>
                )}
                <button onClick={() => setOpen(false)} className="px-3 py-2 text-sm rounded-md border border-border hover:bg-muted/30">Cancel</button>
              </div>
            </CardContent>
          </Card>
        </div>
      )}
    </>
  );
}

function RiskBar({ usedPct, label }: { usedPct: number; label: string }) {
  const pct = Math.max(0, Math.min(100, usedPct));
  const color = pct > 80 ? "bg-red-500" : pct > 50 ? "bg-amber-500" : "bg-emerald-500";
  return (
    <div>
      <div className="flex items-center justify-between text-[9px] uppercase tracking-wider text-muted-foreground/60 mb-0.5">
        <span>{label}</span>
        <span className="tabular-nums">{pct.toFixed(0)}%</span>
      </div>
      <div className="h-1 w-full bg-muted/40 rounded-full overflow-hidden">
        <div className={`h-full ${color} transition-all`} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

export function AccountsPanel() {
  const { data, isLoading } = useSWR<AccountsResponse>("/api/admin/accounts", fetcher, { refreshInterval: 15_000 });

  if (isLoading) {
    return <Card><CardContent className="py-3 text-xs text-muted-foreground">Loading accounts…</CardContent></Card>;
  }
  if (!data) return null;

  const liveActivated = data.summary.futuresLiveActivated;
  const futuresAccount = data.accounts.find((a) => a.key === "live-futures");
  const currentTradingMode = futuresAccount?.tradingMode ?? "paper";

  return (
    <div className="space-y-2">
      {/* Master live indicator + kill switch */}
      <Card className={liveActivated ? "border-red-500/40 bg-red-500/[0.04]" : currentTradingMode === "disabled" ? "border-amber-500/30 bg-amber-500/[0.04]" : "border-emerald-500/30 bg-emerald-500/[0.03]"}>
        <CardContent className="py-2.5">
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <div className="flex items-center gap-2">
              {liveActivated ? <AlertTriangle className="w-4 h-4 text-red-400" /> : currentTradingMode === "disabled" ? <ShieldOff className="w-4 h-4 text-amber-400" /> : <ShieldCheck className="w-4 h-4 text-emerald-400" />}
              <div>
                <div className={`text-xs font-bold ${liveActivated ? "text-red-300" : currentTradingMode === "disabled" ? "text-amber-300" : "text-emerald-300"}`}>
                  {liveActivated ? "LIVE TRADING ACTIVATED" : currentTradingMode === "disabled" ? "TRADING DISABLED" : "All trading in paper/demo mode"}
                </div>
                <div className="text-[10px] text-muted-foreground/70 mt-0.5">
                  {liveActivated ? "Real money at risk — futures engine fires live trades to Tradovate live account." :
                   currentTradingMode === "disabled" ? "Engine will not fire any trades until restored." :
                   "Engines run trades to paper/demo accounts only."}
                </div>
              </div>
            </div>
            <KillSwitchButton futuresLive={liveActivated} currentMode={currentTradingMode} />
          </div>
        </CardContent>
      </Card>

      {/* Broker-grouped — each broker is a SEPARATE, isolated money pool (can't affect each other) */}
      {(() => {
        const renderCard = (acc: AccountInfo) => {
          const isLive = acc.liveTradingActivated;
          const todayUp = acc.todayPnl >= 0;
          return (
            <Card key={acc.key} className={isLive ? "border-red-500/30" : ""}>
              <CardContent className="py-2.5 px-3 space-y-2">
                <div className="flex items-center justify-between gap-1">
                  <div className="text-[11px] font-semibold truncate flex items-center gap-1">
                    {acc.label}
                    {acc.balanceSource === "broker_live" ? <Wifi className="w-2.5 h-2.5 text-emerald-400" /> : acc.balanceSource === "daily_cache" ? <WifiOff className="w-2.5 h-2.5 text-amber-400/60" /> : null}
                  </div>
                  {brokerBadge(acc.broker)}
                </div>
                <div>
                  <div className="text-base font-bold tabular-nums leading-tight">
                    {acc.balance !== null ? `$${acc.balance.toLocaleString(undefined, { maximumFractionDigits: 0 })}` : <span className="text-muted-foreground/40 text-sm">—</span>}
                  </div>
                  <div className="text-[10px] text-muted-foreground/50">
                    {acc.balanceSource === "broker_live" ? "live broker" : acc.balanceSource === "daily_cache" ? "cached EOD" : "no data"}
                  </div>
                </div>
                <div className="flex items-center justify-between gap-1.5">
                  <div>
                    <div className="text-[9px] uppercase tracking-wider text-muted-foreground/60">Today P&L</div>
                    <div className={`text-xs font-semibold tabular-nums ${todayUp ? "text-emerald-400" : "text-red-400"}`}>
                      {fmtMoney(acc.todayPnl)} {acc.todayTrades > 0 && <span className="text-muted-foreground/50 font-normal">· {acc.todayTrades}t</span>}
                    </div>
                  </div>
                  {acc.pnlSparkline.length > 1 && <Sparkline data={acc.pnlSparkline} width={56} height={20} />}
                </div>
                {acc.balance !== null && acc.dailyLossLimitPct > 0 && (
                  <RiskBar usedPct={acc.riskUsedPct} label={`Daily risk (${acc.dailyLossLimitPct.toFixed(0)}%)`} />
                )}
                <div className="flex items-center gap-1 pt-1 border-t border-border/40">
                  {modeBadge(acc.tradingMode)}
                  {acc.drawdownPct !== 0 && (
                    <span className={`text-[10px] tabular-nums ${acc.drawdownPct >= 0 ? "text-emerald-400" : "text-red-400"}`}>
                      {acc.drawdownPct >= 0 ? "+" : ""}{acc.drawdownPct.toFixed(1)}% session
                    </span>
                  )}
                </div>
              </CardContent>
            </Card>
          );
        };
        // Each broker = its own walled-off account/money. Honest edge note per broker.
        const BROKERS: { key: string; title: string; note: string }[] = [
          { key: "Tradovate", title: "Tradovate · Futures", note: "Gold (MGC/GC) — the one edge that survived every test (thin, real)" },
          { key: "Alpaca", title: "Alpaca · Options & Long-term", note: "Long-term S&P / quality stocks = genuinely sound · options = skill-building" },
        ];
        return (
          <div className="space-y-3">
            {BROKERS.map((b) => {
              const accts = data.accounts.filter((a) => a.broker === b.key);
              if (!accts.length) return null;
              return (
                <div key={b.key}>
                  <div className="flex items-baseline gap-2 mb-1.5 px-0.5">
                    <span className="text-xs font-bold tracking-wide">{b.title}</span>
                    <span className="text-[10px] text-muted-foreground/55 truncate">{b.note}</span>
                  </div>
                  <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-2">{accts.map(renderCard)}</div>
                </div>
              );
            })}
            {/* Kraken — planned, not yet integrated */}
            <div>
              <div className="flex items-baseline gap-2 mb-1.5 px-0.5">
                <span className="text-xs font-bold tracking-wide text-muted-foreground/70">Kraken · Crypto</span>
                <span className="text-[10px] text-muted-foreground/55">day-trade — not wired up yet (backtested no edge; build when ready)</span>
              </div>
              <Card className="border-dashed border-border/50">
                <CardContent className="py-3 text-[11px] text-muted-foreground/45">Coming soon — Kraken crypto integration isn&apos;t built. Separate account, won&apos;t touch futures or Alpaca.</CardContent>
              </Card>
            </div>
          </div>
        );
      })()}
    </div>
  );
}
