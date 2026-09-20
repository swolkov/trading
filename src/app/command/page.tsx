"use client";

import useSWR from "swr";
import { Chip, type ChipTone } from "@/components/ui/chip";
import { Note, PageHeader, Panel, PanelBody, PanelHeader } from "@/components/ui/panel";
import type { FuturesHealth } from "@/lib/futures-health";
import { ago } from "@/lib/format";

interface CommandData {
  room?: { lastTickAt: string | null; lastError: string | null; liveOk: boolean; liveAt: string | null; levelsAt: string | null; breakAt: string | null };
  futures: FuturesHealth;
  heartbeats: { tradingViewAlert: string | null };
  paper: {
    optionsScan: string | null;
    stockScan: string | null;
    optionsAutotrack: boolean;
    stockAutotrack: boolean;
    robinhood: {
      liveDesk?: { armed: boolean; verified: boolean; guardianAt: string | null; guardianFresh: boolean };
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
        <PageHeader title="System Health" sub="Desk heartbeats — refreshes every 30s" />
        <Panel tone="red"><PanelBody>
          <p className="text-[13px] font-semibold text-down">Health check failed to read state</p>
          <p className="mt-1 break-words text-xs text-down/80">{data.error}</p>
        </PanelBody></Panel>
      </div>
    );
  }

  const hb = data.heartbeats;
  const rh = data.paper.robinhood;

  return (
    <div className="space-y-5">
      <PageHeader
        title="System Health"
        sub="The Trading Room (your live account, read-only), Robinhood options and the futures demo desk. Refreshes every 30s"
      />

      <Panel>
        <PanelHeader title="Trading Room · your live Tradovate account" aside={<Chip tone={data.room?.liveOk ? "green" : "red"} dot={data.room?.liveOk}>{data.room?.liveOk ? "Account readable" : "Account not read"}</Chip>} />
        <PanelBody className="divide-y divide-border">
          <HealthRow label="Room tick" sub="Every 5 minutes, Sunday evening through Friday: card, live read, ledger, journal. Red after two missed ticks."
            chip={<Chip tone={ageTone(data.room?.lastTickAt ?? null, 12, 30)}>{data.room?.lastTickAt ? ago(data.room.lastTickAt) : "never"}</Chip>}>
            {data.room?.lastError && <span className="text-down">last error: {data.room.lastError}</span>}
          </HealthRow>
          <HealthRow label="Live account read" sub="Balance, positions and fills from Tradovate. The room has no order path."
            chip={<Chip tone={data.room?.liveOk ? ageTone(data.room.liveAt, 12, 30) : "red"}>{data.room?.liveAt ? ago(data.room.liveAt) : "never"}</Chip>} />
          <HealthRow label="Chart levels from TradingView" sub="The Pine study posts its level set every confirmed 5-minute bar inside RTH. Quiet outside RTH and on weekends is normal."
            chip={<Chip tone={data.room?.levelsAt ? ageTone(data.room.levelsAt, 15, 60 * 24 * 3) : "grey"}>{data.room?.levelsAt ? ago(data.room.levelsAt) : "never"}</Chip>} />
          <HealthRow label="Last level break on the tape" sub="Posted by the chart when price closes through a level inside RTH."
            chip={<Chip tone={data.room?.breakAt ? "green" : "grey"}>{data.room?.breakAt ? ago(data.room.breakAt) : "none yet"}</Chip>} />
        </PanelBody>
      </Panel>

      <Panel>
        <PanelHeader title="Heartbeats" />
        <PanelBody className="divide-y divide-border">
          <HealthRow label="TradingView alert" sub="last webhook received" chip={<Chip tone={hb.tradingViewAlert ? "green" : "grey"}>{hb.tradingViewAlert ? ago(hb.tradingViewAlert) : "none yet"}</Chip>} />
        </PanelBody>
      </Panel>

      <Panel>
        <PanelHeader title="Robinhood options · live desk" aside={<Chip tone={rh.liveDesk?.armed && rh.liveDesk.verified ? "red" : rh.liveDesk?.armed ? "amber" : "grey"} dot={!!(rh.liveDesk?.armed && rh.liveDesk.verified)}>{rh.liveDesk?.armed && rh.liveDesk.verified ? "Live: armed and verified" : rh.liveDesk?.armed ? "Armed, adapter unverified" : "Live execution inactive"}</Chip>} />
        <PanelBody className="divide-y divide-border">
          <HealthRow label="Real account snapshot" sub="Collected after each weekday close; this is not a live position monitor."
            chip={<Chip tone={ageTone(rh.liveAt, 60 * 30, 60 * 50)}>{rh.liveAt ? ago(rh.liveAt) : "never"}</Chip>}>
            {rh.liveAt && <span>{rh.livePositions} positions · {rh.liveOrders} orders</span>}
          </HealthRow>
          <HealthRow label="Options permission" chip={<Chip tone={rh.optionLevel === "option_level_3" ? "green" : "grey"}>{rh.optionLevel === "option_level_3" ? "Level 3" : rh.optionLevel ?? "unknown"}</Chip>} />
          <HealthRow label="Live desk switch" sub="Typed ARM on the Live Account page. Real money: every name that clears the screen, up to three at once, inside the approved cap."
            chip={<Chip tone={rh.liveDesk?.armed ? "red" : "grey"}>{rh.liveDesk?.armed ? "Armed" : "Disarmed"}</Chip>} />
          <HealthRow label="Broker adapter" sub="Verified only after a real broker review decoded fees and buying power. Unverified = the desk refuses to place."
            chip={<Chip tone={rh.liveDesk?.verified ? "green" : "amber"}>{rh.liveDesk?.verified ? "Verified" : "Unverified"}</Chip>} />
          <HealthRow label="Desk guardian" sub="Every 5 minutes in the regular session, on Railway. Silence outside the session is normal."
            chip={<Chip tone={rh.liveDesk?.guardianFresh ? "green" : "grey"}>{rh.liveDesk?.guardianFresh ? "Reporting" : "Not reporting"}</Chip>}>
            <span>{rh.liveDesk?.guardianAt ? ago(rh.liveDesk.guardianAt) : "has not run"}</span>
          </HealthRow>
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
          <HealthRow label="Drawdown tier · open risk · daily loss left" sub="From the guardian's risk snapshot. Tier 1–3 shrink the budget (×0.75 / ×0.5 / ×0.25); tier 4 halts the desk."
            chip={<Chip tone={data.futures.desk.ddTier == null ? "grey" : data.futures.desk.ddTier >= 2 ? "red" : data.futures.desk.ddTier === 1 ? "amber" : "green"}>{data.futures.desk.ddTier == null ? "—" : `tier ${data.futures.desk.ddTier}`}</Chip>}>
            <span>open risk {data.futures.desk.openRisk != null ? `$${Math.round(data.futures.desk.openRisk).toLocaleString()}` : "—"} · daily loss left {data.futures.desk.dailyLossRemaining != null ? `$${Math.round(data.futures.desk.dailyLossRemaining).toLocaleString()}` : "—"}</span>
          </HealthRow>
          <HealthRow label="Event mode · feed heartbeat" sub="Paused refuses entries; reduced halves the budget. A stale TradingView heartbeat (180 CME-open minutes) reads NO TRADE but does not refuse."
            chip={<Chip tone={data.futures.desk.eventMode === "paused" ? "red" : data.futures.desk.eventMode === "reduced" ? "amber" : data.futures.desk.eventMode ? "green" : "grey"}>{data.futures.desk.eventMode ?? "no policy"}</Chip>}>
            <span>feed {data.futures.desk.feedStale ? "STALE" : "live"} · last seen {data.futures.desk.feedSeenAt ? ago(data.futures.desk.feedSeenAt) : "never"}</span>
          </HealthRow>
          {data.futures.desk.anomaly && (
            <HealthRow label="Anomaly — entries paused" chip={<Chip tone="red">Clear on /futures</Chip>}><span>{data.futures.desk.anomaly}</span></HealthRow>
          )}
          {data.futures.desk.lastError && (
            <HealthRow label="Last desk error" chip={<Chip tone="amber">Inspect</Chip>}><span>{data.futures.desk.lastError}</span></HealthRow>
          )}
          <HealthRow label="Retired Railway engines" sub="Closed for good (Sep 2026). Any heartbeat here means a process that should be dead is running."
            chip={<Chip tone={data.futures.paper.fresh || data.futures.live.fresh ? "red" : "grey"}>{data.futures.paper.fresh || data.futures.live.fresh ? "Reporting: shut it down" : "Silent"}</Chip>} />
          <Note className="pt-3">The desk trades only when TradingView sends it an alert: the two Pine rules must be loaded on real-time CME data with alerts pointed at the webhook. A green guardian with no alerts is a desk waiting, not a desk broken.</Note>
        </PanelBody>
      </Panel>

      <Note>The Kraken margin desk, the spot trend bot and the stock paper book were all retired (Sep 2026); their machinery is no longer monitored here.</Note>
    </div>
  );
}
