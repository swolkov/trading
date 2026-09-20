"use client";

import { useState } from "react";
import { Chip } from "@/components/ui/chip";
import { Explainer, Panel, PanelBody, PanelHeader } from "@/components/ui/panel";
import type { RoomSettings } from "@/lib/trading-room-rules";

// HIS SIZE and his daily loss line (the only things on the page Spencer edits) and the TradingView setup card.

export function SettingsPanel({ settings, onSaved }: { settings: RoomSettings; onSaved: () => void }) {
  const [contracts, setContracts] = useState(String(settings.contracts));
  const [daily, setDaily] = useState(settings.dailyLossUsd != null ? String(settings.dailyLossUsd) : "");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  async function save() {
    setBusy(true); setMsg(null);
    try {
      const r = await fetch("/api/trade", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "settings", contracts: Number(contracts) || settings.contracts, dailyLossUsd: daily.trim() ? Number(daily) : null }) });
      const j = await r.json();
      setMsg(r.ok ? "Saved." : j.error ?? "not saved");
      if (r.ok) onSaved();
    } catch (e) { setMsg(String(e)); } finally { setBusy(false); }
  }
  return (
    <Panel>
      <PanelHeader title="Your size" aside={<span>what you trade · the cards above price every stop at this size</span>} />
      <PanelBody>
        <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
          <label className="text-xs text-muted-foreground">Contracts per market
            <input value={contracts} onChange={(e) => setContracts(e.target.value)} inputMode="numeric" className="mt-1 h-8 w-full rounded-md border border-border bg-background px-2 text-[13px] text-foreground" />
            <span className="mt-0.5 block text-[11px]">micros — MES, MNQ, MGC</span>
          </label>
          <label className="text-xs text-muted-foreground">Daily loss line ($) · optional
            <input value={daily} onChange={(e) => setDaily(e.target.value)} placeholder="your own number" inputMode="decimal" className="mt-1 h-8 w-full rounded-md border border-border bg-background px-2 text-[13px] text-foreground" />
            <span className="mt-0.5 block text-[11px]">when set, the room tells you the moment the day&apos;s realized loss crosses it</span>
          </label>
          <div className="flex items-end gap-2">
            <button onClick={save} disabled={busy} className="h-8 rounded-md bg-primary px-3 text-[13px] font-semibold text-primary-foreground disabled:opacity-50">{busy ? "Saving…" : "Save"}</button>
            {msg && <span className="text-xs text-muted-foreground">{msg}</span>}
          </div>
        </div>
      </PanelBody>
    </Panel>
  );
}

export function SetupPanel({ webhookUrl }: { webhookUrl: string }) {
  const [copied, setCopied] = useState<string | null>(null);
  async function copyPine() {
    try {
      const r = await fetch("/api/trade/pine"); const text = await r.text();
      await navigator.clipboard.writeText(text); setCopied("Pine script copied — paste into the Pine Editor and Add to chart.");
    } catch (e) { setCopied(`could not copy: ${String(e)}`); }
  }
  return (
    <Panel>
      <PanelHeader title="TradingView setup" aside={<Chip tone="paper">one-time, ~5 minutes per chart</Chip>} />
      <PanelBody className="space-y-2 text-[13px]">
        <ol className="list-decimal space-y-1 pl-5">
          <li>Open MES1!, MNQ1! and MGC1! on the <strong>5-minute</strong> chart.</li>
          <li><button onClick={copyPine} className="rounded-md border border-border px-2 py-0.5 text-xs font-semibold hover:bg-accent">Copy the Pine script</button> → Pine Editor → paste → <em>Add to chart</em>. {copied && <span className="text-muted-foreground">{copied}</span>}</li>
          <li>Nothing to configure: the room&apos;s own webhook secret is built into the study, and the session picks itself by symbol (gold 08:20–13:30, indices 09:30–16:00).</li>
          <li>Create <strong>one alert per symbol</strong>: condition <em>Trading Room — levels → Any alert() function call</em>, expiration open-ended, notifications → Webhook URL <code>{webhookUrl}</code>, message left empty.</li>
        </ol>
        <Explainer title="What the study draws and posts">
          Prior exchange-day high/low/close (orange), overnight high/low (aqua, frozen at the RTH open), the running week&apos;s high/low (purple), the 15-minute opening range (yellow, once formed), session VWAP (white). At each 5-minute close inside RTH it posts a level break to this room — at most one per kind every 30 minutes. The admin card uses the same definitions, built from Yahoo bars (about 10 minutes delayed), so the chart is the real-time source and this page is the reference copy.
        </Explainer>
      </PanelBody>
    </Panel>
  );
}
