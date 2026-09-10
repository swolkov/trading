"use client";

import useSWR from "swr";
import { Chip, type ChipTone } from "@/components/ui/chip";
import { Note, PageHeader, Panel, PanelBody, PanelHeader } from "@/components/ui/panel";
import { ago, minutesSince } from "@/lib/format";

// ============ SYSTEM HEALTH ============
// Two jobs now.
//
// KRAKEN (real money): prove the live machinery is alive — the margin scanner + guardian
// crons, trade sync, the webhook — and go amber/red the moment any piece stops writing its
// heartbeat. Plus the executor's arm-state.
//
// ROBINHOOD OPTIONS (paper): prove the quote inbox is still being fed. That book's data path
// is a scheduled agent on Spencer's Mac, because Robinhood has no server credentials. If the
// agent stops, the book freezes silently — positions stop marking, stops go unchecked, and
// every page still renders perfectly. The options page carries its own banner, but nobody
// watches a paper page daily. It belongs here, next to the crons, for the same reason.

interface CommandData {
  heartbeats: {
    marginScan: string | null;
    marginWatch: string | null;
    tradeSync: string | null;
    tradingViewAlert: string | null;
  };
  config: { marginAuto: boolean; marginValidateOnly: boolean; shadowAutotrack: boolean; drawdownDisarmed: boolean };
  execLock: { held: boolean; since: string | null };
  paper: {
    optionsScan: string | null;
    stockScan: string | null;
    optionsAutotrack: boolean;
    stockAutotrack: boolean;
    robinhood: {
      newestQuoteTs: string | null; quoteAgeMinutes: number | null; quotesStale: boolean;
      quoteRows: number; openPositions: number; optionLevel: string | null; accountAt: string | null;
    };
  };
  error?: string;
}

const fetcher = (u: string) => fetch(u).then((r) => r.json());

function ageTone(isoDate: string | null, warnMin: number, critMin: number): ChipTone {
  if (!isoDate) return "grey";
  const t = new Date(isoDate).getTime();
  if (!Number.isFinite(t)) return "grey";
  const age = (Date.now() - t) / 60000;
  return age < warnMin ? "green" : age < critMin ? "amber" : "red";
}

function HealthRow({ label, sub, chip, children }: { label: string; sub?: string; chip?: React.ReactNode; children?: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 py-2 first:pt-0 last:pb-0">
      <div className="min-w-0">
        <p className="text-[13px]">{label}</p>
        {sub && <p className="text-xs text-muted-foreground">{sub}</p>}
      </div>
      <div className="flex shrink-0 items-center gap-2 text-xs text-muted-foreground tabular-nums">{children}{chip}</div>
    </div>
  );
}

export default function SystemHealthPage() {
  const { data, isLoading } = useSWR<CommandData>("/api/command", fetcher, { refreshInterval: 30000 });

  if (isLoading || !data) {
    return (
      <div className="flex h-64 items-center justify-center">
        <div className="h-6 w-6 animate-spin rounded-full border-2 border-primary border-t-transparent" />
      </div>
    );
  }

  if (data.error) {
    return (
      <div className="space-y-5">
        <PageHeader title="System Health" sub="Kraken machinery heartbeats — refreshes every 30s" />
        <Panel tone="red"><PanelBody>
          <p className="text-[13px] font-semibold text-down">Health check failed to read state</p>
          <p className="mt-1 break-words text-xs text-down/80">{data.error}</p>
        </PanelBody></Panel>
      </div>
    );
  }

  const hb = data.heartbeats;
  // Thresholds follow each job's real cadence: scan/watch */5 → amber 20m/red 60m.
  const rows = [
    { label: "Margin scanner", sub: "runs every 5 min", at: hb.marginScan, tone: ageTone(hb.marginScan, 20, 60) },
    { label: "Margin guardian", sub: "runs every 5 min", at: hb.marginWatch, tone: ageTone(hb.marginWatch, 20, 60) },
    { label: "Trade sync", sub: "fills from Kraken ledger", at: hb.tradeSync, tone: ageTone(hb.tradeSync, 90, 360) },
  ];

  // The margin exec lock is only held while placing a real order; alarming if it outlives 330s TTL.
  const lockAgeMin = minutesSince(data.execLock.since);
  const lockStuck = data.execLock.held && lockAgeMin > 6;
  const armed = data.config.marginAuto && !data.config.marginValidateOnly;

  const switches: { label: string; on: boolean; onText: string; offText: string; onTone: ChipTone; offTone: ChipTone }[] = [
    { label: "Margin auto-trade", on: data.config.marginAuto, onText: "armed", offText: "tracked only", onTone: "red", offTone: "green" },
    { label: "Real orders", on: !data.config.marginValidateOnly, onText: "live", offText: "validate-only", onTone: "red", offTone: "green" },
    { label: "Shadow auto-track", on: data.config.shadowAutotrack, onText: "on", offText: "off", onTone: "green", offTone: "grey" },
    { label: "Drawdown breaker", on: data.config.drawdownDisarmed, onText: "tripped", offText: "clear", onTone: "red", offTone: "green" },
  ];

  const rh = data.paper.robinhood;

  return (
    <div className="space-y-5">
      <PageHeader
        title="System Health"
        sub="Kraken margin machinery and the Robinhood options feed — refreshes every 30s"
        right={<Chip tone={armed ? "red" : "grey"} dot={armed} size="md">{armed ? "Executor armed — real orders" : "Paper / tracked — no real money"}</Chip>}
      />

      {lockStuck && (
        <Panel tone="red"><PanelBody>
          <p className="text-[13px] font-semibold text-down">Exec lock stuck</p>
          <Note className="mt-1">Held since {data.execLock.since} ({lockAgeMin.toFixed(0)}m — TTL is 5.5m). A real-order run likely died mid-flight; the next call recovers it, but check Vercel logs if this persists.</Note>
        </PanelBody></Panel>
      )}

      <div className="grid gap-3 lg:grid-cols-2">
        <Panel>
          <PanelHeader title="Heartbeats" />
          <PanelBody className="divide-y divide-border">
            {rows.map((r) => (
              <HealthRow key={r.label} label={r.label} sub={r.sub} chip={<Chip tone={r.tone} dot={r.tone === "red"}>{r.at ? ago(r.at) : "never"}</Chip>} />
            ))}
            <HealthRow label="TradingView alert" sub="last webhook received" chip={<Chip tone={hb.tradingViewAlert ? "green" : "grey"}>{hb.tradingViewAlert ? ago(hb.tradingViewAlert) : "none yet"}</Chip>} />
          </PanelBody>
        </Panel>

        <Panel>
          <PanelHeader title="Switches" />
          <PanelBody className="divide-y divide-border">
            {switches.map((s) => (
              <HealthRow key={s.label} label={s.label} chip={<Chip tone={s.on ? s.onTone : s.offTone} dot={s.on && s.onTone === "red"}>{s.on ? s.onText : s.offText}</Chip>} />
            ))}
            <HealthRow label="Margin exec lock" chip={<Chip tone={lockStuck ? "red" : data.execLock.held ? "amber" : "grey"}>{data.execLock.held ? `held ${lockAgeMin.toFixed(0)}m` : "released"}</Chip>} />
          </PanelBody>
        </Panel>
      </div>

      <Panel tone={rh.quotesStale ? "red" : undefined}>
        <PanelHeader
          title="Options paper book — Robinhood"
          aside={
            <Chip tone={rh.quotesStale ? "red" : "green"} dot={rh.quotesStale} size="md">
              {rh.newestQuoteTs ? `quotes ${ago(rh.newestQuoteTs)}` : "no quotes ever pushed"}
            </Chip>
          }
        />
        <PanelBody className="divide-y divide-border">
          <HealthRow
            label="Quote inbox"
            sub="pushed by the scheduled agent — weekdays 17:32 after the close"
            chip={<Chip tone={rh.quotesStale ? "red" : "green"} dot={rh.quotesStale}>{rh.newestQuoteTs ? ago(rh.newestQuoteTs) : "never"}</Chip>}
          >
            {rh.quoteRows > 0 && <span>{rh.quoteRows} contracts</span>}
          </HealthRow>
          <HealthRow
            label="Options scan"
            sub="daily cron, 6pm ET"
            chip={<Chip tone={ageTone(data.paper.optionsScan, 60 * 30, 60 * 50)}>{data.paper.optionsScan ? ago(data.paper.optionsScan) : "never"}</Chip>}
          />
          <HealthRow
            label="Open paper positions"
            chip={<Chip tone={rh.openPositions > 0 ? "blue" : "grey"}>{rh.openPositions}</Chip>}
          />
          <HealthRow
            label="Account snapshot"
            sub={rh.optionLevel === "option_level_3" ? "Level 3 — spreads available" : rh.optionLevel === "option_level_2" ? "Level 2 — long premium only" : undefined}
            chip={<Chip tone={rh.accountAt ? "green" : "grey"}>{rh.accountAt ? ago(rh.accountAt) : "never"}</Chip>}
          />
          <HealthRow
            label="New paper entries"
            chip={<Chip tone={data.paper.optionsAutotrack ? "green" : "amber"}>{data.paper.optionsAutotrack ? "tracking" : "paused"}</Chip>}
          />
        </PanelBody>
        {rh.quotesStale && (
          <PanelBody className="pt-0">
            <Note className="text-down">
              The quote inbox is stale, so this book is frozen rather than quiet: positions are not marking and no entry can open.
              Robinhood cannot be read from the server — check the agent on the Mac
              (<code>launchctl print gui/$(id -u)/com.esbueno.options-desk</code>) and that its login is still authenticated.
            </Note>
          </PanelBody>
        )}
      </Panel>

      <Note>The spot trend bot and the stock paper book were both retired; their machinery is no longer monitored here.</Note>
    </div>
  );
}
