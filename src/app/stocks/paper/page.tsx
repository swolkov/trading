"use client";

import useSWR from "swr";

// ============ STOCK PAPER BOOK ============
// The crypto desk's method, on US stocks: scan 30 liquid marginable names, open PAPER
// longs on high-conviction breakouts, score them on real 1-minute bars with realistic
// costs, and keep the statistical record. Nothing here touches Robinhood — see the
// explainer card. Signals also go to Slack for Spencer to take by hand if he chooses.

const fetcher = (u: string) => fetch(u).then((r) => r.json());

interface Tier { tier: string; resolved: number; wins: number; hitRate: number | null; totalPnl: number }
interface Score {
  resolved: number; wins: number; hitRate: number | null; totalPnl: number; fees: number;
  avgWin: number; avgLoss: number; open: number; openUnrealized: number; byConviction: Tier[];
}
interface Strat {
  key: string; label: string; resolved: number; wins: number; hitRate: number | null; expectancy: number | null;
  totalPnl: number; grossPnl: number; fees: number; open: number; peakedGreen: number; days: number; tStat: number | null; verdict: string;
}
interface Row {
  id: number; time: string; symbol: string; source: string; timeframe: string | null; conviction: string | null;
  entry: number; notional: number; exit: number | null; pnl: number | null; unrealized: number | null;
  fees: number | null; status: string; reason: string | null; stop: number | null; peak: number | null;
}
interface Signal { ts: string; symbol: string; timeframe: string; kind: string; detail: string; price: number }
interface Payload { score: Score | null; strategies: Strat[]; log: Row[]; lastRun: string | null; universe: string[]; signals: Signal[] }

const money = (n: number) => `${n < 0 ? "−" : ""}$${Math.abs(n).toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
const money2 = (n: number) => `${n < 0 ? "−" : "+"}$${Math.abs(n).toFixed(2)}`;
const usd = (n: number) => `$${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const col = (n: number) => (n > 0 ? "text-emerald-400" : n < 0 ? "text-red-400" : "text-muted-foreground");
function verdictCls(v: string): string {
  if (v.startsWith("REAL EDGE")) return "text-emerald-400 font-bold";
  if (v.startsWith("promising")) return "text-amber-400";
  if (v.startsWith("not paying")) return "text-red-400";
  return "text-muted-foreground/50";
}
const ago = (iso: string | null) => {
  if (!iso) return "never";
  const m = (Date.now() - Date.parse(iso)) / 60000;
  return m < 1 ? "just now" : m < 90 ? `${Math.round(m)} min ago` : `${(m / 60).toFixed(1)} h ago`;
};

export default function StockPaperPage() {
  const { data } = useSWR<Payload>("/api/stocks/paper", fetcher, { refreshInterval: 60_000 });
  const score = data?.score ?? null;
  const strategies = data?.strategies ?? [];
  const log = data?.log ?? [];
  const hasAny = !!score && (score.resolved > 0 || score.open > 0);

  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-xl font-bold tracking-tight">Stock Paper Book</h2>
        <p className="text-[11px] text-muted-foreground/50">
          The crypto desk&apos;s method on US stocks: high-conviction breakout longs, scored on real 1-minute bars with slippage and margin interest,
          no money at risk. Scanner last ran <span className="text-foreground/70">{ago(data?.lastRun ?? null)}</span> · runs every 15 min, 9:30–4:00 ET.
        </p>
      </div>

      <div className="rounded-xl border border-border bg-card p-4 space-y-2">
        <p className="text-xs font-bold">Why this is paper, and what it is for</p>
        <p className="text-[11px] text-muted-foreground/70 leading-relaxed">
          Robinhood has margin on your main account, but no official way for software to trade it. Their agent route (Agentic Trading) is a separate
          <span className="text-foreground/80"> cash account, long-only, no margin borrowing yet, no shorting, no paper mode</span>. The unofficial APIs get accounts frozen, so nothing here
          connects to Robinhood at all. This book answers the question that matters first: <span className="text-foreground/80">does the signal that showed promise on crypto work on stocks?</span>
          If it does, the record is ready the day Robinhood enables margin for agents. Until then every signal also goes to Slack — take it by hand in your margin account if you want to; the scoreboard will tell you whether you should.
        </p>
        <p className="text-[11px] text-muted-foreground/70 leading-relaxed">
          Two long-only sleeves, same entry rule (high conviction, not stretched), split by the timeframe that fired: <span className="text-foreground/80">Fast</span> (5m/15m, 2% stop, out by the next close)
          and <span className="text-foreground/80">Swing</span> (1h/1d, 5% stop, up to ~10 sessions). Sizing is risk-based like crypto: 3% of a $5k reference account per trade (6% on high conviction), capped at
          2× equity, which is Robinhood&apos;s overnight margin. Costs: 0.05% chase in, 0.05% slippage out, 5% APR on anything borrowed above equity. No commission.
          Verdict rules are identical to the crypto desk: 30+ resolved, positive net, t≥2, 7+ distinct days before anything is called an edge.
        </p>
        <p className="text-[11px] text-muted-foreground/50">
          Universe ({data?.universe?.length ?? 30}): {data?.universe?.join(", ")}
        </p>
      </div>

      {!hasAny && (
        <div className="rounded-xl border border-border bg-card p-8 text-center">
          <p className="text-sm text-muted-foreground/60">No stock paper trades yet.</p>
          <p className="text-[11px] text-muted-foreground/40 mt-1">Paper opens only on high-conviction breakouts during regular hours. Check back after a session or two.</p>
        </div>
      )}

      {score && hasAny && (
        <div className="rounded-xl border border-sky-500/20 bg-sky-500/[0.03] p-4">
          <div className="flex items-center justify-between mb-2">
            <p className="text-xs font-bold">📊 Paper Record — would these have made money?</p>
            <p className="text-[10px] text-muted-foreground/45">
              {score.open} open{score.open > 0 && <> · floating <span className={`font-bold ${col(score.openUnrealized)}`}>{money2(score.openUnrealized)}</span></>} · no real money
            </p>
          </div>
          <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
            <div><p className="text-[9px] text-muted-foreground/60 uppercase tracking-wider">Resolved</p><p className="text-lg font-black tabular-nums">{score.resolved}</p></div>
            <div><p className="text-[9px] text-muted-foreground/60 uppercase tracking-wider">Hit rate</p><p className={`text-lg font-black tabular-nums ${score.hitRate != null && score.hitRate >= 0.5 ? "text-emerald-400" : "text-amber-400"}`}>{score.hitRate != null ? `${(score.hitRate * 100).toFixed(0)}%` : "—"}</p></div>
            <div><p className="text-[9px] text-muted-foreground/60 uppercase tracking-wider">Net P&amp;L</p><p className={`text-lg font-black tabular-nums ${col(score.totalPnl)}`}>{money(score.totalPnl)}</p></div>
            <div><p className="text-[9px] text-muted-foreground/60 uppercase tracking-wider">Costs</p><p className="text-lg font-black tabular-nums text-red-400/70">{score.fees ? `−$${Math.round(score.fees).toLocaleString()}` : "—"}</p></div>
            <div><p className="text-[9px] text-muted-foreground/60 uppercase tracking-wider">Avg win / loss</p><p className="text-lg font-black tabular-nums"><span className="text-emerald-400">{money(score.avgWin)}</span> <span className="text-muted-foreground/40">/</span> <span className="text-red-400">{money(score.avgLoss)}</span></p></div>
          </div>
          {score.byConviction.length > 0 && (
            <div className="mt-3 pt-3 border-t border-border/50">
              <p className="text-[9px] text-muted-foreground/60 uppercase tracking-wider mb-1.5">By conviction — does confluence predict on stocks too?</p>
              <div className="grid grid-cols-3 gap-2">
                {score.byConviction.map((t) => (
                  <div key={t.tier} className="rounded-lg border border-border/50 px-2.5 py-1.5 text-[11px]">
                    <span className="font-bold capitalize">{t.tier}</span>
                    <span className="text-muted-foreground/50 ml-1">{t.resolved} · {t.hitRate != null ? `${(t.hitRate * 100).toFixed(0)}%` : "—"}</span>
                    <span className={`font-bold ml-1 ${col(t.totalPnl)}`}>{money(t.totalPnl)}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {strategies.some((s) => s.resolved > 0 || s.open > 0) && (
        <div className="rounded-xl border border-border bg-card overflow-hidden">
          <div className="flex items-center justify-between px-4 py-2.5 border-b border-border">
            <p className="text-xs font-bold">🧭 Sleeves — what&apos;s working</p>
            <p className="text-[10px] text-muted-foreground/45">paper · expectancy = avg $/trade after costs</p>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-[11px]">
              <thead>
                <tr className="text-[9px] uppercase tracking-wider text-muted-foreground/50 border-b border-border/50">
                  <th className="text-left font-medium px-4 py-1.5">Sleeve</th>
                  <th className="text-right font-medium px-2 py-1.5">Resolved</th>
                  <th className="text-right font-medium px-2 py-1.5">Open</th>
                  <th className="text-right font-medium px-2 py-1.5">Hit rate</th>
                  <th className="text-right font-medium px-2 py-1.5">Gross</th>
                  <th className="text-right font-medium px-2 py-1.5">Costs</th>
                  <th className="text-right font-medium px-2 py-1.5">Net</th>
                  <th className="text-right font-medium px-2 py-1.5" title="Went green at peak → finished green">Green banked</th>
                  <th className="text-right font-medium px-2 py-1.5">Days</th>
                  <th className="text-right font-medium px-4 py-1.5">Verdict</th>
                </tr>
              </thead>
              <tbody>
                {strategies.map((s) => (
                  <tr key={s.key} className="border-b border-border/30 last:border-0">
                    <td className="text-left px-4 py-2 font-semibold text-foreground/80">{s.label}</td>
                    <td className="text-right px-2 py-2 tabular-nums">{s.resolved}</td>
                    <td className="text-right px-2 py-2 tabular-nums text-muted-foreground/50">{s.open}</td>
                    <td className={`text-right px-2 py-2 tabular-nums font-bold ${s.hitRate != null && s.hitRate >= 0.5 ? "text-emerald-400" : "text-amber-400"}`}>{s.hitRate != null ? `${(s.hitRate * 100).toFixed(0)}%` : "—"}</td>
                    <td className={`text-right px-2 py-2 tabular-nums ${col(s.grossPnl)}`}>{money(s.grossPnl)}</td>
                    <td className="text-right px-2 py-2 tabular-nums text-red-400/70">{s.fees ? `−$${Math.round(s.fees).toLocaleString()}` : "—"}</td>
                    <td className={`text-right px-2 py-2 tabular-nums font-bold ${col(s.totalPnl)}`}>{money(s.totalPnl)}</td>
                    <td className="text-right px-2 py-2 tabular-nums text-muted-foreground/70">{s.resolved > 0 ? `${Math.round((s.peakedGreen / s.resolved) * 100)}% → ${Math.round((s.wins / s.resolved) * 100)}%` : "—"}</td>
                    <td className="text-right px-2 py-2 tabular-nums text-muted-foreground/70">{s.days}</td>
                    <td className={`text-right px-4 py-2 ${verdictCls(s.verdict)}`}>{s.verdict}{s.tStat != null && s.resolved >= 30 ? <span className="text-[9px] font-normal opacity-50 ml-1">t={s.tStat.toFixed(1)}</span> : null}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {log.length > 0 && (
        <div className="rounded-xl border border-border bg-card overflow-hidden">
          <div className="flex items-center justify-between px-4 py-2.5 border-b border-border">
            <p className="text-xs font-bold">📋 Paper log</p>
            <p className="text-[10px] text-muted-foreground/45">newest first · open rows show the live float</p>
          </div>
          <div className="overflow-x-auto max-h-[28rem] overflow-y-auto">
            <table className="w-full text-[11px]">
              <thead className="sticky top-0 bg-card">
                <tr className="text-[9px] uppercase tracking-wider text-muted-foreground/50 border-b border-border/50">
                  <th className="text-left font-medium px-3 py-1.5">Time</th>
                  <th className="text-left font-medium px-2 py-1.5">Sleeve</th>
                  <th className="text-left font-medium px-2 py-1.5">Symbol</th>
                  <th className="text-left font-medium px-2 py-1.5">Conviction</th>
                  <th className="text-right font-medium px-2 py-1.5">Size</th>
                  <th className="text-right font-medium px-2 py-1.5">Entry</th>
                  <th className="text-right font-medium px-2 py-1.5">Stop</th>
                  <th className="text-right font-medium px-2 py-1.5">Exit</th>
                  <th className="text-right font-medium px-2 py-1.5">P&amp;L</th>
                  <th className="text-left font-medium px-3 py-1.5">Outcome</th>
                </tr>
              </thead>
              <tbody>
                {log.map((t) => {
                  const open = t.status !== "resolved";
                  const val = open ? t.unrealized : t.pnl;
                  return (
                    <tr key={t.id} className="border-b border-border/40 hover:bg-white/[0.02]">
                      <td className="px-3 py-1.5 text-muted-foreground/60 tabular-nums whitespace-nowrap">
                        {new Date(t.time).toLocaleDateString(undefined, { month: "short", day: "numeric" })} {new Date(t.time).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}
                      </td>
                      <td className="px-2 py-1.5 text-muted-foreground/70">{t.source.replace("stock-", "")}{t.timeframe ? <span className="text-muted-foreground/40 ml-1">{t.timeframe}</span> : null}</td>
                      <td className="px-2 py-1.5 font-semibold">{t.symbol}</td>
                      <td className="px-2 py-1.5 text-muted-foreground/60 capitalize">{t.conviction ?? "—"}</td>
                      <td className="px-2 py-1.5 text-right tabular-nums text-muted-foreground/70">{money(t.notional)}</td>
                      <td className="px-2 py-1.5 text-right tabular-nums text-muted-foreground/70">{usd(t.entry)}</td>
                      <td className="px-2 py-1.5 text-right tabular-nums text-muted-foreground/50">{t.stop != null ? usd(t.stop) : "—"}</td>
                      <td className="px-2 py-1.5 text-right tabular-nums text-muted-foreground/70">{t.exit != null ? usd(t.exit) : "—"}</td>
                      <td className={`px-2 py-1.5 text-right tabular-nums font-bold ${val != null ? col(val) : "text-muted-foreground/40"}`}>{val != null ? money2(val) : "—"}{open && <span className="text-[9px] font-normal text-muted-foreground/40 ml-1">float</span>}</td>
                      <td className="px-3 py-1.5 text-muted-foreground/60">{open ? "open" : t.reason ?? "resolved"}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {(data?.signals?.length ?? 0) > 0 && (
        <div className="rounded-xl border border-border bg-card overflow-hidden">
          <div className="flex items-center justify-between px-4 py-2.5 border-b border-border">
            <p className="text-xs font-bold">🔎 Scanner — last 24h</p>
            <p className="text-[10px] text-muted-foreground/45">awareness only · not trade advice</p>
          </div>
          <div className="max-h-56 overflow-y-auto divide-y divide-border/40">
            {data!.signals.map((s, i) => {
              const bullish = s.kind === "oversold" || s.kind === "breakout" || s.kind === "move-up";
              const bearish = s.kind === "overbought" || s.kind === "breakdown" || s.kind === "move-down";
              return (
                <div key={i} className="flex items-center gap-3 px-4 py-1.5 text-left">
                  <span className="text-[10px] text-muted-foreground/45 tabular-nums w-16 shrink-0">{new Date(s.ts).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}</span>
                  <span className="font-bold text-[12px] w-14 shrink-0">{s.symbol}</span>
                  <span className="text-[10px] text-muted-foreground/50 w-8 shrink-0">{s.timeframe}</span>
                  <span className={`text-[12px] flex-1 ${bullish ? "text-emerald-400" : bearish ? "text-red-400" : "text-muted-foreground/80"}`}>{s.detail}</span>
                  <span className="text-[10px] text-muted-foreground/40 tabular-nums">${s.price.toLocaleString()}</span>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
