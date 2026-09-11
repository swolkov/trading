"use client";

import useSWR from "swr";
import { useState } from "react";
import { RETIRED_AUTO_SOURCES } from "@/lib/margin-auto-plans";
import { Chip } from "@/components/ui/chip";
import { DataTable, Row, Td, Th } from "@/components/ui/data-table";
import { Empty, Note, Panel, PanelBody, PanelHeader, Stat } from "@/components/ui/panel";
import { ago, coinOf, hold, pnl0, pnl2, tone, usd, usd0, when } from "@/lib/format";
import { isBearishSource, isCreditStructure, isPutStructure } from "@/lib/options-paper-model";
import Link from "next/link";

interface Fill {
  symbol: string; action: string; price: number; vol: number; notional: number; fee: number; leveraged: boolean; time: string;
}
interface Data { orders: Fill[]; summary?: { total: number; totalFees: number; totalNotional: number } }
interface RoundTrip {
  pair: string; side: string; openedAt: string; closedAt: string; holdMinutes: number;
  entryPrice: number; exitPrice: number; netPnl: number; fees: number;
}
interface PaperTradeRow {
  id: number; time: string; source: string; symbol: string; side: string;
  leverage: number | null; conviction: string | null; entry: number | null;
  exit: number | null; pnl: number | null; unrealized: number | null; notional: number | null; status: string; reason: string | null;
  maxHoldH: number; ageH: number;
  simVersion?: string;
  usTradeable?: boolean;
}
interface ScanLook {
  at: string; scanned: number; fresh: number; suppressed: number;
  look: { coin: string; tf: string; kind: string; tier?: string; outcome: string; detail?: string }[];
  errors?: string[];
}
interface ScoreData { log?: PaperTradeRow[]; recentTrips?: RoundTrip[]; scanLook?: ScanLook | null }

const fetcher = (u: string) => fetch(u).then((r) => r.json()).catch(() => null);

function Segmented<T extends string>({ value, onChange, options }: { value: T; onChange: (v: T) => void; options: { k: T; label: string; tone?: "red" | "paper" }[] }) {
  return (
    <div className="inline-flex items-center gap-0.5 rounded-lg border border-border bg-card p-0.5">
      {options.map((o) => {
        const active = o.k === value;
        const activeCls = o.tone === "red" ? "bg-down/15 text-down" : o.tone === "paper" ? "bg-paper/15 text-paper" : "bg-accent text-foreground";
        return (
          <button key={o.k} onClick={() => onChange(o.k)} className={`h-7 rounded-md px-3 text-xs font-semibold transition-colors ${active ? activeCls : "text-muted-foreground hover:text-foreground"}`}>
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

// The one place for EVERY trade — Live (real) vs Paper (shadow), never blended. Live defaults
// to ROUND TRIPS (paired buy→sell with real P&L); a fills view shows every raw execution.
export function UnifiedOrdersTable() {
  const { data } = useSWR<Data>("/api/orders/all", fetcher, { refreshInterval: 30000 });
  const { data: krk } = useSWR<{ connected?: boolean; totalValue?: number; totalInvested?: number }>("/api/kraken-agent", fetcher, { refreshInterval: 60000 });
  const { data: score } = useSWR<ScoreData>("/api/margin/scoreboard", fetcher, { refreshInterval: 60000 });
  // The second platform's log lives here too, so "every trade in one place" is true.
  const { data: opt } = useSWR<{ trades?: OptionRow[] }>("/api/options/paper", fetcher, { refreshInterval: 120000 });
  const [view, setView] = useState<"live" | "paper" | "options" | "scan">("live");

  return (
    <div className="space-y-4">
      <Segmented value={view} onChange={setView} options={[
        { k: "live", label: "Kraken live · real money", tone: "red" },
        { k: "paper", label: "Kraken paper · no real money", tone: "paper" },
        { k: "options", label: "Robinhood options · paper", tone: "paper" },
        { k: "scan", label: "Scanner · what it just looked at" },
      ]} />
      {view === "live"
        ? <LiveView data={data} krk={krk} trips={score?.recentTrips ?? []} tripsLoading={score === undefined} />
        : view === "paper" ? <PaperLogTable log={score?.log ?? []} loading={score === undefined} />
          : view === "options" ? <OptionsLogTable trades={opt?.trades ?? []} loading={opt === undefined} />
            : <ScanLookTable scan={score?.scanLook ?? null} loading={score === undefined} />}
    </div>
  );
}

// ── Robinhood options paper log — the same rows as the Options Paper Book's position log ──
interface OptionRow {
  id: number; time: string; symbol: string; source: string; structure: string; strike: number | null;
  shortStrike: number | null; creditUsd: number; expiry: string | null; costUsd: number;
  markUsd: number | null; proceedsUsd: number | null; pnl: number | null; status: string; reason: string | null;
  entryDelta: number | null; entrySpreadPct: number | null;
}
const STRUCTURE_LABEL: Record<string, string> = {
  call: "Naked ITM call", call_spread: "Call debit spread", put_credit_spread: "Put credit spread",
  put: "Naked ITM put", put_spread: "Put debit spread", call_credit_spread: "Call credit spread",
};
function OptionsLogTable({ trades, loading }: { trades: OptionRow[]; loading: boolean }) {
  if (loading) return <Note className="py-4">Loading options paper trades…</Note>;
  return (
    <div className="space-y-3">
      <Note>
        Robinhood options paper book — <strong className="font-medium text-foreground/85">no real money moved, no order ever placed</strong>. In-the-money options and verticals on a 50-day breakout, bought at the quoted ask and sold at the quoted bid, marked from quotes the desk session pushes after the close. Sleeves, structures and the pushed-data health are on the <Link href="/options/paper" className="text-primary hover:underline">Options Paper Book</Link>.
      </Note>
      {trades.length === 0 ? <Empty>No options paper trades yet.</Empty> : (
        <DataTable>
          <thead>
            <tr>
              <Th>When</Th><Th>Sleeve</Th><Th>Contract</Th><Th>Structure</Th><Th num>Δ / spread</Th>
              <Th num>At risk</Th><Th num>Mark / exit</Th><Th num>P&L <span className="normal-case opacity-60">(open = unreal.)</span></Th><Th>Status</Th>
            </tr>
          </thead>
          <tbody>
            {trades.map((t) => (
              <Row key={t.id}>
                <Td title={when(t.time)}>{ago(t.time)}</Td>
                <Td>{t.source}{isBearishSource(t.source) && <Chip tone="red" className="ml-1.5">short</Chip>}</Td>
                <Td className="whitespace-nowrap">
                  {t.symbol}{" "}
                  {isCreditStructure(t.structure) && t.shortStrike != null
                    ? <>${t.shortStrike}<span className="text-muted-foreground">/${t.strike}{isPutStructure(t.structure) ? "p" : "c"}</span></>
                    : <>${t.strike ?? "—"}{t.shortStrike != null && <span className="text-muted-foreground">/${t.shortStrike}</span>}</>}
                  {" "}{t.expiry ?? ""}
                </Td>
                <Td>{STRUCTURE_LABEL[t.structure] ?? t.structure}{isCreditStructure(t.structure) && <span className="ml-1 text-[11px] text-muted-foreground">${t.creditUsd.toFixed(0)} credit</span>}</Td>
                <Td num>{t.entryDelta != null ? t.entryDelta.toFixed(2) : "—"} / {t.entrySpreadPct != null ? `${t.entrySpreadPct.toFixed(1)}%` : "—"}</Td>
                <Td num>{usd(t.costUsd)}</Td>
                <Td num>{t.status === "resolved" ? (t.proceedsUsd != null ? usd(t.proceedsUsd) : "—") : (t.markUsd != null ? usd(t.markUsd) : "—")}</Td>
                <Td num className={t.pnl != null ? tone(t.pnl) : t.markUsd != null ? tone(t.markUsd - t.costUsd) : ""}>
                  {t.pnl != null ? pnl2(t.pnl) : t.markUsd != null ? `(${pnl2(t.markUsd - t.costUsd)})` : "—"}
                </Td>
                <Td title={t.reason ?? ""}>
                  <Chip tone={t.status === "resolved" ? (t.pnl != null && t.pnl >= 0 ? "green" : "red") : t.status === "void" ? "amber" : "paper"}>
                    {t.status === "resolved" ? (t.reason ?? "closed") : t.status}
                  </Chip>
                </Td>
              </Row>
            ))}
          </tbody>
        </DataTable>
      )}
    </div>
  );
}

function LiveView({ data, krk, trips, tripsLoading }: {
  data: Data | undefined;
  krk: { connected?: boolean; totalValue?: number; totalInvested?: number } | undefined;
  trips: RoundTrip[]; tripsLoading: boolean;
}) {
  const [mode, setMode] = useState<"trips" | "fills">("trips");
  const krkVal = krk?.connected ? krk?.totalValue ?? null : null;
  const krkPnl = krkVal != null && krk?.totalInvested != null ? krkVal - krk.totalInvested : null;
  // The bot's OPEN positions — a trade that has not closed is not a round trip yet, but it is
  // real money right now, so it belongs at the top of the live view.
  const { data: arm } = useSWR<{ armed: boolean; liveNow?: { pair: string; side: string; vol: number; entry: number; net: number | null; openedAt: string }[] }>("/api/margin/arm", fetcher, { refreshInterval: 20000 });
  const openNow = arm?.liveNow ?? [];
  // The arm endpoint answers with an empty list on ANY Kraken failure, so an empty "open now"
  // is only trustworthy when the status endpoint could reach Kraken at the same time.
  const { data: st, error: stErr } = useSWR<{ connected: boolean; error?: string }>("/api/margin/status", fetcher, { refreshInterval: 60_000 });
  const krakenDown = !!stErr || (st != null && (st.connected === false || !!st.error));

  return (
    <div className="space-y-4">
      <Panel>
        <PanelHeader title="Open now — the bot's live positions" aside={arm ? <Chip tone={arm.armed ? "red" : "grey"} dot={arm.armed}>{arm.armed ? "executor armed" : "executor disarmed"}</Chip> : <span>loading…</span>} />
        {!arm ? <Empty>loading…</Empty> : openNow.length === 0 && krakenDown ? (
          <Empty><span className="text-down">Kraken did not answer</span> — open positions unknown, not zero. Retrying every 20s.</Empty>
        ) : openNow.length === 0 ? (
          <Empty>No open position.{arm.armed ? " Waiting for the next high-conviction breakout." : ""}</Empty>
        ) : (
          <DataTable>
            <thead><tr><Th>Coin</Th><Th>Side</Th><Th num>Size</Th><Th num>Entry</Th><Th num>Open P&amp;L</Th><Th num>Since</Th></tr></thead>
            <tbody>
              {openNow.map((p) => (
                <Row key={p.pair + p.openedAt}>
                  <Td strong>{coinOf(p.pair)}</Td>
                  <Td className={p.side === "long" ? "text-up" : "text-down"}>{p.side === "long" ? "Long" : "Short"}</Td>
                  <Td num>{p.vol.toLocaleString(undefined, { maximumFractionDigits: 4 })}</Td>
                  <Td num>{usd(p.entry)}</Td>
                  <Td num className={`font-semibold ${tone(p.net)}`}>{p.net == null ? "—" : pnl2(p.net)}</Td>
                  <Td num muted>{when(p.openedAt)}</Td>
                </Row>
              ))}
            </tbody>
          </DataTable>
        )}
        <div className="border-t border-border px-4 py-2">
          <Note>A position moves to Round trips below when it closes. Stops, margin level and liquidation distance are on Margin Cockpit.</Note>
        </div>
      </Panel>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <Panel><PanelBody>
          <Stat label="Kraken account P&L" value={krkPnl != null ? pnl0(krkPnl) : "—"} valueCls={krkPnl != null ? tone(krkPnl) : ""}
            sub={krkVal != null && krk?.totalInvested != null ? `${usd0(krk.totalInvested)} in → ${usd0(krkVal)} now · balance-based` : krk === undefined ? "loading…" : "account unreachable"} />
        </PanelBody></Panel>
        <Panel><PanelBody><Stat label="Round trips" value={trips.length} sub="completed margin trades" /></PanelBody></Panel>
        <Panel><PanelBody><Stat label="Fees paid" value={`−${usd0(data?.summary?.totalFees ?? 0)}`} valueCls="text-down/80" sub="real fees, lifetime" /></PanelBody></Panel>
      </div>

      <Segmented value={mode} onChange={setMode} options={[{ k: "trips", label: "Round trips (P&L)" }, { k: "fills", label: "All fills" }]} />

      {mode === "trips" ? <TripsTable trips={trips} loading={tripsLoading} /> : <FillsTable data={data} />}

      <Note>
        Round trips pair each buy with its matching sell to show real per-trade P&amp;L (net of fees). All fills is the raw execution log — a single fill has no P&amp;L on its own. Account P&amp;L is balance-based (value − deposits).
      </Note>
    </div>
  );
}

function TripsTable({ trips, loading }: { trips: RoundTrip[]; loading: boolean }) {
  if (loading) return <Note className="py-4">Loading round trips…</Note>;
  if (trips.length === 0) return <Note className="py-4">No completed round trips yet (need a matched buy + sell).</Note>;
  return (
    <Panel>
      <DataTable sticky maxH="60vh">
        <thead>
          <tr>
            <Th>Closed</Th>
            <Th>Coin</Th>
            <Th>Side</Th>
            <Th num>Entry → Exit</Th>
            <Th num>Hold</Th>
            <Th num>Fee</Th>
            <Th num>P&amp;L (net)</Th>
          </tr>
        </thead>
        <tbody>
          {trips.map((t, i) => (
            <Row key={i}>
              <Td muted>{when(t.closedAt)}</Td>
              <Td strong>{coinOf(t.pair)}</Td>
              <Td className={`capitalize ${t.side === "long" ? "text-up" : "text-down"}`}>{t.side}</Td>
              <Td num muted>{usd(t.entryPrice)} → {usd(t.exitPrice)}</Td>
              <Td num muted>{hold(t.holdMinutes)}</Td>
              <Td num className="text-down/70">{t.fees ? `−${usd(t.fees)}` : "—"}</Td>
              <Td num className={`font-semibold ${tone(t.netPnl)}`}>{pnl2(t.netPnl)}</Td>
            </Row>
          ))}
        </tbody>
      </DataTable>
    </Panel>
  );
}

function FillsTable({ data }: { data: Data | undefined }) {
  const [filter, setFilter] = useState<"all" | "margin" | "spot">("all");
  if (!data?.orders) return <Note className="py-4">Loading fills…</Note>;
  const rows = filter === "all" ? data.orders : data.orders.filter((o) => (filter === "margin" ? o.leveraged : !o.leveraged));
  return (
    <div className="space-y-2">
      <Segmented value={filter} onChange={setFilter} options={[{ k: "all", label: "All" }, { k: "margin", label: "Margin" }, { k: "spot", label: "Spot / bot" }]} />
      {rows.length === 0 ? <Note className="py-4">No fills.</Note> : (
        <Panel>
          <DataTable sticky maxH="55vh">
            <thead>
              <tr>
                <Th>When</Th>
                <Th>Coin</Th>
                <Th>Side</Th>
                <Th num>Price</Th>
                <Th num>Size</Th>
                <Th num>Value</Th>
                <Th num>Fee</Th>
              </tr>
            </thead>
            <tbody>
              {rows.map((o, i) => (
                <Row key={i}>
                  <Td muted>{when(o.time)}</Td>
                  <Td strong>{o.symbol}{o.leveraged && <Chip tone="paper" className="ml-1.5 h-4 px-1.5 text-[11px]">margin</Chip>}</Td>
                  <Td className={`capitalize ${o.action === "buy" ? "text-up" : "text-down"}`}>{o.action}</Td>
                  <Td num muted>{o.price != null ? usd(o.price) : "—"}</Td>
                  <Td num muted>{o.vol != null ? o.vol.toLocaleString(undefined, { maximumFractionDigits: 6 }) : "—"}</Td>
                  <Td num muted>{o.notional != null ? usd(o.notional) : "—"}</Td>
                  <Td num className="text-down/70">{o.fee ? `−${usd(o.fee)}` : "—"}</Td>
                </Row>
              ))}
            </tbody>
          </DataTable>
        </Panel>
      )}
    </div>
  );
}

function PaperLogTable({ log: fullLog, loading }: { log: PaperTradeRow[]; loading: boolean }) {
  // Default to what the desk actually trades: current cohort, US-tradeable coins, live
  // sleeves. Set-aside rows (old measurement, non-US coins, retired sleeves) still exist
  // and still resolve, but only show on request.
  const [showSetAside, setShowSetAside] = useState(false);
  const isSetAside = (t: PaperTradeRow) => t.simVersion === "v1" || t.usTradeable === false || RETIRED_AUTO_SOURCES.has(t.source);
  const setAsideCount = fullLog.filter(isSetAside).length;
  const log = showSetAside ? fullLog : fullLog.filter((t) => !isSetAside(t));
  if (loading) return <Note className="py-4">Loading paper trades…</Note>;
  return (
    <div className="space-y-3">
      <Note>
        Paper trades — hypothetical, <strong className="font-medium text-foreground/85">no real money moved</strong>. Risk-based sizing: each trade is sized so its stop loses a fixed max loss (~3% of the reference account) — a tighter stop means a bigger position for the same risk — then the stop trails up as it goes right. P&amp;L is net of estimated fees (trade fee at your real 0.17%/side; rollover BTC-verified, alts conservative). Open trades show a live &ldquo;if closed now&rdquo; P&amp;L.
        {setAsideCount > 0 && (
          <> <button onClick={() => setShowSetAside(!showSetAside)} className="text-primary hover:underline">{showSetAside ? "Hide" : "Show"} {setAsideCount} set-aside</button> (non-US coins, retired sleeves, old measurement — never counted).</>
        )}
      </Note>
      {log.length === 0 ? <Note className="py-4">No paper trades yet — they open automatically as breakouts fire.</Note> : (
        <Panel>
          <DataTable sticky maxH="60vh">
            <thead>
              <tr>
                <Th>When</Th>
                <Th>Strategy</Th>
                <Th>Coin</Th>
                <Th>Side</Th>
                <Th>Conviction</Th>
                <Th num>Size</Th>
                <Th num>Entry</Th>
                <Th num>Exit</Th>
                <Th num>P&amp;L</Th>
                <Th>Outcome</Th>
              </tr>
            </thead>
            <tbody>
              {log.map((t) => {
                const open = t.status !== "resolved";
                const val = open ? t.unrealized : t.pnl;
                return (
                  <Row key={t.id}>
                    <Td muted>{when(t.time)}</Td>
                    <Td muted>
                      {t.source}
                      {t.simVersion === "v1" && <span className="ml-1 text-[11px]" title="Scored under the pre-Sep-2 measurement model — excluded from the scoreboard statistics">v1</span>}
                      {t.usTradeable === false && <span className="ml-1 text-[11px] text-warn" title="Not a pair a US retail Kraken account can margin-trade — excluded from the scoreboard statistics">non-US</span>}
                    </Td>
                    <Td strong>{coinOf(t.symbol)}</Td>
                    <Td className={t.side === "buy" ? "text-up" : "text-down"}>{t.side === "buy" ? "Long" : "Short"}{t.leverage ? ` ${t.leverage}x` : ""}</Td>
                    <Td muted className="capitalize">{t.conviction ?? "—"}</Td>
                    <Td num muted>{t.notional != null ? usd0(t.notional) : "—"}</Td>
                    <Td num muted>{t.entry != null ? usd(t.entry) : "—"}</Td>
                    <Td num muted>{t.exit != null ? usd(t.exit) : "—"}</Td>
                    <Td num className="font-semibold">
                      {val != null ? <span className={tone(val)}>{pnl2(val)}{open && <span className="ml-1 text-[11px] font-normal text-muted-foreground">live</span>}</span> : <span className="text-muted-foreground">—</span>}
                    </Td>
                    {/* An open row shows how far through ITS OWN hold it is. Sleeves differ by
                        a lot — swing-spot and tsmom run 14-day holds where swing-lev runs 96
                        hours — so "open" alone made a healthy long-hold position look stuck. */}
                    <Td>{open ? (
                      <Chip tone={t.maxHoldH > 0 && t.ageH > t.maxHoldH ? "red" : "amber"} title={t.maxHoldH > 0 && t.ageH > t.maxHoldH ? "PAST its time stop — the resolver has not reached it" : `This sleeve holds up to ${Math.round(t.maxHoldH)}h; the time stop closes it then.`}>
                        open · {Math.round(t.ageH)}h of {Math.round(t.maxHoldH)}h
                      </Chip>
                    ) : <span className="text-muted-foreground">{t.reason ?? "closed"}</span>}</Td>
                  </Row>
                );
              })}
            </tbody>
          </DataTable>
        </Panel>
      )}
    </div>
  );
}

// WHAT THE DESK JUST LOOKED AT. Every rejection in the scan used to be an invisible
// `continue`; the run persists them now, and this is where they are read. It answers the
// question the other two tabs cannot: "why hasn't it traded?" — separating "nothing
// qualified" from "something qualified and was refused", which are very different problems.
function ScanLookTable({ scan, loading }: { scan: ScanLook | null; loading: boolean }) {
  if (loading) return <Note className="py-4">Loading the last scan…</Note>;
  if (!scan) return <Note className="py-4">No scan recorded yet — the next tick writes one (the scanner runs every 5 minutes).</Note>;
  const tone = (o: string): "up" | "down" | "warn" | "muted" =>
    o === "TRADED LIVE" ? "up" : o.startsWith("live refused") || o === "live ERROR" ? "down" : o === "no trade" || o === "watched" ? "muted" : "warn";
  const cls = { up: "text-up", down: "text-down", warn: "text-warn", muted: "text-muted-foreground" };
  const traded = scan.look.filter((l) => l.outcome === "TRADED LIVE").length;
  const refused = scan.look.filter((l) => l.outcome.startsWith("live refused") || l.outcome === "live ERROR").length;
  return (
    <div className="space-y-3">
      <Note>
        The most recent 5-minute scan, {when(scan.at)}. It saw <strong className="font-medium text-foreground/85">{scan.scanned}</strong> signals across 26 coins and 5 timeframes;
        {" "}{scan.suppressed} were the same condition still pinging inside its re-alert window, leaving <strong className="font-medium text-foreground/85">{scan.fresh}</strong> fresh.
        {" "}Of those, {traded} traded live and {refused} were refused.
        {" "}<strong className="font-medium text-foreground/85">&ldquo;no trade&rdquo; is the normal outcome</strong> — only HIGH conviction is ever traded, and the live sleeve takes 4h breakouts only, so most of what the scanner sees is correctly ignored.
      </Note>
      {scan.errors?.length ? <Note className="text-warn">Scan errors: {scan.errors.join(" · ")}</Note> : null}
      {scan.look.length === 0 ? <Note className="py-4">That tick saw nothing fresh — normal between setups.</Note> : (
        <Panel>
          <DataTable sticky maxH="60vh">
            <thead><tr><Th>Coin</Th><Th>Timeframe</Th><Th>Signal</Th><Th>Conviction</Th><Th>Outcome</Th><Th>Why</Th></tr></thead>
            <tbody>
              {scan.look.map((l, i) => (
                <Row key={`${l.coin}-${l.tf}-${l.kind}-${i}`}>
                  <Td strong>{l.coin}</Td>
                  <Td muted>{l.tf}</Td>
                  <Td muted>{l.kind}</Td>
                  <Td muted className="capitalize">{l.tier ?? "—"}</Td>
                  <Td className={`font-medium ${cls[tone(l.outcome)]}`}>{l.outcome}</Td>
                  <Td muted className="whitespace-normal">{l.detail ?? "—"}</Td>
                </Row>
              ))}
            </tbody>
          </DataTable>
        </Panel>
      )}
    </div>
  );
}
