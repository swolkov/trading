"use client";

import Link from "next/link";
import useSWR from "swr";

const fetcher = (u: string) => fetch(u).then((r) => r.json()).catch(() => null);
const fmt = (n: number | null | undefined) => (n == null || isNaN(n) ? "—" : `$${n.toLocaleString(undefined, { maximumFractionDigits: 0 })}`);

function Badge({ text, tone }: { text: string; tone: "live" | "off" | "warn" }) {
  const cls = tone === "live" ? "bg-emerald-500/15 text-emerald-400 border-emerald-500/30"
    : tone === "warn" ? "bg-amber-500/15 text-amber-300 border-amber-500/30"
    : "bg-muted text-muted-foreground/60 border-transparent";
  return <span className={`text-[8px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded border ${cls}`}>{text}</span>;
}

// Command-center strip: all 4 pillars at a glance + a true portfolio total across all 3 accounts.
export function PillarsStrip() {
  const { data: fut } = useSWR("/api/futures/positions", fetcher, { refreshInterval: 30000 });
  const { data: accts } = useSWR("/api/admin/accounts", fetcher, { refreshInterval: 60000 });
  const { data: opt } = useSWR("/api/options-agent", fetcher, { refreshInterval: 60000 });
  const { data: lt } = useSWR("/api/longterm", fetcher, { refreshInterval: 60000 });
  const { data: krk } = useSWR("/api/kraken-agent", fetcher, { refreshInterval: 60000 });

  const futVal = fut?.account?.netLiq ?? null;
  const alpaca = (accts?.accounts || []).find((a: { key: string }) => a?.key === "alpaca-live");
  const alpacaVal = alpaca?.balance ?? null;
  const krkVal = krk?.connected ? krk?.totalValue ?? null : null;
  const total = (futVal || 0) + (alpacaVal || 0) + (krkVal || 0);

  const optOn = opt?.enabled;
  const optSb = opt?.scoreboard;
  const ltOn = lt?.enabled;
  const ltVal = lt?.holding?.marketValue ?? null;
  const krkOn = krk?.enabled && krk?.connected;
  const krkValidate = krk?.validateOnly;

  const cards = [
    { name: "Futures", href: "/futures", broker: "Tradovate gold", value: fmt(futVal), badge: <Badge text="live" tone="live" />, sub: `${fut?.positions?.length ?? 0} open` },
    { name: "Options", href: "/options", broker: "Alpaca", value: optSb?.closed ? `${(optSb.totalPnl >= 0 ? "+" : "")}$${optSb.totalPnl?.toFixed(0)}` : "0 trades", badge: <Badge text={optOn ? (opt.mode === "live" ? "live" : "paper") : "off"} tone={optOn ? "live" : "off"} />, sub: `${optSb?.openGroups ?? 0} open · ${optSb?.closed ?? 0} closed` },
    { name: "Long-term", href: "/long-term", broker: "Alpaca DCA", value: fmt(ltVal ?? lt?.totalInvested), badge: <Badge text={ltOn ? "on" : "off"} tone={ltOn ? "live" : "off"} />, sub: lt?.buyCount ? `${lt.buyCount} buys` : "not started" },
    { name: "Kraken", href: "/kraken", broker: "BTC/ETH trend", value: fmt(krkVal), badge: <Badge text={!krk?.connected ? "n/c" : krkValidate ? "validate" : krkOn ? "live" : "off"} tone={!krk?.connected ? "off" : krkValidate ? "warn" : krkOn ? "live" : "off"} />, sub: krk?.holdings?.length ? `${krk.holdings.length} held` : "flat" },
  ];

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <p className="text-xs font-semibold text-muted-foreground/70">The 4 Engines</p>
        <p className="text-xs text-muted-foreground/50">Total across all accounts: <span className="font-bold text-foreground tabular-nums">{fmt(total)}</span></p>
      </div>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {cards.map((c) => (
          <Link key={c.name} href={c.href} className="rounded-xl border border-border bg-card p-3 hover:border-border/80 transition-colors">
            <div className="flex items-center justify-between mb-1">
              <span className="text-xs font-bold">{c.name}</span>
              {c.badge}
            </div>
            <p className="text-lg font-black tabular-nums leading-none">{c.value}</p>
            <p className="text-[10px] text-muted-foreground/45 mt-1">{c.broker} · {c.sub}</p>
          </Link>
        ))}
      </div>
    </div>
  );
}
