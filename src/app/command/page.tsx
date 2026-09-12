"use client";

import useSWR from "swr";
import { Chip, type ChipTone } from "@/components/ui/chip";
import { Note, PageHeader, Panel, PanelBody, PanelHeader } from "@/components/ui/panel";
import type { FuturesHealth } from "@/lib/futures-health";
import { ago, minutesSince } from "@/lib/format";

interface CommandData {
  futures: FuturesHealth;
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
      barsNewestDay: string | null; barsStale: boolean; barsStaleSymbols: number;
      liveAt: string | null; livePositions: number; liveOrders: number; liveForeignOrders: number;
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
        sub="Kraken, Robinhood and futures paper readiness. Refreshes every 30s"
        right={<Chip tone={armed ? "red" : "grey"} dot={armed} size="md">{armed ? "Kraken armed: real orders" : "Kraken entries disarmed"}</Chip>}
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

      <Panel>
        <PanelHeader title="Robinhood account connection" aside={<Chip tone="amber">Live execution inactive</Chip>} />
        <PanelBody className="divide-y divide-border">
          <HealthRow label="Real account snapshot" sub="Collected after each weekday close; this is not a live position monitor."
            chip={<Chip tone={ageTone(rh.liveAt, 60 * 30, 60 * 50)}>{rh.liveAt ? ago(rh.liveAt) : "never"}</Chip>}>
            {rh.liveAt && <span>{rh.livePositions} positions · {rh.liveOrders} orders</span>}
          </HealthRow>
          <HealthRow label="Options permission" chip={<Chip tone={rh.optionLevel === "option_level_3" ? "green" : "grey"}>{rh.optionLevel === "option_level_3" ? "Level 3" : rh.optionLevel ?? "unknown"}</Chip>} />
        </PanelBody>
      </Panel>

      <Panel>
        <PanelHeader title="Tradovate futures · demo desk" aside={<Chip tone="paper">Paper only, by design</Chip>} />
        <PanelBody className="divide-y divide-border">
          <HealthRow label="Desk switch" sub="Typed ENABLE on the Futures Desk page. Off = alerts are recorded, nothing is sent to the demo."
            chip={<Chip tone={data.futures.desk.enabled ? "green" : "grey"}>{data.futures.desk.enabled ? "Enabled" : "Disabled"}</Chip>}>
            {data.futures.desk.disabledReason && <span>{data.futures.desk.disabledReason}</span>}
          </HealthRow>
          <HealthRow label="Desk guardian" sub="Every 5 minutes. The desk refuses entries when it has not run in 20 minutes."
            chip={<Chip tone={data.futures.desk.guardianFresh ? "green" : "red"}>{data.futures.desk.guardianFresh ? "Reporting" : "Not reporting"}</Chip>}>
            <span>{data.futures.desk.guardianAt ? ago(data.futures.desk.guardianAt) : "No valid timestamp"}</span>
          </HealthRow>
          <HealthRow label="Broker and webhook credentials" sub="Tradovate demo login and the TradingView webhook secret on this server."
            chip={<Chip tone={data.futures.desk.configured ? "green" : "red"}>{data.futures.desk.configured ? "Present" : "Missing"}</Chip>} />
          <HealthRow label="CME session" sub="Sun 18:00 → Fri 17:00 ET with a daily 17:00–18:00 break. Alerts that land in a break are queued for the reopen."
            chip={<Chip tone={data.futures.desk.cmeOpen ? "blue" : "grey"}>{data.futures.desk.cmeOpen ? "Open" : "Closed"}</Chip>} />
          <HealthRow label="Demo equity (guardian's last read)" sub="Sizing uses the fixed $50k basis, not this number."
            chip={<Chip tone="grey">{data.futures.desk.equity != null ? `$${Math.round(data.futures.desk.equity).toLocaleString()}` : "—"}</Chip>} />
          {data.futures.desk.lastError && (
            <HealthRow label="Last desk error" chip={<Chip tone="amber">Inspect</Chip>}><span>{data.futures.desk.lastError}</span></HealthRow>
          )}
          <HealthRow label="Retired Railway engines" sub="Closed for good (Sep 2026). Any heartbeat here means a process that should be dead is running."
            chip={<Chip tone={data.futures.paper.fresh || data.futures.live.fresh ? "red" : "grey"}>{data.futures.paper.fresh || data.futures.live.fresh ? "Reporting: shut it down" : "Silent"}</Chip>} />
          <Note className="pt-3">The desk trades only when TradingView sends it an alert: the two Pine rules must be loaded on real-time CME data with alerts pointed at the webhook. A green guardian with no alerts is a desk waiting, not a desk broken.</Note>
        </PanelBody>
      </Panel>

      <Note>The spot trend bot and the stock paper book were both retired; their machinery is no longer monitored here.</Note>
    </div>
  );
}
