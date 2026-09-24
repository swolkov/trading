"use client";

import { useEffect, useState, type ReactNode } from "react";
import useSWR from "swr";
import { Chip } from "@/components/ui/chip";
import { Panel } from "@/components/ui/panel";
import { ago } from "@/lib/format";
import { mmss, untilText, type DayRulesView } from "@/lib/day-rules";

// HIS DAY RULES AT A GLANCE — read-only, from GET /api/trade/rules (the co-pilot's own saved state). The co-pilot
// is the only thing that enforces them, and only as Slack messages; this strip just shows where the day stands.

const fetcher = (u: string) => fetch(u).then((r) => r.json());

function Item({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-center gap-1.5">
      <span className="num text-[10px] font-medium uppercase tracking-[0.12em] text-muted-foreground">{label}</span>
      {children}
    </div>
  );
}

export function DayRulesStrip() {
  const { data } = useSWR<DayRulesView & { error?: string }>("/api/trade/rules", fetcher, { refreshInterval: 15_000 });
  // A local one-second clock for the countdowns; the counts themselves refresh with the co-pilot (every 15 s).
  const [nowMs, setNowMs] = useState(0);
  useEffect(() => {
    const tick = () => setNowMs(Date.now());
    tick();
    const id = setInterval(tick, 1_000);
    return () => clearInterval(id);
  }, []);

  if (!data) return null;
  if (data.error) return <div className="rounded-lg border border-warn/40 bg-warn/10 px-3 py-2 text-xs text-warn">Day rules unavailable: {data.error}</div>;

  const now = nowMs || data.atMs;
  const w = data.window;
  const windowText = w.open
    ? `OPEN${w.closesAtMs ? ` · closes in ${untilText(w.closesAtMs - now)}` : ""}`
    : `CLOSED${w.opensAtMs ? ` · opens in ${untilText(w.opensAtMs - now)}` : ""}`;
  const cooldownLeft = data.cooldownUntilMs != null ? data.cooldownUntilMs - now : 0;
  const handsOff = data.handsOff.filter((h) => h.untilMs > now);
  const tradesHit = data.trades != null && data.trades >= data.maxTrades;
  const lossesHit = data.losses != null && data.losses >= data.maxLosses;

  return (
    <Panel tone={data.done ? "red" : undefined}>
      <div className="flex flex-wrap items-center gap-x-5 gap-y-2 px-4 py-2.5">
        <span className="text-[13px] font-semibold tracking-[-0.01em]">Day rules</span>
        <Item label="Window 9:30–2 PM ET">
          <Chip tone={w.open ? "green" : "grey"} dot={w.open}>{windowText}</Chip>
        </Item>
        <Item label="Trades">
          <Chip tone={tradesHit ? "red" : "grey"}>{data.trades ?? "—"} / {data.maxTrades}</Chip>
        </Item>
        <Item label="Losses">
          <Chip tone={lossesHit ? "red" : data.losses ? "amber" : "grey"}>{data.losses ?? "—"} / {data.maxLosses}</Chip>
        </Item>
        {data.done && <Chip tone="red" size="md" title={data.doneReason ?? undefined}>Done for the day</Chip>}
        <Item label="Cooldown">
          {cooldownLeft > 0 ? <Chip tone="amber" dot>{mmss(cooldownLeft)} after a loss</Chip> : <Chip>none</Chip>}
        </Item>
        {handsOff.map((h) => (
          <Item key={h.symbol} label={`Hands off ${h.symbol}`}>
            <Chip tone="blue">{mmss(h.untilMs - now)}</Chip>
          </Item>
        ))}
        <Item label="Instrument">
          <Chip tone="blue">{data.planSymbol} only</Chip>
        </Item>
        <span className="ml-auto">
          <Chip
            tone={!data.copilot.enabled || data.copilot.stale ? "amber" : "grey"}
            title={data.copilot.lastError ?? "Counts come from the co-pilot, which reads your live account every 15 seconds."}
          >
            {!data.copilot.enabled ? "co-pilot off · counts frozen" : data.copilot.lastOkMs ? `co-pilot read ${ago(new Date(data.copilot.lastOkMs).toISOString())}` : "co-pilot never ran"}
          </Chip>
        </span>
      </div>
    </Panel>
  );
}
