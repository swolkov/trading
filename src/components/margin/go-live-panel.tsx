"use client";

import { useState, type ReactNode } from "react";
import useSWR from "swr";
import { Check, X } from "lucide-react";
import { Chip, type ChipTone, verdictTone } from "@/components/ui/chip";
import { DataTable, Row, Td, Th } from "@/components/ui/data-table";
import { Note, Panel, PanelBody } from "@/components/ui/panel";
import { ago, coinOf, pnl0, timeOnly, usd, usd0 } from "@/lib/format";

// ── The go-live panel: three steps a founder can read at a glance ──────────────────────────
// 1 plumbing ($20 round trip) · 2 paper gate (the live candidate's record) · 3 arm.
// Every action here posts to the same endpoints with the same bodies as before this file
// was split out of the page; only the presentation changed.

const fetcher = (u: string) => fetch(u).then((r) => r.json());
const LIVE_CANDIDATE = "selective";

export interface StrategyStat {
  key: string; label: string; resolved: number; wins: number; hitRate: number | null;
  avgWin: number; avgLoss: number; expectancy: number | null; totalPnl: number; open: number;
  grossPnl: number; fees: number; peakedGreen: number; liveNet: number; tStat: number | null; paperTStat?: number | null; verdict: string;
  forwardResolved?: number; days?: number;
}
interface ExecCfg {
  live: { liveSources?: string[]; armed: boolean; auto: boolean; validateOnly: boolean; ddBreakerTripped: boolean; baseRiskPct: number; stopPct: number; trailPct: number; maxHoldH: number; perTradeCapUsd: number; maxLeverageCeiling: number; maxPositions: number; maxTradesPerDay: number; trustAlertConviction: boolean };
  paper: { refEquity: number; baseRiskPct: number; stopPct: number; maxHoldH: number; exit: string };
  equity: number | null; equityAt?: string | null; leverageRung: number;
  ladder: { from: number; cap: number }[];
  tiers: { tier: string; riskPct: number; riskUsd: number | null; notionalUsd: number | null }[];
  aligned: { stop: boolean; risk: boolean; hold: boolean; sizing: boolean; exit: boolean }; allAligned: boolean;
}
interface RtView {
  state: { stage: string; symbol: string; startedAt: string; updatedAt: string; entryTxid?: string; closeTxid?: string; fillVol?: number; log: string[]; error?: string; finishedAt?: string; fees?: { entry: number; exit: number; net: number | null } } | null;
  checklist: { key: string; label: string; result: { ok: boolean | null; note: string; at: string } | null }[];
  verdict: { complete: boolean; allOk: boolean; failed: string[] } | null;
  dryRun?: { at: string; symbol: string; ok: boolean; note: string; restoreFailed: string[] } | null;
}
interface ArmStatus { liveNow?: { pair: string; side: string; vol: number; entry: number; net: number | null; openedAt: string }[]; stage3?: { status: string; target: number; done: number; fromBase: number; toBase: number; note?: string } | null; armed: boolean; auto: boolean; validateOnly: boolean; sources: string[]; maxPositions: number; maxTradesPerDay: number; marketEntries: boolean; riskPct: number; ddTripped: boolean; roundTripPassed: boolean; roundTripRunning: boolean; log: string[]; error?: string }

const OkMark = ({ ok }: { ok: boolean | null | undefined }) =>
  ok === true ? <Check className="h-3.5 w-3.5 text-up" /> : ok === false ? <X className="h-3.5 w-3.5 text-down" /> : <span className="inline-block h-1 w-1 rounded-full bg-muted-foreground/50" />;

const btn = "inline-flex h-8 items-center justify-center rounded-md border px-3 text-xs font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-40";
const btnDanger = `${btn} border-down/50 bg-down/10 text-down hover:bg-down/20`;
const btnGood = `${btn} border-up/50 bg-up/10 text-up hover:bg-up/20`;
const btnPlain = `${btn} border-border bg-card text-foreground hover:bg-accent`;

function Step({ n, title, status, tone, children }: { n: number; title: string; status: string; tone: ChipTone; children?: ReactNode }) {
  return (
    <Panel>
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-2.5">
        <h2 className="text-[13px] font-semibold"><span className="mr-2 text-muted-foreground">{n}</span>{title}</h2>
        <Chip tone={tone} size="md" dot={tone === "red"}>{status}</Chip>
      </div>
      <PanelBody className="space-y-3">{children}</PanelBody>
    </Panel>
  );
}

function GateRow({ label, value, target, ok, hint }: { label: string; value: string; target: string; ok: boolean; hint: string }) {
  return (
    <div className="grid grid-cols-[1rem_1fr_auto] items-center gap-2 text-[13px]">
      <OkMark ok={ok} />
      <span>{label} <span className="text-muted-foreground">— {hint}</span></span>
      <span className="text-right tabular-nums"><span className={ok ? "font-semibold text-up" : "font-semibold"}>{value}</span><span className="text-muted-foreground"> / {target}</span></span>
    </div>
  );
}

function ArmControls({ rtPassed, gateOk }: { rtPassed: boolean; gateOk: boolean }) {
  const { data: arm, mutate } = useSWR<ArmStatus>("/api/margin/arm", fetcher, { refreshInterval: 15_000 });
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const post = async (body: Record<string, unknown>) => {
    setBusy(true); setMsg(null);
    try {
      const r = await fetch("/api/margin/arm", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      const j = await r.json();
      setMsg(j.error ?? (j.armed ? "ARMED — real orders from the next scan tick" : "disarmed"));
      await mutate();
    } catch (e) { setMsg(String(e)); }
    finally { setBusy(false); setConfirm(""); }
  };
  if (!arm) return <Note>Loading arm state…</Note>;
  const canArm = confirm === "ARM" && rtPassed && !arm.ddTripped && !arm.roundTripRunning;
  return (
    <div className="space-y-2.5">
      {arm.armed ? (
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:gap-3">
          <button disabled={busy} onClick={() => post({ action: "disarm" })} className={`${btnDanger} w-full sm:w-auto`}>{busy ? "…" : "Disarm — stop new entries"}</button>
          <Note>Live: {arm.sources.join(", ")} · {arm.riskPct}% base, {arm.riskPct * 2}% high conviction · max {arm.maxPositions} position{arm.maxPositions === 1 ? "" : "s"} · {arm.maxTradesPerDay} trades/day · {arm.marketEntries ? "market" : "maker"} entries. Open positions stay under the guardian after a disarm.</Note>
        </div>
      ) : (
        <div className="space-y-2">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
            <input value={confirm} onChange={(e) => setConfirm(e.target.value)} placeholder="type ARM" aria-label="Type ARM to enable the arm button"
              className="h-8 w-full rounded-md border border-input bg-background px-2.5 text-[13px] tabular-nums sm:w-28" />
            <button disabled={busy || !canArm} onClick={() => post({ action: "arm", confirm, source: "selective", maxPositions: 1, maxTradesPerDay: 3 })} className={`${btnDanger} w-full sm:w-auto`}>
              {busy ? "arming…" : "Arm selective — real money"}
            </button>
          </div>
          <Note>3% per trade for the first 20 live trades, then paper&apos;s full 6% · 1 position · 3 trades a day.</Note>
          <div className="flex flex-wrap gap-1.5">
            {!rtPassed && <Chip tone="red">plumbing test must pass first</Chip>}
            {arm.ddTripped && <Chip tone="red">drawdown breaker tripped</Chip>}
            {arm.roundTripRunning && <Chip tone="amber">round trip running</Chip>}
            {!gateOk && rtPassed && <Chip tone="amber">paper gate not green — arming anyway is your call, and is logged</Chip>}
          </div>
        </div>
      )}
      {arm.armed && (
        <div className="flex flex-wrap items-center gap-2 text-[13px]">
          <span className="text-muted-foreground">Live now</span>
          {arm.liveNow && arm.liveNow.length > 0
            ? arm.liveNow.map((p) => (
              <Chip key={p.pair + p.openedAt} tone={p.net == null ? "grey" : p.net >= 0 ? "green" : "red"} size="md">
                {coinOf(p.pair)} {p.side} · entry {usd(p.entry)} · {p.net != null ? pnl0(p.net) : "P&L pending"} · since {timeOnly(p.openedAt)}
              </Chip>
            ))
            : <Chip tone="grey" size="md">no open position — waiting for the next high-conviction breakout</Chip>}
          <span className="text-xs text-muted-foreground">detail on Margin Cockpit</span>
        </div>
      )}
      {arm.stage3 && (
        <div className="flex flex-wrap items-center gap-2 text-[13px]">
          <span className="text-muted-foreground">Stage 3</span>
          {arm.stage3.status === "running" && <><Chip tone="blue" size="md">{arm.stage3.done} of {arm.stage3.target} closed</Chip><span className="text-xs text-muted-foreground">first {arm.stage3.target} live trades at {arm.stage3.fromBase}% risk; moves to paper&apos;s {arm.stage3.toBase}% automatically when real fills match paper</span></>}
          {arm.stage3.status === "graduated" && <Chip tone="green" size="md">graduated — {arm.stage3.toBase}% base, {arm.stage3.toBase * 2}% high conviction</Chip>}
          {arm.stage3.status === "held" && <Chip tone="red" size="md">held at {arm.stage3.fromBase}% — {arm.stage3.note}</Chip>}
        </div>
      )}
      {msg && <Note className="text-foreground/80">{msg}</Note>}
      {arm.log.length > 0 && <Note>Last: {arm.log[0]}</Note>}
    </div>
  );
}

export function GoLivePanel({ strategies }: { strategies: StrategyStat[] }) {
  const { data: rt } = useSWR<RtView>("/api/margin/round-trip", fetcher, { refreshInterval: 30_000 });
  const { data: cfg } = useSWR<ExecCfg>("/api/margin/executor-config", fetcher, { refreshInterval: 60_000 });
  const cand = strategies.find((s) => s.key === LIVE_CANDIDATE) ?? null;
  const rtState = rt?.state ?? null;
  const rtRunning = rtState != null && ["entering", "open", "closing"].includes(rtState.stage);
  const rtPassed = rtState?.stage === "done" && !!rt?.verdict?.allOk;
  const plumbingStatus = rtRunning ? `Running · ${rtState?.stage}` : rtPassed ? `Passed · ${new Date(rtState!.finishedAt ?? rtState!.updatedAt).toLocaleDateString()}` : rtState?.stage === "done" ? "Failed checks" : rtState?.stage === "failed" ? "Last run failed" : "Not run yet";
  const plumbingTone: ChipTone = rtRunning ? "amber" : rtPassed ? "green" : rtState ? "red" : "grey";

  const resolved = cand?.resolved ?? 0;
  const net = cand?.liveNet ?? 0;
  const t = cand?.tStat ?? null;
  const days = cand?.days ?? 0;
  const gate = { n: resolved >= 30, net: resolved > 0 && net > 0, t: t != null && t >= 2, days: days >= 7 };
  const gateOk = gate.n && gate.net && gate.t && gate.days;
  const gateStatus = !cand ? "No data yet" : gateOk ? "Real edge — gate open" : `${[gate.n, gate.net, gate.t, gate.days].filter(Boolean).length} of 4 green`;
  const gateTone: ChipTone = !cand ? "grey" : gateOk ? "green" : "amber";

  const armed = !!cfg?.live.armed;
  const eq = cfg?.equity ?? 0;

  return (
    <div className="space-y-3">
      <Step n={1} title="Plumbing test — one real $20 trade through the whole system" status={plumbingStatus} tone={plumbingTone}>
        <Note>
          Proves Kraken behaves the way the code assumes: entry, attached stop, close, fees. It is not a strategy test and does not move step 2.
          {rtPassed && <> <span className="text-up">All 14 checks passed.</span> It only needs to run again if the Kraken code changes.</>}
        </Note>
        <details open={!rtPassed}>
          <summary className="cursor-pointer text-xs text-muted-foreground hover:text-foreground">{rtPassed ? "Show the test card (re-run, details)" : "Run the test"}</summary>
          <div className="mt-2"><RoundTripCard /></div>
        </details>
      </Step>

      <Step n={2} title="Paper gate — the live candidate has to prove itself" status={gateStatus} tone={gateTone}>
        <Note>
          Strategy under test: <strong className="font-medium text-foreground/85">{cand?.label ?? "high-conviction 5m/15m breakouts (selective)"}</strong>. All four must be green. Until then nothing trades real money.
        </Note>
        {cand ? (
          <div className="space-y-1.5">
            <GateRow label="Resolved trades" hint="enough of a sample" value={String(resolved)} target="30" ok={gate.n} />
            <GateRow label="Net result at live sizing" hint="it makes money after fees" value={`${net < 0 ? "−" : ""}$${Math.abs(Math.round(net)).toLocaleString()}`} target="> $0" ok={gate.net} />
            <GateRow label="Confidence (t)" hint="not luck" value={t == null ? "—" : t.toFixed(2)} target="2.00" ok={gate.t} />
            <GateRow label="Distinct days" hint="not one good day" value={String(days)} target="7" ok={gate.days} />
            <div className="flex flex-wrap items-center gap-2 pt-1 text-xs text-muted-foreground">
              Verdict <Chip tone={verdictTone(cand.verdict)}>{cand.verdict}</Chip>{cand.open > 0 && <span>· {cand.open} open now</span>}
            </div>
          </div>
        ) : <Note>No resolved trades for the live candidate yet.</Note>}
      </Step>

      <Step n={3} title="Arm — real money, one strategy, sized off the real account" status={armed ? `Armed · ${(cfg?.live.liveSources ?? []).join(", ") || "?"}` : "Disarmed"} tone={armed ? "red" : "grey"}>
        <Note>
          What arming means: {cfg ? <><strong className="font-medium text-foreground/85">the same sizing rule paper is scored with</strong>: {cfg.live.baseRiskPct}% of the account at risk per trade, {cfg.live.baseRiskPct * 2}% on high conviction{eq > 0 && <> (about ${Math.round(eq * cfg.live.baseRiskPct * 2 / 100).toLocaleString()} today)</>}. The candidate only takes high-conviction setups, so its live trades are the {cfg.live.baseRiskPct * 2}% ones; on today&apos;s account that is twice the account in size, so the executor fits the order to free margin (a little under {cfg.live.baseRiskPct * 2}% realised) until the 3× rung at $10k — at most {cfg.live.maxPositions} position{cfg.live.maxPositions === 1 ? "" : "s"} and {cfg.live.maxTradesPerDay} trades a day, a {cfg.live.stopPct}% stop that moves to breakeven and trails, and a {cfg.live.maxHoldH}-hour time limit</> : "loading…"}.
          Arming is deliberate: type ARM, then press. Every arm and disarm is logged and paged to Slack.
        </Note>
        <ArmControls rtPassed={rtPassed} gateOk={gateOk} />
        <details>
          <summary className="cursor-pointer text-xs text-muted-foreground hover:text-foreground">Show the live-vs-paper settings check</summary>
          <div className="mt-2"><LiveMirrorCard /></div>
        </details>
      </Step>
    </div>
  );
}

// The $20 round trip: one real trade through the real executor, to prove the Kraken
// behaviours the code assumes. Two clicks to start (arm the button, then send), because
// the second click moves real money. The guardian closes it within ~7 minutes.
function RoundTripCard() {
  const { data, mutate } = useSWR<RtView>("/api/margin/round-trip", fetcher, { refreshInterval: 20_000 });
  const [armed, setArmed] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const post = async (action: string) => {
    setBusy(action); setMsg(null);
    try {
      const r = await fetch("/api/margin/round-trip", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action, symbol: "BTC/USD" }) });
      const j = await r.json();
      setMsg(j.note ?? (r.ok ? "ok" : `error ${r.status}`));
      await mutate();
    } catch (e) { setMsg(String(e)); }
    finally { setBusy(null); setArmed(false); }
  };
  const st = data?.state ?? null;
  const running = st != null && ["entering", "open", "closing"].includes(st.stage);
  const stageTone: ChipTone = st?.stage === "done" ? (data?.verdict?.allOk ? "green" : "red") : running ? "amber" : st?.stage === "failed" ? "red" : "grey";
  return (
    <Panel className="bg-background/40">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-2.5">
        <h3 className="text-[13px] font-semibold">The $20 round trip</h3>
        <Chip tone={stageTone}>
          {!st ? "never run" : `${st.stage} · ${st.symbol}${st.stage === "done" && data?.verdict ? (data.verdict.allOk ? " · all checks passed" : ` · failed: ${data.verdict.failed.join(", ") || "incomplete"}`) : ""}`}
        </Chip>
      </div>
      <PanelBody className="space-y-3">
        <Note>
          Buys about $20 of BTC on 2× margin through the real executor path (every guard on), waits for the attached stop to appear, probes the
          API behaviours the guardian relies on, then closes through the real close path. Runs only while the executor is disarmed and the pair is
          empty. Cost: two market fees on $20 (a few cents) plus spread. Plumbing validation, not a strategy test — it does not move the paper gate.
        </Note>
        <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center">
          {!running && <button disabled={busy != null} onClick={() => post("dryrun")} className={btnGood}>{busy === "dryrun" ? "asking Kraken…" : "1 · Dry run (free — Kraken checks the order, places nothing)"}</button>}
          {!running && !armed && <button disabled={busy != null || !data?.dryRun?.ok} title={data?.dryRun?.ok ? "" : "run a clean dry run first"} onClick={() => setArmed(true)} className={btnPlain}>2 · Arm the $20 round trip…</button>}
          {!running && armed && (
            <>
              <button disabled={busy != null} onClick={() => post("start")} className={btnDanger}>{busy === "start" ? "sending…" : "Send the real $20 buy on BTC/USD"}</button>
              <button onClick={() => setArmed(false)} className={btnPlain}>cancel</button>
            </>
          )}
          {running && <button disabled={busy != null} onClick={() => post("advance")} className={btnPlain}>{busy === "advance" ? "checking…" : "run the checks now"}</button>}
          {running && <button disabled={busy != null} onClick={() => post("abort")} className={btnDanger}>{busy === "abort" ? "closing…" : "abort (close now)"}</button>}
          {msg && <span className="text-xs text-muted-foreground">{msg}</span>}
          {st?.error && <span className="text-xs text-down">{st.error}</span>}
        </div>
        {data?.dryRun && (
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <Chip tone={data.dryRun.ok ? "green" : "red"}>{data.dryRun.ok ? "Dry run passed" : "Dry run failed"}</Chip>
            <span className="text-muted-foreground">{timeOnly(data.dryRun.at)} · {data.dryRun.note}</span>
          </div>
        )}
        {data?.checklist && st && (
          <div className="-mx-4 border-t border-border">
            <DataTable dense>
              <tbody>
                {data.checklist.map((c) => (
                  <Row key={c.key}>
                    <Td className="w-8"><OkMark ok={c.result?.ok} /></Td>
                    <Td className="whitespace-normal">{c.label}</Td>
                    <Td muted className="whitespace-normal">{c.result?.note ?? ""}</Td>
                  </Row>
                ))}
              </tbody>
            </DataTable>
          </div>
        )}
        {st && st.log.length > 0 && (
          <details className="text-xs text-muted-foreground">
            <summary className="cursor-pointer">log ({st.log.length})</summary>
            <pre className="mt-1 whitespace-pre-wrap font-mono text-[11px]">{st.log.slice(-25).join("\n")}</pre>
          </details>
        )}
        {st?.fees && <Note>Fees: entry ${st.fees.entry.toFixed(4)} · exit ${st.fees.exit.toFixed(4)} · net after fees {st.fees.net != null ? `$${st.fees.net.toFixed(2)}` : "?"}.</Note>}
      </PanelBody>
    </Panel>
  );
}

// ── LIVE MIRRORS PAPER ── every number derived from the live config + the real account,
// beside what the paper record uses, with a check per item.
function LiveMirrorCard() {
  const { data: cfg } = useSWR<ExecCfg>("/api/margin/executor-config", fetcher, { refreshInterval: 60_000 });
  const money0 = (n: number | null) => (n == null ? "—" : usd0(Math.round(n)));
  return (
    <Panel className="bg-background/40">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-2.5">
        <h3 className="text-[13px] font-semibold">The live book — mirrors paper, sized off the real account</h3>
        {cfg && (
          <div className="flex flex-wrap items-center gap-1.5">
            <Chip tone={cfg.live.armed ? "red" : "grey"} dot={cfg.live.armed}>{cfg.live.armed ? "armed — real orders" : cfg.live.auto ? "validate-only" : "disarmed"}</Chip>
            <Chip tone="grey">sources: {cfg.live.liveSources?.length ? cfg.live.liveSources.join(", ") : "none"}</Chip>
            {cfg.live.ddBreakerTripped && <Chip tone="red">drawdown breaker tripped</Chip>}
            <Chip tone={cfg.allAligned ? "green" : "red"}>{cfg.allAligned ? "live = paper" : "live ≠ paper"}</Chip>
          </div>
        )}
      </div>
      {!cfg ? <PanelBody><Note>Loading live config…</Note></PanelBody> : (
        <>
          <DataTable>
            <thead>
              <tr>
                <Th>Setting</Th>
                <Th num>Paper (the record)</Th>
                <Th num>Live (what would trade)</Th>
                <Th num>Same?</Th>
              </tr>
            </thead>
            <tbody>
              <Row><Td>Risk per trade (base · high conviction · ceiling)</Td><Td num>{cfg.paper.baseRiskPct}% · {Math.min(6, cfg.paper.baseRiskPct * 2)}% · 6%</Td><Td num>{cfg.live.baseRiskPct}% · {Math.min(6, cfg.live.baseRiskPct * 2)}% · 6%</Td><Td num><span className="inline-flex justify-end"><OkMark ok={cfg.aligned.risk} /></span></Td></Row>
              <Row><Td>Initial stop</Td><Td num>{cfg.paper.stopPct}%</Td><Td num>{cfg.live.trailPct > 0 ? `Kraken trailing ${cfg.live.trailPct}%` : `${cfg.live.stopPct}%`}</Td><Td num><span className="inline-flex justify-end"><OkMark ok={cfg.aligned.stop} /></span></Td></Row>
              <Row><Td>Managed exit</Td><Td num className="whitespace-normal">{cfg.paper.exit}</Td><Td num className="whitespace-normal">{cfg.live.trailPct > 0 ? "Kraken trailing-stop (different)" : "guardian ratchets the resting stop the same way"}</Td><Td num><span className="inline-flex justify-end"><OkMark ok={cfg.aligned.exit} /></span></Td></Row>
              <Row><Td>Time stop</Td><Td num>{cfg.paper.maxHoldH}h</Td><Td num>{cfg.live.maxHoldH}h</Td><Td num><span className="inline-flex justify-end"><OkMark ok={cfg.aligned.hold} /></span></Td></Row>
              <Row><Td>Sizing</Td><Td num className="whitespace-normal">risk × ${cfg.paper.refEquity.toLocaleString()} ÷ stop, ≤ leverage × equity</Td><Td num className="whitespace-normal">risk × {cfg.equity != null ? money0(cfg.equity) : "equity"} ÷ stop, ≤ {cfg.leverageRung}× equity{cfg.live.perTradeCapUsd > 0 ? ` · capped ${money0(cfg.live.perTradeCapUsd)}/trade` : ""}</Td><Td num><span className="inline-flex justify-end"><OkMark ok={cfg.aligned.sizing} /></span></Td></Row>
              <Row><Td>Guards (live only)</Td><Td num muted>—</Td><Td num className="whitespace-normal">max {cfg.live.maxPositions} positions · {cfg.live.maxTradesPerDay}/day · 15% drawdown breaker · daily loss cap</Td><Td num muted>n/a</Td></Row>
            </tbody>
          </DataTable>
          <PanelBody className="space-y-2 border-t border-border">
            <Note>
              <strong className="font-medium text-foreground/85">Grows with the account.</strong> Live sizes off the real Kraken equity
              {cfg.equity != null ? <> (<span className="text-foreground/85">{money0(cfg.equity)}</span> at the guardian&apos;s last run{cfg.equityAt ? `, ${ago(cfg.equityAt)}` : ""})</> : " (not read yet)"}, so dollar risk and position size rise as capital does at the same 3%:
              {" "}{cfg.tiers.map((t) => `${t.tier} conviction risks ${money0(t.riskUsd)} on ${money0(t.notionalUsd)}`).join(" · ")}.
              The leverage cap steps up with equity — {cfg.ladder.map((l) => `${l.cap}× from $${l.from.toLocaleString()}`).join(", ")} — and is <span className="text-foreground/85">{cfg.leverageRung}×</span> at today&apos;s equity (operator ceiling {cfg.live.maxLeverageCeiling}×).
              Paper stays scored at a fixed ${cfg.paper.refEquity.toLocaleString()} so its t-stats stay comparable — compounding paper equity into the verdict would fake an edge.
            </Note>
            <Note>
              Thousands a day at 3% still needs a larger account (~$50k+). Do not crank risk on $5k to fake the daily number. Live stays unarmed until a sleeve prints
              {" "}<span className="text-foreground/85">REAL EDGE</span> (30+ resolved, net &gt; 0 at live sizing, t ≥ 2, 7+ days).
            </Note>
          </PanelBody>
        </>
      )}
    </Panel>
  );
}
