"use client";

import { useState } from "react";
import { useUser } from "@clerk/nextjs";
import Link from "next/link";
import useSWR from "swr";

const fetcher = (url: string) => fetch(url).then((r) => r.json());

export default function ConnectPage() {
  const { user } = useUser();
  const { data: connections, mutate } = useSWR("/api/connect/tradovate", fetcher);
  const [form, setForm] = useState({ username: "", password: "", cid: "", secret: "", environment: "demo" });
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");

  const connect = async () => {
    setConnecting(true);
    setError("");
    setSuccess("");
    try {
      const res = await fetch("/api/connect/tradovate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
      });
      const data = await res.json();
      if (data.error) { setError(data.error); return; }
      setSuccess(`Connected to Tradovate ${form.environment.toUpperCase()} — Account: ${data.account?.name || data.account?.id}`);
      setForm({ ...form, password: "" });
      mutate();
    } catch (err) { setError("Connection failed"); }
    finally { setConnecting(false); }
  };

  const disconnect = async (connectionId: string) => {
    await fetch("/api/connect/tradovate", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ connectionId }),
    });
    mutate();
  };

  return (
    <div className="max-w-2xl mx-auto p-6 space-y-8">
      <div>
        <h1 className="text-2xl font-black">Broker Connections</h1>
        <p className="text-sm text-muted-foreground mt-1">Manage your Tradovate and Alpaca trading accounts.</p>
      </div>

      {/* Existing connections */}
      {connections?.connections?.length > 0 && (
        <div className="space-y-3">
          <h2 className="text-sm font-bold text-muted-foreground uppercase tracking-wider">Active Connections</h2>
          {connections.connections.map((conn: any) => (
            <div key={conn.id} className="flex items-center justify-between rounded-xl border border-white/[0.06] bg-white/[0.02] p-4">
              <div className="flex items-center gap-3">
                <div className={`w-3 h-3 rounded-full ${conn.status === "connected" ? "bg-emerald-400" : "bg-amber-400"}`} />
                <div>
                  <p className="text-sm font-bold capitalize">{conn.broker} — {conn.environment.toUpperCase()}</p>
                  <p className="text-xs text-muted-foreground">Account: {conn.accountName || conn.accountId || "Unknown"}</p>
                </div>
              </div>
              <button onClick={() => disconnect(conn.id)} className="text-xs text-red-400 hover:text-red-300 font-semibold">
                Disconnect
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Connect Tradovate */}
      <div className="rounded-xl border border-white/[0.06] bg-white/[0.02] p-6 space-y-4">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-lg bg-blue-500/20 flex items-center justify-center">
            <span className="text-lg font-black text-blue-400">T</span>
          </div>
          <div>
            <h2 className="text-sm font-bold">Tradovate</h2>
            <p className="text-xs text-muted-foreground">Futures trading — MES, MNQ, MGC, ES, NQ, GC</p>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1">
            <label className="text-[10px] text-muted-foreground/60 uppercase tracking-wider font-semibold">Username</label>
            <input type="text" value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value })}
              className="w-full bg-white/[0.04] border border-white/[0.06] rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-blue-500/30" />
          </div>
          <div className="space-y-1">
            <label className="text-[10px] text-muted-foreground/60 uppercase tracking-wider font-semibold">Password</label>
            <input type="password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })}
              className="w-full bg-white/[0.04] border border-white/[0.06] rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-blue-500/30" />
          </div>
          <div className="space-y-1">
            <label className="text-[10px] text-muted-foreground/60 uppercase tracking-wider font-semibold">CID (optional)</label>
            <input type="text" value={form.cid} onChange={(e) => setForm({ ...form, cid: e.target.value })}
              className="w-full bg-white/[0.04] border border-white/[0.06] rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-blue-500/30" />
          </div>
          <div className="space-y-1">
            <label className="text-[10px] text-muted-foreground/60 uppercase tracking-wider font-semibold">Secret (optional)</label>
            <input type="password" value={form.secret} onChange={(e) => setForm({ ...form, secret: e.target.value })}
              className="w-full bg-white/[0.04] border border-white/[0.06] rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-blue-500/30" />
          </div>
        </div>

        {/* Environment toggle */}
        <div className="flex gap-2">
          {["demo", "live"].map((env) => (
            <button key={env} onClick={() => setForm({ ...form, environment: env })}
              className={`flex-1 py-2 rounded-lg text-xs font-bold uppercase transition-all ${
                form.environment === env
                  ? env === "live" ? "bg-red-500/20 text-red-400 ring-1 ring-red-500/30" : "bg-emerald-500/20 text-emerald-400 ring-1 ring-emerald-500/30"
                  : "bg-white/[0.04] text-muted-foreground/40 hover:bg-white/[0.08]"
              }`}
            >
              {env}
            </button>
          ))}
        </div>

        {error && <p className="text-xs text-red-400 font-semibold">{error}</p>}
        {success && <p className="text-xs text-emerald-400 font-semibold">{success}</p>}

        <button onClick={connect} disabled={connecting || !form.username || !form.password}
          className="w-full py-2.5 rounded-lg bg-blue-500/20 text-blue-400 font-bold text-sm hover:bg-blue-500/30 ring-1 ring-blue-500/20 disabled:opacity-40 disabled:cursor-not-allowed transition-all"
        >
          {connecting ? "Connecting..." : "Connect Tradovate"}
        </button>
      </div>

      {/* Alpaca Status */}
      <div className="rounded-xl border border-blue-500/15 bg-gradient-to-br from-blue-500/[0.04] to-transparent p-6 space-y-4">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-lg bg-blue-500/20 flex items-center justify-center">
            <span className="text-lg font-black text-blue-400">A</span>
          </div>
          <div className="flex-1">
            <h2 className="text-sm font-bold">Alpaca</h2>
            <p className="text-xs text-muted-foreground">Stocks & crypto — 24/7 crypto, US equities</p>
          </div>
          <span className="px-2 py-1 rounded-full text-[9px] font-bold bg-emerald-500/15 text-emerald-400 ring-1 ring-emerald-500/30">
            Connected via API Keys
          </span>
        </div>
        <div className="grid grid-cols-3 gap-3 text-sm">
          <div>
            <p className="text-[10px] text-muted-foreground/40">Mode</p>
            <p className="font-bold text-emerald-400">Paper</p>
          </div>
          <div>
            <p className="text-[10px] text-muted-foreground/40">Assets</p>
            <p className="font-bold">Stocks, Crypto</p>
          </div>
          <div>
            <p className="text-[10px] text-muted-foreground/40">Crypto</p>
            <p className="font-bold">24/7 Trading</p>
          </div>
        </div>
        <p className="text-[10px] text-muted-foreground/40">
          Alpaca is connected via environment API keys. To switch between paper and live, update your API keys in the deployment environment or use the Agent Hub config.
        </p>
      </div>

      <p className="text-[10px] text-muted-foreground/40 text-center">
        Credentials are encrypted with AES-256. Connections can be revoked at any time.
      </p>
    </div>
  );
}
