"use client";

import useSWR from "swr";
import { Chip, type ChipTone } from "@/components/ui/chip";
import { Note, PageHeader, Panel, PanelBody, PanelHeader } from "@/components/ui/panel";
import { ago, minutesSince } from "@/lib/format";

// ============ SYSTEM HEALTH ============
// Kraken MARGIN era (spot trend bot retired Aug 2026). One job: prove the LIVE machinery is
// alive — the margin scanner + guardian crons, trade sync, the webhook — and go amber/red the
// moment any piece stops writing its heartbeat. Plus the executor's real-money arm-state.

interface CommandData {
  heartbeats: {
    marginScan: string | null;
    marginWatch: string | null;
    tradeSync: string | null;
    tradingViewAlert: string | null;
  };
  config: { marginAuto: boolean; marginValidateOnly: boolean; shadowAutotrack: boolean; drawdownDisarmed: boolean };
  execLock: { held: boolean; since: string | null };
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

  return (
    <div className="space-y-5">
      <PageHeader
        title="System Health"
        sub="Kraken margin machinery heartbeats — refreshes every 30s"
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

      <Note>The spot trend bot was retired; its machinery is no longer monitored here.</Note>
    </div>
  );
}
