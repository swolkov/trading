"use client";

import { useState } from "react";
import { Chip } from "@/components/ui/chip";
import { Explainer, Note, Panel, PanelBody, PanelHeader } from "@/components/ui/panel";
import { money } from "@/lib/format";
import type { RoomSettings } from "@/lib/trading-room-rules";

// THE SIZING RULE (the only thing on the page Spencer edits) and the TradingView setup card.

export function SettingsPanel({ settings, liveNetLiq, onSaved }: { settings: RoomSettings; liveNetLiq: number | null; onSaved: () => void }) {
  const [account, setAccount] = useState(settings.accountUsd != null ? String(settings.accountUsd) : "");
  const [risk, setRisk] = useState(String(settings.riskPct));
  const [daily, setDaily] = useState(settings.dailyLossUsd != null ? String(settings.dailyLossUsd) : "");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  async function save() {
    setBusy(true); setMsg(null);
    try {
      const r = await fetch("/api/trade", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "settings", accountUsd: account.trim() ? Number(account) : null, riskPct: Number(risk) || 1, dailyLossUsd: daily.trim() ? Number(daily) : null }) });
      const j = await r.json();
      setMsg(r.ok ? "Saved." : j.error ?? "not saved");
      if (r.ok) onSaved();
    } catch (e) { setMsg(String(e)); } finally { setBusy(false); }
  }
  const effective = account.trim() ? Number(account) : liveNetLiq;
  const riskUsd = effective && Number(risk) ? effective * Number(risk) / 100 : null;
  return (
    <Panel>
      <PanelHeader title="Your sizing rule" aside={<span>account × risk % = dollars at risk per trade</span>} />
      <PanelBody>
        <div className="grid grid-cols-1 gap-3 md:grid-cols-4">
          <label className="text-xs text-muted-foreground">Account ($)
            <input value={account} onChange={(e) => setAccount(e.target.value)} placeholder={liveNetLiq != null ? `live: ${Math.round(liveNetLiq)}` : "e.g. 25000"} inputMode="decimal"
              className="mt-1 h-8 w-full rounded-md border border-border bg-background px-2 text-[13px] text-foreground" />
            <span className="mt-0.5 block text-[11px]">blank = the live account&apos;s net liquidation</span>
          </label>
          <label className="text-xs text-muted-foreground">Risk per trade (%)
            <input value={risk} onChange={(e) => setRisk(e.target.value)} inputMode="decimal" className="mt-1 h-8 w-full rounded-md border border-border bg-background px-2 text-[13px] text-foreground" />
            <span className="mt-0.5 block text-[11px]">1% is the professional default; 2% is aggressive</span>
          </label>
          <label className="text-xs text-muted-foreground">Daily loss line ($)
            <input value={daily} onChange={(e) => setDaily(e.target.value)} placeholder={riskUsd ? `default: ${Math.round(riskUsd * 2)}` : ""} inputMode="decimal" className="mt-1 h-8 w-full rounded-md border border-border bg-background px-2 text-[13px] text-foreground" />
            <span className="mt-0.5 block text-[11px]">blank = two losing trades at your risk</span>
          </label>
          <div className="flex items-end gap-2">
            <button onClick={save} disabled={busy} className="h-8 rounded-md bg-primary px-3 text-[13px] font-semibold text-primary-foreground disabled:opacity-50">{busy ? "Saving…" : "Save"}</button>
            {msg && <span className="text-xs text-muted-foreground">{msg}</span>}
          </div>
        </div>
        {riskUsd != null && <Note className="mt-3">Right now: <strong>{money(riskUsd)}</strong> at risk per trade on {money(effective!)}. Every instrument card above turns that into a contract count at three stop widths.</Note>}
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
          <li>Study settings: paste the <strong>webhook secret</strong> (same one the futures desk uses); RTH session <code>0930-1600</code> for MES/MNQ, <code>0820-1330</code> for MGC.</li>
          <li>Create <strong>one alert per chart</strong>: condition <em>Trading Room — levels → Any alert() function call</em>, expiration open-ended, notifications → Webhook URL <code>{webhookUrl}</code>, message left empty.</li>
        </ol>
        <Explainer title="What the study draws and posts">
          Prior exchange-day high/low/close (orange), overnight high/low (aqua, frozen at the RTH open), the running week&apos;s high/low (purple), the 15-minute opening range (yellow, once formed), session VWAP (white). At each 5-minute close inside RTH it posts a level break to this room — at most one per kind every 30 minutes. The admin card uses the same definitions, built from Yahoo bars (about 10 minutes delayed), so the chart is the real-time source and this page is the reference copy.
        </Explainer>
      </PanelBody>
    </Panel>
  );
}
