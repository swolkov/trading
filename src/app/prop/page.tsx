"use client";

import { useState } from "react";
import useSWR from "swr";
import { Chip } from "@/components/ui/chip";
import { DataTable, Row, Td, Th } from "@/components/ui/data-table";
import { Empty, Explainer, Label, Note, PageHeader, Panel, PanelBody, PanelHeader, Stat } from "@/components/ui/panel";
import { ago, money, pnl0, pnl2, tone, usd0, when } from "@/lib/format";

// ============ PROP DESK ============
// The Tradeify 247 account: swing-lev's signals under Tradeify's rules. ONE job — "where does
// the funded account stand right now?": the two floors and today's room, the arm switch,
// what is open and its stop, the ledger, phase progress. Signals live on the Live Desk;
// the Kraken account lives on the Margin Cockpit. Nothing is duplicated here.

const fetcher = (u: string) => fetch(u).then((r) => r.json());

interface Position {
  positionCode: string; symbol: string; quantity: number; side: string; openTime: string; openPrice: number; stopLossPrice?: number;
  managed: { entry: number; oneR: number; peak: number; stop: number; source: string; openedAt: string } | null;
}
interface LedgerRow {
  id: number; position_code: string; symbol: string; coin: string; source: string; tier: string | null; qty: number; entry_px: number; stop_px: number;
  one_r: number; risk_usd: number; notional_usd: number; risk_pct: number; opened_at: string; closed_at: string | null; exit_px: number | null; pnl_usd: number | null; exit_reason: string | null; note: string | null;
}
interface Status {
  configured: boolean; brokerError: string | null;
  account: { account: string; accountStatus: string; positionBased: boolean } | null;
  metrics: { equity: number; balance: number; openPL: number; margin: number; openPositionsCount: number; openOrdersCount: number } | null;
  plan: { accountSize: number; dailyLossPct: number; maxDrawdownPct: number; targets: number[]; resetHourUtc: number };
  config: { armed: boolean; sources: string[]; riskBasePct: number; riskMaxPct: number; maxPositions: number; maxEntriesPerDay: number };
  floors: { dailyFloor: number; maxFloor: number; snapshotBalance: number; snapshotKnown: boolean; snapshotEstimated: boolean; dayKey: string } | null;
  room: { dailyRoom: number; maxRoom: number; room: number; cushionPct: number } | null;
  breach: "ok" | "warn" | "urgent" | "breached" | null;
  phase: { phase: number; label: string; target: number | null; progress: number | null; remaining: number | null };
  guardian: { at: string | null; fresh: boolean };
  disarmed: { reason: string; at: string } | null;
  entriesToday: number; lastTradeAt: string | null;
  positions: Position[]; orders: unknown[]; ledger: LedgerRow[];
  armLog: { at: string; action: string; by?: string; source?: string; riskBasePct?: number; cleared?: string }[];
  record: { trades: number; wins: number; pnl: number };
  cachedMs?: number;
}

const btn = "inline-flex h-8 items-center justify-center rounded-md border px-3 text-xs font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-40";
const btnDanger = `${btn} border-down/50 bg-down/10 text-down hover:bg-down/20`;
const btnPlain = `${btn} border-border bg-card text-foreground hover:bg-accent`;

const breachTone = (b: Status["breach"]) => (b === "ok" ? "green" : b === "warn" ? "amber" : b == null ? "grey" : "red");
const breachLabel = (b: Status["breach"]) => (b === "ok" ? "inside the rules" : b === "warn" ? "half a limit used" : b === "urgent" ? "near a floor" : b === "breached" ? "AT A FLOOR" : "unknown");

/** A horizontal meter: how much of a limit is used. Reads left→right as danger grows. */
function Meter({ used, total, label, sub }: { used: number; total: number; label: string; sub: string }) {
  const frac = total > 0 ? Math.max(0, Math.min(1, used / total)) : 0;
  const cls = frac >= 0.8 ? "bg-down" : frac >= 0.5 ? "bg-warn" : "bg-up";
  return (
    <div className="min-w-0">
      <div className="flex items-baseline justify-between gap-2">
        <Label>{label}</Label>
        <span className="text-xs tabular-nums text-muted-foreground">{sub}</span>
      </div>
      <div className="mt-1.5 h-2 w-full overflow-hidden rounded-full bg-muted">
        <div className={`h-full rounded-full ${cls} transition-[width]`} style={{ width: `${frac * 100}%` }} />
      </div>
    </div>
  );
}

export default function PropDeskPage() {
  const { data, mutate } = useSWR<Status>("/api/prop/status", fetcher, { refreshInterval: 30_000 });
  const [confirm, setConfirm] = useState("");
  const [risk, setRisk] = useState("1.5");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  async function post(body: Record<string, unknown>) {
    setBusy(true); setMsg(null);
    try {
      const r = await fetch("/api/prop/arm", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const j = await r.json();
      setMsg(j.error ?? (j.config?.armed ? "ARMED — the next high-conviction 4h breakout trades here" : "disarmed"));
      setConfirm("");
      await mutate();
    } catch (e) { setMsg(String(e)); }
    setBusy(false);
  }

  if (!data) return <div className="p-6 text-[13px] text-muted-foreground">Loading the prop desk…</div>;
  const m = data.metrics, f = data.floors, r = data.room, plan = data.plan, c = data.config;
  const dailyLimit = plan.accountSize * plan.dailyLossPct, maxLimit = plan.accountSize * plan.maxDrawdownPct;
  const brokerOk = data.configured && !data.brokerError && !!m;
  const canArm = confirm === "ARM" && brokerOk && data.guardian.fresh && !data.disarmed && data.account?.accountStatus === "FULL_TRADING";
  const riskNum = Number(risk);

  return (
    <div className="space-y-4 p-4 md:p-6">
      <PageHeader
        title="Crypto Prop Account"
        sub={<>Tradeify 247 · DXtrade <strong>crypto</strong> · $100k 2-Step · {data.account?.account ?? "no account"} · bought Sep 11 2026 in error (wanted: a futures prop account) · not in use, kept disarmed while a conversion or refund is pursued.</>}
        right={
          <>
            <Chip tone={c.armed ? "red" : "grey"} dot={c.armed} size="md">{c.armed ? "ARMED" : "disarmed"}</Chip>
            <Chip tone={breachTone(data.breach)} size="md">{breachLabel(data.breach)}</Chip>
            <Chip tone={data.guardian.fresh ? "green" : "red"} size="md" title="The prop guardian runs every 5 minutes. Stale = no entries.">guardian {data.guardian.at ? ago(data.guardian.at) : "never"}</Chip>
          </>
        }
      />

      <Panel tone="amber">
        <PanelBody>
          <Note>
            <strong>This is not the futures desk.</strong> Tradeify 247 trades crypto pairs, tokenized stocks, gold and oil — not ES, NQ or any CME contract. Spencer already trades crypto on Kraken and does not want this account; it was bought on Sep 11 2026 believing it was Tradeify&apos;s futures product. Status: <strong>{c.armed ? "ARMED — should be disarmed" : "disarmed"}</strong>, {data.record.trades} trades closed. The guardian keeps running so the 30-day inactivity rule cannot breach it while a conversion to a futures evaluation is requested from support. A futures prop account, when bought, gets its own section — this page will not become it.
          </Note>
        </PanelBody>
      </Panel>

      {!data.configured && <Panel tone="red"><PanelBody><Note>Broker not configured on this deployment — TRADEIFY_DX_* environment variables are missing.</Note></PanelBody></Panel>}
      {data.brokerError && <Panel tone="red"><PanelBody><Note><strong className="text-down">DXtrade did not answer</strong> — {data.brokerError}. Positions unknown, not zero.</Note></PanelBody></Panel>}
      {data.disarmed && (
        <Panel tone="red">
          <PanelHeader title="Standing disarm" aside={<span>{when(data.disarmed.at)}</span>} />
          <PanelBody className="space-y-2">
            <Note>{data.disarmed.reason}</Note>
            <button disabled={busy} onClick={() => post({ action: "clear-disarm" })} className={btnPlain}>{busy ? "…" : "Clear — does not arm"}</button>
          </PanelBody>
        </Panel>
      )}

      {/* THE ACCOUNT — equity and the two floors. This is the whole page in one row. */}
      <Panel tone={data.breach === "breached" ? "red" : data.breach === "urgent" ? "amber" : undefined}>
        <PanelHeader title="Account" aside={<>{data.account?.accountStatus ?? "—"} · {f?.snapshotKnown ? `day ${f.dayKey} from $${f.snapshotBalance.toLocaleString()}${f.snapshotEstimated ? " (read late — +$1,000 buffer on the daily floor)" : ""}` : "22:00 UTC snapshot not yet taken today (conservative floors)"}</>} />
        <PanelBody className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <Stat label="Equity" value={m ? money(m.equity) : "—"} size="lg" sub={m ? <>balance {money(m.balance)} · open {pnl0(m.openPL)}</> : null} />
          <Stat label="Room today" value={r ? money(Math.max(0, r.dailyRoom)) : "—"} valueCls={r && r.dailyRoom < dailyLimit * 0.5 ? "text-warn" : undefined} sub={f ? <>daily floor {money(f.dailyFloor)} (−3% of size)</> : null} />
          <Stat label="Room to max floor" value={r ? money(Math.max(0, r.maxRoom)) : "—"} valueCls={r && r.maxRoom < maxLimit * 0.5 ? "text-warn" : undefined} sub={f ? <>static floor {money(f.maxFloor)} (−6%, never moves)</> : null} />
          <Stat label={data.phase.label} value={data.phase.target != null ? `${Math.round((data.phase.progress ?? 0) * 100)}%` : "funded"} sub={data.phase.target != null ? <>{money(data.phase.remaining ?? 0)} more closed profit to {usd0(plan.accountSize + data.phase.target)}</> : <>payouts on demand</>} />
        </PanelBody>
        <PanelBody className="grid gap-4 border-t border-border sm:grid-cols-2">
          <Meter label="Daily limit used" used={dailyLimit - (r?.dailyRoom ?? dailyLimit)} total={dailyLimit} sub={`${money(Math.max(0, dailyLimit - (r?.dailyRoom ?? dailyLimit)))} of ${money(dailyLimit)}`} />
          <Meter label="Max drawdown used" used={maxLimit - (r?.maxRoom ?? maxLimit)} total={maxLimit} sub={`${money(Math.max(0, maxLimit - (r?.maxRoom ?? maxLimit)))} of ${money(maxLimit)}`} />
        </PanelBody>
      </Panel>

      <div className="grid gap-4 lg:grid-cols-2">
        {/* ARM */}
        <Panel>
          <PanelHeader title="Arm switch" aside={<span>{c.sources.join(", ")} · {c.riskBasePct}% → {c.riskMaxPct}% with a 10% cushion · {c.maxPositions} slot · {c.maxEntriesPerDay}/day</span>} />
          <PanelBody className="space-y-2.5">
            {c.armed ? (
              <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:gap-3">
                <button disabled={busy} onClick={() => post({ action: "disarm" })} className={`${btnDanger} w-full sm:w-auto`}>{busy ? "…" : "Disarm — stop new entries"}</button>
                <Note>Open positions stay under the guardian after a disarm. Entries today: {data.entriesToday}/{c.maxEntriesPerDay}.</Note>
              </div>
            ) : (
              <div className="space-y-2">
                <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                  <input value={confirm} onChange={(e) => setConfirm(e.target.value)} placeholder="type ARM" aria-label="Type ARM to enable the arm button" className="h-8 w-full rounded-md border border-input bg-background px-2.5 text-[13px] tabular-nums sm:w-28" />
                  <label className="flex items-center gap-1.5 text-xs text-muted-foreground">risk %<input value={risk} onChange={(e) => setRisk(e.target.value)} className="h-8 w-16 rounded-md border border-input bg-background px-2 text-[13px] tabular-nums" /></label>
                  <button disabled={busy || !canArm || !(riskNum > 0 && riskNum <= c.riskMaxPct)} onClick={() => post({ action: "arm", confirm, source: "swing-lev", riskBasePct: riskNum })} className={`${btnDanger} w-full sm:w-auto`}>
                    {busy ? "arming…" : "Arm swing-lev on the prop account"}
                  </button>
                </div>
                <Note>
                  Needs: broker answering, account FULL_TRADING, guardian run in the last 15 minutes, no standing disarm. Risk is a fixed % of the $100k size (1.5% = $1,500 a trade, $37,500 position at a 4% stop); the replay&apos;s tested ceiling is {c.riskMaxPct}%.
                </Note>
              </div>
            )}
            {msg && <Note className={msg.startsWith("ARMED") ? "text-down" : undefined}>{msg}</Note>}
            {data.armLog.length > 0 && (
              <div className="space-y-0.5 pt-1">
                {data.armLog.slice(0, 5).map((l, i) => <p key={i} className="text-xs text-muted-foreground"><span className="tabular-nums">{when(l.at)}</span> · {l.action}{l.source ? ` ${l.source}` : ""}{l.riskBasePct != null ? ` ${l.riskBasePct}%` : ""}{l.cleared ? ` (${l.cleared})` : ""}</p>)}
              </div>
            )}
          </PanelBody>
        </Panel>

        {/* OPEN */}
        <Panel>
          <PanelHeader title="Open position" aside={<span>{data.positions.length} of {c.maxPositions} · last trade {data.lastTradeAt ? ago(data.lastTradeAt) : "never"}</span>} />
          {data.positions.length === 0 ? <Empty>{brokerOk ? "Flat. The next high-conviction 4h breakout the Live Desk records is offered here." : "Positions unknown — broker did not answer."}</Empty> : (
            <DataTable dense>
              <thead><tr><Th>Coin</Th><Th num>Qty</Th><Th num>Entry</Th><Th num>Stop</Th><Th num>Peak</Th><Th num>R</Th><Th>Age</Th><Th>Managed</Th></tr></thead>
              <tbody>
                {data.positions.map((p) => {
                  const mg = p.managed;
                  const peakR = mg ? (mg.peak - mg.entry) / mg.oneR : null;
                  const stopR = mg ? (mg.stop - mg.entry) / mg.oneR : null;
                  return (
                    <Row key={p.positionCode}>
                      <Td strong>{p.symbol.split("/")[0]} <span className="text-muted-foreground">{p.side === "BUY" ? "long" : "short"}</span></Td>
                      <Td num>{p.quantity}</Td>
                      <Td num>{p.openPrice}</Td>
                      <Td num className={p.stopLossPrice ? (stopR != null && stopR >= 0 ? "text-up" : "") : "text-down"}>{p.stopLossPrice ?? "NAKED"}</Td>
                      <Td num>{mg ? mg.peak : "—"}</Td>
                      <Td num className={tone(peakR)}>{peakR != null ? `+${peakR.toFixed(2)}R` : "—"}</Td>
                      <Td muted>{ago(p.openTime)}</Td>
                      <Td>{mg ? <Chip tone="green">{mg.source}</Chip> : <Chip tone="amber" title="Opened outside the desk — it uses the slot and counts against the floors, but the desk will not manage it.">not ours</Chip>}</Td>
                    </Row>
                  );
                })}
              </tbody>
            </DataTable>
          )}
        </Panel>
      </div>

      {/* LEDGER */}
      <Panel>
        <PanelHeader title="Ledger" aside={<>{data.record.trades} closed · {data.record.wins} wins · <span className={tone(data.record.pnl)}>{pnl0(data.record.pnl)}</span> est. after fees</>} />
        {data.ledger.length === 0 ? <Empty>No prop trades yet.</Empty> : (
          <DataTable dense maxH="420px" sticky>
            <thead><tr><Th>Opened</Th><Th>Coin</Th><Th num>Risk</Th><Th num>Size</Th><Th num>Entry</Th><Th num>Exit</Th><Th>Reason</Th><Th num>P&amp;L</Th><Th num>R</Th></tr></thead>
            <tbody>
              {data.ledger.map((t) => {
                const R = t.pnl_usd != null && t.one_r > 0 && t.qty > 0 ? t.pnl_usd / (t.one_r * t.qty) : null;
                return (
                  <Row key={t.id}>
                    <Td muted className="whitespace-nowrap">{when(t.opened_at)}</Td>
                    <Td strong>{t.coin}</Td>
                    <Td num>{money(t.risk_usd)} <span className="text-muted-foreground">{t.risk_pct.toFixed(2)}%</span></Td>
                    <Td num>{usd0(t.notional_usd)}</Td>
                    <Td num>{t.entry_px}</Td>
                    <Td num>{t.exit_px ?? (t.closed_at ? "?" : <Chip tone="blue">open</Chip>)}</Td>
                    <Td muted>{t.exit_reason ?? "—"}</Td>
                    <Td num className={tone(t.pnl_usd)}>{t.pnl_usd != null ? pnl2(t.pnl_usd) : "—"}</Td>
                    <Td num className={tone(R)}>{R != null ? `${R >= 0 ? "+" : ""}${R.toFixed(2)}R` : "—"}</Td>
                  </Row>
                );
              })}
            </tbody>
          </DataTable>
        )}
      </Panel>

      <Explainer title="How this desk would work if it were armed, and how it differs from the Kraken desk">
        <ul>
          <li><strong>Not in use.</strong> Everything below is what the code does when armed. It is kept deployed and disarmed; the only thing it does today is read the account, watch the floors and keep the account alive.</li>
          <li><strong>Same signals.</strong> The Live Desk&apos;s high-conviction 4h breakouts (swing-lev) are offered to this account on the same scan tick they are offered to Kraken. Long only. Paper keeps measuring either way.</li>
          <li><strong>Different sizing.</strong> Tradeify&apos;s limits are fixed dollars, so risk here is a fixed % of the $100k size, not of equity. A stop-out with slippage must fit inside today&apos;s room with a 10% buffer; when it does not, the trade is sized down, and below a quarter size it is refused.</li>
          <li><strong>Two floors, both on live equity.</strong> Daily: the 22:00 UTC closing balance minus $3,000. Static: $94,000, forever. An open position&apos;s unrealized loss counts. Touching either closes the account, so the desk refuses new risk once 80% of a limit is used and pages at 50%.</li>
          <li><strong>Same exit container.</strong> 4% initial stop attached in the same request as the entry (never naked), breakeven at +1R, trail 1R behind the peak from completed Kraken 1-minute bars, close at 96 hours. Byte-for-byte paper&apos;s rule.</li>
          <li><strong>One entry a day.</strong> Two full losses in a day would exceed the 3% limit; the cap is the rule, not a preference.</li>
          <li><strong>Prices from Kraken, fills on Tradeify.</strong> DXtrade does not serve market data to this login; signals and peaks come from the same Kraken feed the paper record uses. Stops execute on Tradeify&apos;s feed.</li>
          <li><strong>Keep-alive.</strong> 30 days without a trade breaches the account; at 27 the guardian places and closes a minimum BTC trade.</li>
          <li><strong>Phases.</strong> +10% then +5% of closed balance. On a target the guardian pages: Tradeify issues the next account and its credentials go on Vercel by hand.</li>
        </ul>
      </Explainer>
    </div>
  );
}
