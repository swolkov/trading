"use client";

import { Suspense, useState, useEffect, useCallback, useRef } from "react";
import { useSearchParams } from "next/navigation";
import { SymbolSearch } from "@/components/trading/symbol-search";
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
  greeks?: { delta: number; gamma: number; theta: number; vega: number };
  impliedVolatility?: number;
}

interface VolData {
  ivRank: number;
  currentIV: number | null;
  historicalVolatility20: number;
  ivVsHv: string;
  recommendation: string;
}

function IVRankGauge({ rank }: { rank: number }) {
  const color =
    rank < 25 ? "#10b981" : rank < 50 ? "#34d399" : rank < 75 ? "#f59e0b" : "#ef4444";
  const label =
    rank < 25 ? "CHEAP" : rank < 50 ? "FAIR" : rank < 75 ? "PRICEY" : "EXPENSIVE";
  const rotation = (rank / 100) * 180 - 90;

  return (
    <div className="flex flex-col items-center">
      <div className="relative w-32 h-16 overflow-hidden">
        <svg viewBox="0 0 120 60" className="w-full">
          <defs>
            <linearGradient id="gauge-bg" x1="0" y1="0" x2="1" y2="0">
              <stop offset="0%" stopColor="#10b981" />
              <stop offset="50%" stopColor="#f59e0b" />
              <stop offset="100%" stopColor="#ef4444" />
            </linearGradient>
          </defs>
          <path d="M 10 55 A 50 50 0 0 1 110 55" fill="none" stroke="url(#gauge-bg)" strokeWidth="6" strokeLinecap="round" opacity="0.3" />
          <path d="M 10 55 A 50 50 0 0 1 110 55" fill="none" stroke="url(#gauge-bg)" strokeWidth="6" strokeLinecap="round"
            strokeDasharray={`${(rank / 100) * 157} 157`} />
          <line x1="60" y1="55" x2="60" y2="15" stroke={color} strokeWidth="2" strokeLinecap="round"
            transform={`rotate(${rotation}, 60, 55)`} />
          <circle cx="60" cy="55" r="4" fill={color} />
        </svg>
      </div>
      <div className="text-center -mt-1">
        <span className="text-2xl font-bold" style={{ color }}>{rank}</span>
        <span className="text-xs text-muted-foreground">/100</span>
      </div>
      <span className="text-[10px] font-bold tracking-widest" style={{ color }}>{label}</span>
    </div>
  );
}

interface LastRun { ts: string; opened: number; managed: string[]; halted: boolean; haltReasons: string[]; details: string[]; }
interface VetoDecision { ts: string; sym: string; direction: string | null; conviction: string; agree: boolean; ivRank: number; maxRisk: number; reason: string; }
interface AgentStatus {
  enabled: boolean;
  mode: "paper" | "live";
  lastRun: LastRun | null;
  config: Record<string, string>;
  scoreboard: { closed: number; wins: number; winRate: number; avgR: number; totalPnl: number; openGroups: number };
  decisions?: VetoDecision[];
}

// Read-only status for the automated options agent (buy-only defined-risk debit spreads, 7-14 DTE).
// Honest scoreboard — shows real expectancy and warns to stop if it's bleeding.
function OptionsAgentPanel() {
  const [s, setS] = useState<AgentStatus | null>(null);
  useEffect(() => {
    fetch("/api/options-agent").then((r) => r.json()).then((d) => { if (!d.error) setS(d); }).catch(() => {});
  }, []);
  if (!s) return null;
  const sb = s.scoreboard || { closed: 0, wins: 0, winRate: 0, avgR: 0, totalPnl: 0, openGroups: 0 };
  const negative = sb.closed >= 20 && sb.avgR < 0;
  const maxRisk = s.config?.options_max_risk_usd || "50";
  return (
    <div className="rounded-xl border border-border bg-card p-4 space-y-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="text-sm font-semibold">Auto Options Agent</span>
          <span className={`text-[9px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded ${s.enabled ? (s.mode === "live" ? "bg-red-500/15 text-red-400" : "bg-emerald-500/15 text-emerald-400") : "bg-muted text-muted-foreground/60"}`}>
            {s.enabled ? `${s.mode} · ON` : "OFF"}
          </span>
        </div>
        <span className="text-[10px] text-muted-foreground/50">Buy-only debit spreads · 7-14 DTE · max ${maxRisk}/trade</span>
      </div>
      <div className="grid grid-cols-5 gap-3 text-center">
        <div><p className="text-[10px] text-muted-foreground/50">Open</p><p className="text-sm font-bold tabular-nums">{sb.openGroups}</p></div>
        <div><p className="text-[10px] text-muted-foreground/50">Closed</p><p className="text-sm font-bold tabular-nums">{sb.closed}</p></div>
        <div><p className="text-[10px] text-muted-foreground/50">Win rate</p><p className="text-sm font-bold tabular-nums">{sb.closed ? `${(sb.winRate * 100).toFixed(0)}%` : "—"}</p></div>
        <div><p className="text-[10px] text-muted-foreground/50">Avg R</p><p className={`text-sm font-bold tabular-nums ${sb.avgR >= 0 ? "text-emerald-400" : "text-red-400"}`}>{sb.closed ? sb.avgR.toFixed(2) : "—"}</p></div>
        <div><p className="text-[10px] text-muted-foreground/50">Total P&L</p><p className={`text-sm font-bold tabular-nums ${sb.totalPnl >= 0 ? "text-emerald-400" : "text-red-400"}`}>{sb.closed ? `$${sb.totalPnl.toFixed(0)}` : "—"}</p></div>
      </div>
      {negative && (
        <div className="rounded-md border border-red-500/30 bg-red-500/[0.06] px-3 py-2 text-[11px] text-red-300">
          ⚠️ Negative expectancy after {sb.closed} trades. Buying options is −EV by nature — consider turning this off (set <code className="bg-muted px-1 rounded">options_enabled=off</code>).
        </div>
      )}
      {!s.enabled && (
        <p className="text-[11px] text-muted-foreground/50">Disabled. Honest note: buying options is negative-expected-value; this agent uses tiny defined-risk size + hard loss caps to limit damage, not to promise profit.</p>
      )}
      {s.lastRun && (
        <div className="rounded-md border border-border/50 bg-white/[0.01] px-3 py-2 space-y-1">
          <p className="text-[10px] text-muted-foreground/50">
            Last run {new Date(s.lastRun.ts).toLocaleTimeString()} · opened {s.lastRun.opened} · {s.lastRun.managed?.length || 0} managed
            {s.lastRun.halted && <span className="text-amber-400"> · HALTED: {s.lastRun.haltReasons?.join(", ")}</span>}
          </p>
          {(s.lastRun.details || []).map((d, i) => (
            <p key={i} className="text-[10px] text-muted-foreground/45 truncate">· {d}</p>
          ))}
        </div>
      )}
      {/* AI veto activity — every candidate the grader judged, kills included */}
      <div className="rounded-md border border-border/50 bg-white/[0.01] px-3 py-2 space-y-1">
        <p className="text-[10px] font-semibold text-muted-foreground/60 uppercase tracking-wider">AI Veto Activity (Fable 5)</p>
        {(s.decisions?.length || 0) === 0 ? (
          <p className="text-[10px] text-muted-foreground/45">No candidates have reached the AI veto yet — most get filtered earlier by signal strength or the IV gate. When one does, the verdict shows here.</p>
        ) : (
          (s.decisions || []).slice(0, 8).map((d, i) => (
            <div key={`${d.ts}-${i}`} className="flex items-center gap-2 text-[10px]">
              <span className={`shrink-0 font-bold px-1.5 py-0.5 rounded border text-[8px] uppercase tracking-wider ${d.agree ? "bg-emerald-500/15 text-emerald-400 border-emerald-500/30" : "bg-red-500/15 text-red-400 border-red-500/30"}`}>
                {d.agree ? `${d.conviction} OPEN` : `${d.conviction} KILLED`}
              </span>
              <span className="font-semibold shrink-0">{d.sym} {d.direction || ""}</span>
              <span className="text-muted-foreground/45 truncate" title={d.reason}>{d.reason}</span>
              <span className="ml-auto shrink-0 text-muted-foreground/35 tabular-nums">{new Date(d.ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

function OptionsPageInner() {
  const searchParams = useSearchParams();
  const [symbol, setSymbol] = useState(searchParams.get("symbol") || "");
  const [quote, setQuote] = useState<{ bp: number; ap: number } | null>(null);
  const [expirations, setExpirations] = useState<string[]>([]);
  const [selectedExp, setSelectedExp] = useState("");
  const [contracts, setContracts] = useState<OptionsContract[]>([]);
  const [snapshots, setSnapshots] = useState<Record<string, OptionsSnapshot>>({});
  const [volData, setVolData] = useState<VolData | null>(null);
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState<OptionsContract | null>(null);
  const [qty, setQty] = useState(1);
  const [side, setSide] = useState<"buy" | "sell">("buy");
  const [ordering, setOrdering] = useState(false);
  const [orderResult, setOrderResult] = useState<{ success?: boolean; error?: string } | null>(null);
  const [liveAccount, setLiveAccount] = useState<{ balance: number | null; todayPnl: number } | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  const loadExpirations = useCallback(async (sym: string) => {
    const res = await fetch(`/api/options/${sym}?expirations=true`);
    const data = await res.json();
    setExpirations(data.expirations || []);
    if (data.expirations?.length > 0) setSelectedExp(data.expirations[0]);
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
    if (!symbol) return;
    loadExpirations(symbol);
    fetch(`/api/quotes/${symbol}`).then((r) => r.json()).then(setQuote).catch(() => {});
    fetch(`/api/options-intel?action=volatility&symbol=${symbol}`).then((r) => r.json()).then((d) => { if (!d.error) setVolData(d); }).catch(() => {});
  }, [symbol, loadExpirations]);

  useEffect(() => {
    if (symbol && selectedExp) loadChain(symbol, selectedExp);
  }, [symbol, selectedExp, loadChain]);

  // Live Alpaca account context. /api/admin/accounts is the only source that
  // forces getAccount("live") (the $500 real account) regardless of view-mode.
  useEffect(() => {
    fetch("/api/admin/accounts")
      .then((r) => r.json())
      .then((d) => {
        const a = (d.accounts || []).find((x: { key: string }) => x.key === "alpaca-live");
        if (a) setLiveAccount({ balance: a.balance, todayPnl: a.todayPnl ?? 0 });
      })
      .catch(() => {});
  }, []);

  const calls = contracts.filter((c) => c.type === "call").sort((a, b) => parseFloat(a.strike_price) - parseFloat(b.strike_price));
  const puts = contracts.filter((c) => c.type === "put").sort((a, b) => parseFloat(a.strike_price) - parseFloat(b.strike_price));
  const midPrice = quote ? (quote.bp + quote.ap) / 2 : 0;
  const selectedSnap = selected ? snapshots[selected.symbol] : null;
  const selectedMid = selectedSnap?.latestQuote ? (selectedSnap.latestQuote.ap + selectedSnap.latestQuote.bp) / 2 : selectedSnap?.latestTrade?.p || 0;
  const totalCost = selectedMid * 100 * qty;
  // Affordability guard — applies to debit (buy) orders only. Sells collect a
  // credit, so they're never blocked here. buyingPower is the live account's
  // real broker balance (a conservative proxy for this cash account).
  const buyingPower = liveAccount?.balance ?? null;
  const insufficientFunds =
    side === "buy" && buyingPower != null && totalCost > buyingPower;

  async function placeOrder() {
    if (!selected || insufficientFunds) return;
    setOrdering(true);
    setOrderResult(null);
    try {
      const res = await fetch("/api/orders", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // mode: "live" forces this manual order to the real Alpaca account.
        body: JSON.stringify({ symbol: selected.symbol, qty: String(qty), side, type: "market", time_in_force: "day", mode: "live" }),
      });
      const data = await res.json();
      if (data.error) setOrderResult({ error: data.error });
      else setOrderResult({ success: true });
    } catch (err) {
      setOrderResult({ error: err instanceof Error ? err.message : "Failed" });
    }
    setOrdering(false);
  }

  // Build strike rows matching calls to puts by strike
  const allStrikes = [...new Set([...calls.map((c) => c.strike_price), ...puts.map((c) => c.strike_price)])].sort((a, b) => parseFloat(a) - parseFloat(b));

  return (
    <div className="space-y-4 animate-fade-up">
      {/* Page title + live account context */}
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-bold tracking-tight">Options</h1>
          <p className="text-[11px] text-muted-foreground/50">Alpaca options chain — search, analyze, and trade</p>
        </div>
        <div className="flex items-center gap-4 rounded-xl border border-emerald-500/20 bg-emerald-500/[0.04] px-4 py-2">
          <span className="px-2 py-0.5 rounded-full text-[10px] font-bold tracking-widest bg-emerald-500/20 text-emerald-400 ring-1 ring-emerald-500/40">
            LIVE
          </span>
          <div className="text-right">
            <p className="text-[10px] text-muted-foreground uppercase tracking-wider">Cash / Buying Power</p>
            <p className="text-sm font-bold">
              {liveAccount?.balance != null ? formatCurrency(liveAccount.balance) : "—"}
            </p>
          </div>
          <div className="text-right">
            <p className="text-[10px] text-muted-foreground uppercase tracking-wider">Today P&amp;L</p>
            <p className={`text-sm font-bold ${
              liveAccount && liveAccount.todayPnl < 0 ? "text-red-400" : liveAccount && liveAccount.todayPnl > 0 ? "text-emerald-400" : ""
            }`}>
              {liveAccount ? `${liveAccount.todayPnl >= 0 ? "+" : ""}${formatCurrency(liveAccount.todayPnl)}` : "—"}
            </p>
          </div>
        </div>
      </div>

      <OptionsAgentPanel />

      {/* Header: Search + Price + IV Rank */}
      <div className="flex items-start gap-6">
        <div className="flex-1">
          <div className="flex items-center gap-4">
            <div className="w-64">
              <SymbolSearch onSelect={(s) => { setSymbol(s); setSelected(null); setOrderResult(null); }} value={symbol} />
            </div>
            {symbol && midPrice > 0 && (
              <div className="flex items-baseline gap-3">
                <span className="text-3xl font-bold tracking-tight">{symbol}</span>
                <span className="text-2xl font-semibold">{formatCurrency(midPrice)}</span>
              </div>
            )}
          </div>
          {volData && (
            <p className="text-xs text-muted-foreground mt-1 max-w-xl">{volData.recommendation}</p>
          )}
        </div>
        {volData && (
          <div className="shrink-0 rounded-xl border border-white/5 bg-white/[0.02] backdrop-blur p-3">
            <p className="text-[10px] text-center text-muted-foreground font-medium tracking-wider mb-1">IV RANK <span className="opacity-50 normal-case">(est.)</span></p>
            <IVRankGauge rank={volData.ivRank} />
          </div>
        )}
      </div>

      {/* Expiration pills */}
      {expirations.length > 0 && (
        <div className="flex gap-1.5 overflow-x-auto pb-1" ref={scrollRef}>
          {expirations.map((exp) => {
            const d = new Date(exp + "T12:00:00");
            const dte = Math.ceil((d.getTime() - Date.now()) / (1000 * 60 * 60 * 24));
            const isSelected = exp === selectedExp;
            return (
              <button
                key={exp}
                onClick={() => { setSelectedExp(exp); setSelected(null); }}
                className={`shrink-0 px-3 py-1.5 rounded-full text-xs font-medium transition-all ${
                  isSelected
                    ? "bg-emerald-500/20 text-emerald-400 ring-1 ring-emerald-500/40"
                    : "bg-white/[0.04] text-muted-foreground hover:bg-white/[0.08]"
                }`}
              >
                {d.toLocaleDateString("en-US", { month: "short", day: "numeric" })}
                <span className="ml-1 opacity-60">{dte}d</span>
              </button>
            );
          })}
        </div>
      )}

      {/* Options Chain Grid */}
      {loading ? (
        <div className="text-center py-12 text-muted-foreground">Loading options chain...</div>
      ) : allStrikes.length > 0 ? (
        <div className="rounded-xl border border-white/5 overflow-hidden bg-white/[0.01]">
          {/* Header */}
          <div className="grid grid-cols-[1fr_auto_1fr] text-[10px] font-bold tracking-wider text-muted-foreground uppercase">
            <div className="grid grid-cols-5 gap-0 px-3 py-2 bg-emerald-500/5 border-b border-white/5">
              <span>Bid</span><span>Ask</span><span>IV</span><span>Delta</span><span>OI</span>
            </div>
            <div className="px-4 py-2 text-center border-b border-white/5 bg-white/[0.03] font-bold">Strike</div>
            <div className="grid grid-cols-5 gap-0 px-3 py-2 bg-red-500/5 border-b border-white/5 text-right">
              <span>Bid</span><span>Ask</span><span>IV</span><span>Delta</span><span>OI</span>
            </div>
          </div>

          {/* Rows */}
          <div className="max-h-[420px] overflow-y-auto">
            {allStrikes.map((strike) => {
              const strikeNum = parseFloat(strike);
              const isATM = midPrice > 0 && Math.abs(strikeNum - midPrice) / midPrice < 0.01;
              const isITMCall = strikeNum < midPrice;
              const isITMPut = strikeNum > midPrice;

              const call = calls.find((c) => c.strike_price === strike);
              const put = puts.find((c) => c.strike_price === strike);
              const callSnap = call ? snapshots[call.symbol] : null;
              const putSnap = put ? snapshots[put.symbol] : null;

              const isCallSelected = selected?.symbol === call?.symbol;
              const isPutSelected = selected?.symbol === put?.symbol;

              return (
                <div
                  key={strike}
                  className={`grid grid-cols-[1fr_auto_1fr] text-xs ${
                    isATM ? "bg-white/[0.06] border-y border-emerald-500/30" : "border-b border-white/[0.03]"
                  }`}
                >
                  {/* Call side */}
                  <button
                    className={`grid grid-cols-5 gap-0 px-3 py-2 text-left transition-colors ${
                      isCallSelected
                        ? "bg-emerald-500/15 ring-1 ring-inset ring-emerald-500/30"
                        : isITMCall
                        ? "bg-emerald-500/[0.03] hover:bg-emerald-500/10"
                        : "hover:bg-white/[0.04]"
                    } ${call ? "cursor-pointer" : "opacity-30 cursor-default"}`}
                    onClick={() => call && setSelected(call)}
                    disabled={!call}
                  >
                    <span>{callSnap?.latestQuote?.bp?.toFixed(2) || "-"}</span>
                    <span>{callSnap?.latestQuote?.ap?.toFixed(2) || "-"}</span>
                    <span className="text-muted-foreground">{callSnap?.impliedVolatility ? `${(callSnap.impliedVolatility * 100).toFixed(0)}%` : "-"}</span>
                    <span className="text-emerald-400">{callSnap?.greeks?.delta?.toFixed(2) || "-"}</span>
                    <span className="text-muted-foreground">{call?.open_interest || "-"}</span>
                  </button>

                  {/* Strike center */}
                  <div className={`px-4 py-2 text-center font-bold min-w-[80px] ${
                    isATM ? "text-emerald-400 bg-white/[0.04]" : "bg-white/[0.02]"
                  }`}>
                    {strikeNum.toFixed(2)}
                    {isATM && <span className="block text-[9px] text-emerald-400/60 font-normal">ATM</span>}
                  </div>

                  {/* Put side */}
                  <button
                    className={`grid grid-cols-5 gap-0 px-3 py-2 text-right transition-colors ${
                      isPutSelected
                        ? "bg-red-500/15 ring-1 ring-inset ring-red-500/30"
                        : isITMPut
                        ? "bg-red-500/[0.03] hover:bg-red-500/10"
                        : "hover:bg-white/[0.04]"
                    } ${put ? "cursor-pointer" : "opacity-30 cursor-default"}`}
                    onClick={() => put && setSelected(put)}
                    disabled={!put}
                  >
                    <span>{putSnap?.latestQuote?.bp?.toFixed(2) || "-"}</span>
                    <span>{putSnap?.latestQuote?.ap?.toFixed(2) || "-"}</span>
                    <span className="text-muted-foreground">{putSnap?.impliedVolatility ? `${(putSnap.impliedVolatility * 100).toFixed(0)}%` : "-"}</span>
                    <span className="text-red-400">{putSnap?.greeks?.delta?.toFixed(2) || "-"}</span>
                    <span className="text-muted-foreground">{put?.open_interest || "-"}</span>
                  </button>
                </div>
              );
            })}
          </div>
        </div>
      ) : symbol ? (
        <div className="text-center py-12 text-muted-foreground">No options available for {symbol}</div>
      ) : (
        <div className="text-center py-20">
          <p className="text-lg text-muted-foreground">Search for a symbol to view options</p>
          <p className="text-xs text-muted-foreground mt-1">Try AAPL, TSLA, NVDA, SPY</p>
        </div>
      )}

      {/* Order Panel — slides up when contract selected */}
      {selected && (
        <div className="fixed bottom-0 left-0 right-0 z-50 animate-in slide-in-from-bottom duration-300">
          <div className="max-w-5xl mx-auto px-4 pb-4">
            <div className="rounded-2xl border border-white/10 bg-card/95 backdrop-blur-xl shadow-2xl p-5">
              {/* Strategy selector */}
              <div className="flex items-center justify-between mb-4">
                <div className="flex gap-1.5">
                  {[
                    { key: "buy", label: "Buy", desc: "Pay premium" },
                    { key: "sell", label: "Sell", desc: "Collect premium" },
                  ].map((s) => (
                    <button
                      key={s.key}
                      onClick={() => setSide(s.key as "buy" | "sell")}
                      className={`px-4 py-2 rounded-lg text-sm font-medium transition-all ${
                        side === s.key
                          ? side === "buy"
                            ? "bg-emerald-500/20 text-emerald-400 ring-1 ring-emerald-500/40"
                            : "bg-amber-500/20 text-amber-400 ring-1 ring-amber-500/40"
                          : "bg-white/[0.04] text-muted-foreground hover:bg-white/[0.08]"
                      }`}
                    >
                      {s.label} <span className="text-[10px] opacity-60 ml-1">{s.desc}</span>
                    </button>
                  ))}
                </div>
                <button onClick={() => { setSelected(null); setOrderResult(null); }} className="text-muted-foreground hover:text-foreground text-xl leading-none">&times;</button>
              </div>

              {/* Contract info */}
              <div className="flex items-center gap-2 mb-3">
                <span className={`text-lg font-bold ${
                  side === "buy"
                    ? selected.type === "call" ? "text-emerald-400" : "text-red-400"
                    : "text-amber-400"
                }`}>
                  {side === "buy" ? "BUY" : "SELL"} {selected.type === "call" ? "CALL" : "PUT"}
                </span>
                <span className="text-sm text-muted-foreground">{symbol}</span>
                <span className="text-sm">${parseFloat(selected.strike_price).toFixed(2)} strike</span>
                <span className="text-xs text-muted-foreground">exp {selected.expiration_date}</span>
                {selectedSnap?.greeks && (
                  <span className="text-xs text-muted-foreground">&Delta;{selectedSnap.greeks.delta.toFixed(3)} &Theta;{selectedSnap.greeks.theta.toFixed(4)}</span>
                )}
                {selectedSnap?.impliedVolatility && (
                  <span className="text-xs text-muted-foreground">IV {(selectedSnap.impliedVolatility * 100).toFixed(0)}%</span>
                )}
              </div>

              <div className="grid grid-cols-5 gap-4 mb-4">
                <div>
                  <label className="text-[10px] text-muted-foreground uppercase tracking-wider">Contracts</label>
                  <div className="flex items-center gap-2 mt-1">
                    <button onClick={() => setQty(Math.max(1, qty - 1))} className="w-8 h-8 rounded-lg bg-white/5 hover:bg-white/10 flex items-center justify-center font-bold">-</button>
                    <span className="text-2xl font-bold w-10 text-center">{qty}</span>
                    <button onClick={() => setQty(Math.min(20, qty + 1))} className="w-8 h-8 rounded-lg bg-white/5 hover:bg-white/10 flex items-center justify-center font-bold">+</button>
                  </div>
                </div>
                <div>
                  <label className="text-[10px] text-muted-foreground uppercase tracking-wider">Premium</label>
                  <p className="text-xl font-bold mt-1">${selectedMid.toFixed(2)}</p>
                  <p className="text-[10px] text-muted-foreground">per share</p>
                </div>
                <div>
                  <label className="text-[10px] text-muted-foreground uppercase tracking-wider">
                    {side === "buy" ? "Total Cost" : "Credit Received"}
                  </label>
                  <p className={`text-xl font-bold mt-1 ${side === "sell" ? "text-emerald-400" : ""}`}>
                    {side === "sell" ? "+" : ""}{formatCurrency(totalCost)}
                  </p>
                  <p className="text-[10px] text-muted-foreground">{side === "buy" ? "max risk" : "max profit"}</p>
                </div>
                <div>
                  <label className="text-[10px] text-muted-foreground uppercase tracking-wider">Breakeven</label>
                  <p className="text-xl font-bold mt-1">
                    {formatCurrency(
                      selected.type === "call"
                        ? parseFloat(selected.strike_price) + (side === "buy" ? selectedMid : -selectedMid)
                        : parseFloat(selected.strike_price) - (side === "buy" ? selectedMid : -selectedMid)
                    )}
                  </p>
                  <p className="text-[10px] text-muted-foreground">at expiry</p>
                </div>
                <div>
                  <label className="text-[10px] text-muted-foreground uppercase tracking-wider">
                    {side === "buy" ? "Max Loss" : "Max Risk"}
                  </label>
                  <p className="text-xl font-bold mt-1 text-red-400">
                    {side === "buy"
                      ? formatCurrency(totalCost)
                      : side === "sell" && selected.type === "put"
                      ? formatCurrency(parseFloat(selected.strike_price) * 100 * qty - totalCost)
                      : "Unlimited"}
                  </p>
                  <p className="text-[10px] text-muted-foreground">
                    {side === "sell" && selected.type === "call" ? "naked call = unlimited risk!" : ""}
                  </p>
                </div>
              </div>

              {/* P&L preview — payoffs AT EXPIRATION, not an immediate move */}
              <div className="mb-4">
                <p className="text-[10px] text-muted-foreground uppercase tracking-wider mb-1.5">
                  Est. value at expiration{" "}
                  <span className="normal-case tracking-normal opacity-60">— if held to {selected.expiration_date}, not an immediate move</span>
                </p>
                <div className="grid grid-cols-3 gap-3 text-xs">
                <div className="rounded-lg bg-emerald-500/10 border border-emerald-500/20 p-2 text-center">
                  <p className="text-muted-foreground">If stock +5%</p>
                  <p className={`font-bold ${
                    (side === "buy" && selected.type === "call") || (side === "sell" && selected.type === "put")
                      ? "text-emerald-400" : "text-red-400"
                  }`}>
                    {side === "buy" && selected.type === "call"
                      ? `+${formatCurrency(Math.max(0, (midPrice * 1.05 - parseFloat(selected.strike_price)) * 100 * qty - totalCost))}`
                      : side === "sell" && selected.type === "put"
                      ? `+${formatCurrency(totalCost)}`
                      : side === "sell" && selected.type === "call"
                      ? `-${formatCurrency(Math.max(0, (midPrice * 1.05 - parseFloat(selected.strike_price)) * 100 * qty - totalCost))}`
                      : `-${formatCurrency(totalCost)}`}
                  </p>
                </div>
                <div className="rounded-lg bg-white/5 border border-white/10 p-2 text-center">
                  <p className="text-muted-foreground">If flat</p>
                  <p className={`font-bold ${side === "sell" ? "text-emerald-400" : "text-red-400"}`}>
                    {side === "sell" ? `+${formatCurrency(totalCost)}` : `-${formatCurrency(totalCost)}`}
                  </p>
                </div>
                <div className="rounded-lg bg-red-500/10 border border-red-500/20 p-2 text-center">
                  <p className="text-muted-foreground">If stock -5%</p>
                  <p className={`font-bold ${
                    (side === "buy" && selected.type === "put") || (side === "sell" && selected.type === "call")
                      ? "text-emerald-400" : "text-red-400"
                  }`}>
                    {side === "buy" && selected.type === "put"
                      ? `+${formatCurrency(Math.max(0, (parseFloat(selected.strike_price) - midPrice * 0.95) * 100 * qty - totalCost))}`
                      : side === "sell" && selected.type === "call"
                      ? `+${formatCurrency(totalCost)}`
                      : side === "sell" && selected.type === "put"
                      ? `-${formatCurrency(Math.max(0, (parseFloat(selected.strike_price) - midPrice * 0.95) * 100 * qty - totalCost))}`
                      : `-${formatCurrency(totalCost)}`}
                  </p>
                </div>
                </div>
              </div>

              {/* Warning for selling */}
              {side === "sell" && selected.type === "call" && (
                <div className="rounded-lg bg-red-500/10 border border-red-500/30 p-2 mb-3 text-xs text-red-400 text-center">
                  Selling naked calls has UNLIMITED risk. Only do this as a covered call (if you own 100+ shares of {symbol}).
                </div>
              )}

              {/* Affordability guard */}
              {insufficientFunds && (
                <div className="rounded-lg bg-red-500/10 border border-red-500/30 p-2 mb-3 text-xs text-red-400 text-center">
                  Insufficient funds: this order costs {formatCurrency(totalCost)} but your live buying power is{" "}
                  {buyingPower != null ? formatCurrency(buyingPower) : "—"}. Reduce contracts or pick a cheaper strike.
                </div>
              )}

              <div className="flex gap-3">
                <button
                  onClick={placeOrder}
                  disabled={ordering || insufficientFunds}
                  className={`flex-1 py-3 rounded-xl font-bold text-sm transition-all disabled:opacity-50 ${
                    side === "buy"
                      ? selected.type === "call"
                        ? "bg-emerald-500 hover:bg-emerald-400 text-black"
                        : "bg-red-500 hover:bg-red-400 text-white"
                      : "bg-amber-500 hover:bg-amber-400 text-black"
                  }`}
                >
                  {ordering
                    ? "Placing..."
                    : `${side === "buy" ? "Buy" : "Sell"} ${qty} ${selected.type === "call" ? "Call" : "Put"} ${side === "buy" ? "for" : "credit"} ${formatCurrency(totalCost)}`}
                </button>
              </div>

              {orderResult?.success && (
                <p className="text-emerald-400 text-sm text-center mt-2">Order placed successfully!</p>
              )}
              {orderResult?.error && (
                <p className="text-red-400 text-sm text-center mt-2">Error: {orderResult.error}</p>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default function OptionsPageWrapper() {
  return (
    <Suspense fallback={
      <div className="space-y-5 animate-fade-up p-6">
        <div>
          <div className="skeleton h-6 w-24 rounded mb-2" />
          <div className="skeleton h-3 w-48 rounded" />
        </div>
        <div className="skeleton h-10 w-64 rounded" />
        <div className="skeleton h-64 w-full rounded-xl" />
      </div>
    }>
      <OptionsPageInner />
    </Suspense>
  );
}
