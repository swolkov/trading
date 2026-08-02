"use client";

import useSWR from "swr";

/**
 * EDGE TRUTH panel — which edge is actually making money, and is it proven yet?
 *
 * Reads the CLEAN broker-reconciled ledger (RoundTrip), not autoTradeLog. Leads with the t-stat
 * rather than P&L, because a positive number over 14 trades is not an edge — it is 14 trades.
 */

const fetcher = (u: string) => fetch(u).then((r) => r.json());

interface Row {
  setupType: string; n: number; net: number; pf: number; winRate: number;
  avgPerTrade: number; avgR: number | null; tStat: number;
  tradesForSignificance: number | null; verdict: string;
}
interface Slip { mode: string; symbol: string; n: number; medianPts: number; meanPts: number; maxPts: number; medianCost: number }
interface Resp { live?: { edges: Row[]; overall: Row | null }; paper?: { edges: Row[]; overall: Row | null }; slippage?: Slip[] }

const money = (n: number) => `${n < 0 ? "−" : ""}$${Math.abs(n).toFixed(2)}`;

function verdictClass(v: string) {
  if (v.startsWith("PROVEN")) return "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400";
  if (v.startsWith("promising")) return "bg-amber-500/15 text-amber-600 dark:text-amber-400";
  if (v === "losing") return "bg-red-500/15 text-red-600 dark:text-red-400";
  return "bg-muted text-muted-foreground";
}

function EdgeTable({ title, data }: { title: string; data?: { edges: Row[]; overall: Row | null } }) {
  if (!data || data.edges.length === 0) return null;
  return (
    <div>
      <div className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">{title}</div>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[720px] text-sm">
          <thead>
            <tr className="border-b text-left text-[11px] uppercase tracking-wide text-muted-foreground">
              <th className="py-1.5 pr-3">Edge</th>
              <th className="py-1.5 pr-3 text-right">Trades</th>
              <th className="py-1.5 pr-3 text-right">Net</th>
              <th className="py-1.5 pr-3 text-right">PF</th>
              <th className="py-1.5 pr-3 text-right">Win</th>
              <th className="py-1.5 pr-3 text-right">Avg R</th>
              <th className="py-1.5 pr-3 text-right">t-stat</th>
              <th className="py-1.5">Verdict</th>
            </tr>
          </thead>
          <tbody>
            {data.edges.map((e) => (
              <tr key={e.setupType} className="border-b last:border-0">
                <td className="py-2 pr-3 font-medium">{e.setupType}</td>
                <td className="py-2 pr-3 text-right tabular-nums">{e.n}</td>
                <td className={`py-2 pr-3 text-right tabular-nums ${e.net >= 0 ? "text-emerald-600" : "text-red-600"}`}>{money(e.net)}</td>
                <td className="py-2 pr-3 text-right tabular-nums">{e.pf.toFixed(2)}</td>
                <td className="py-2 pr-3 text-right tabular-nums">{e.winRate}%</td>
                <td className="py-2 pr-3 text-right tabular-nums">{e.avgR != null ? e.avgR.toFixed(2) : "—"}</td>
                <td className="py-2 pr-3 text-right font-semibold tabular-nums">{e.tStat.toFixed(2)}</td>
                <td className="py-2">
                  <span className={`rounded px-1.5 py-0.5 text-[11px] ${verdictClass(e.verdict)}`}>{e.verdict}</span>
                  {e.tradesForSignificance && (
                    <span className="ml-1.5 text-[10px] text-muted-foreground">needs ~{e.tradesForSignificance}</span>
                  )}
                </td>
              </tr>
            ))}
            {data.overall && (
              <tr className="border-t-2 font-semibold">
                <td className="py-2 pr-3">ALL</td>
                <td className="py-2 pr-3 text-right tabular-nums">{data.overall.n}</td>
                <td className={`py-2 pr-3 text-right tabular-nums ${data.overall.net >= 0 ? "text-emerald-600" : "text-red-600"}`}>{money(data.overall.net)}</td>
                <td className="py-2 pr-3 text-right tabular-nums">{data.overall.pf.toFixed(2)}</td>
                <td className="py-2 pr-3 text-right tabular-nums">{data.overall.winRate}%</td>
                <td className="py-2 pr-3 text-right tabular-nums">{data.overall.avgR != null ? data.overall.avgR.toFixed(2) : "—"}</td>
                <td className="py-2 pr-3 text-right tabular-nums">{data.overall.tStat.toFixed(2)}</td>
                <td className="py-2 text-[11px] text-muted-foreground">{data.overall.verdict}</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export default function EdgeTruth() {
  const { data } = useSWR<Resp>("/api/futures/edge-truth", fetcher, { refreshInterval: 60000 });
  if (!data) return <div className="rounded-xl border p-4 text-sm text-muted-foreground">Loading edge truth…</div>;

  return (
    <div className="space-y-5 rounded-xl border bg-card p-4">
      <div>
        <h3 className="text-base font-semibold">Edge Truth</h3>
        <p className="text-xs text-muted-foreground">
          From the broker-reconciled ledger, not the trade log. <strong>Read the t-stat, not the P&amp;L</strong> —
          under 2 it cannot be distinguished from luck, however good the dollars look.
        </p>
      </div>

      <EdgeTable title="Live · real money" data={data.live} />
      <EdgeTable title="Demo · shadow" data={data.paper} />

      {data.slippage && data.slippage.length > 0 && (
        <div>
          <div className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Execution cost — what each fill gives away before the trade starts
          </div>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[520px] text-sm">
              <thead>
                <tr className="border-b text-left text-[11px] uppercase tracking-wide text-muted-foreground">
                  <th className="py-1.5 pr-3">Symbol</th>
                  <th className="py-1.5 pr-3 text-right">Fills</th>
                  <th className="py-1.5 pr-3 text-right">Median pts</th>
                  <th className="py-1.5 pr-3 text-right">Mean pts</th>
                  <th className="py-1.5 pr-3 text-right">Worst</th>
                  <th className="py-1.5 text-right">Median $ / contract</th>
                </tr>
              </thead>
              <tbody>
                {data.slippage.map((s) => (
                  <tr key={`${s.mode}-${s.symbol}`} className="border-b last:border-0">
                    <td className="py-2 pr-3"><span className="text-muted-foreground">{s.mode}</span> {s.symbol}</td>
                    <td className="py-2 pr-3 text-right tabular-nums">{s.n}</td>
                    <td className="py-2 pr-3 text-right tabular-nums">{s.medianPts.toFixed(2)}</td>
                    <td className="py-2 pr-3 text-right tabular-nums">{s.meanPts.toFixed(2)}</td>
                    <td className="py-2 pr-3 text-right tabular-nums text-muted-foreground">{s.maxPts.toFixed(2)}</td>
                    <td className="py-2 text-right font-semibold tabular-nums">${s.medianCost.toFixed(2)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="mt-2 text-[11px] text-muted-foreground">
            Compare the median cost against the risk budget per trade. Anything eating a large share of
            the risk is taking money from the edge before it has a chance to work.
          </p>
        </div>
      )}
    </div>
  );
}
