"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";
import { useState } from "react";
import {
  LayoutDashboard,
  CandlestickChart,
  ClipboardList,
  Route,
  Activity,
  Wallet,
  Menu,
  X,
} from "lucide-react";

// IA BY PLATFORM, WITH THE MONEY STATE IN THE SECTION NAME. The desks Spencer actually
// wants: Kraken (crypto margin, REAL money), Robinhood (US equity options, PAPER only —
// measured, never traded, no server credentials), and futures on the Tradovate DEMO — the
// edge lab (TradingView alerts → demo fills with the stop attached, Sep 11 2026), paper only
// by design. Futures prop firms were researched and DROPPED (capped payouts); Tradovate LIVE is
// closed for good. The Tradeify 247 DXtrade CRYPTO prop account (bought Sep 11 2026 by
// mistake — Spencer wanted futures) is RETIRED as of Sep 12: unlinked here, /prop redirected
// home by proxy.ts, its guardian cron removed, and the scanner no longer hands plans to it. The
// code stays in the repo, disarmed, for reversibility only. The old Tradovate retail ENGINES
// are RETIRED the same way (Aug 2026), along with the spot trend bot and the futures-era
// research pages. A page belongs
// to exactly one section and its section says which, so "is this real money?" is answered by
// the sidebar before the page loads. Page titles match these labels one-to-one.
const sections = [
  {
    label: "Overview",
    links: [
      { href: "/", label: "Dashboard", icon: LayoutDashboard },
    ],
  },
  {
    label: "Kraken · crypto margin · real money",
    tone: "live" as const,
    links: [
      { href: "/margin", label: "Live Account", icon: CandlestickChart },
      { href: "/margin/paper", label: "Live Desk", icon: Route },
      { href: "/orders", label: "Orders", icon: ClipboardList },
    ],
  },
  {
    // The futures edge lab: TradingView evaluates the registered rules on real-time CME data and
    // the desk executes on the Tradovate DEMO with the stop attached. Paper only, by design.
    label: "Tradovate · futures · demo, paper only",
    tone: "paper" as const,
    links: [
      { href: "/futures", label: "Futures Desk", icon: Activity },
    ],
  },
  {
    // The real account remains visible while live execution is completed.
    label: "Robinhood · options · real account",
    links: [
      { href: "/options", label: "Live Account", icon: Wallet },
    ],
  },
  {
    label: "System",
    links: [
      { href: "/command", label: "System Health", icon: Activity },
    ],
  },
];

export function Sidebar() {
  const pathname = usePathname();
  const [mobileOpen, setMobileOpen] = useState(false);

  // The active link is the one whose href is the longest prefix of the current path, so
  // "/margin" does not light up while on "/margin/paper".
  const bestMatch = sections
    .flatMap((s) => s.links.map((l) => l.href))
    .filter((href) => href === "/" ? pathname === "/" : pathname === href || pathname.startsWith(href + "/"))
    .sort((a, b) => b.length - a.length)[0];

  const isActive = (href: string) => href === bestMatch;

  const sidebarContent = (
    <>
      <div className="flex h-12 items-center border-b border-sidebar-border px-4">
        <Link href="/" className="flex items-center gap-2.5">
          <div className="flex h-7 w-7 items-center justify-center rounded-md bg-primary text-primary-foreground">
            <span className="text-[13px] font-bold">E</span>
          </div>
          <span className="text-[13px] font-semibold tracking-tight">Esbueno Trades</span>
        </Link>
      </div>

      <nav className="flex-1 overflow-auto py-3">
        {sections.map((section) => (
          <div key={section.label} className="mb-4">
            <p className={cn(
              "px-4 pb-1 text-[11px] font-medium uppercase tracking-wide",
              "tone" in section && section.tone === "live" ? "text-down/80" : "tone" in section && section.tone === "paper" ? "text-paper/80" : "text-muted-foreground/70",
            )}>
              {section.label}
            </p>
            <div className="space-y-0.5 px-2">
              {section.links.map((link) => {
                const Icon = link.icon;
                const active = isActive(link.href);
                return (
                  <Link
                    key={link.href}
                    href={link.href}
                    onClick={() => setMobileOpen(false)}
                    className={cn(
                      "flex items-center gap-2.5 rounded-md px-2.5 py-1.5 text-[13px] font-medium transition-colors",
                      active
                        ? "bg-sidebar-accent text-foreground"
                        : "text-muted-foreground hover:bg-sidebar-accent/60 hover:text-foreground",
                    )}
                  >
                    <Icon className={cn("h-4 w-4 shrink-0", active ? "text-primary" : "text-muted-foreground/70")} />
                    <span className="flex-1 truncate">{link.label}</span>
                  </Link>
                );
              })}
            </div>
          </div>
        ))}
      </nav>
    </>
  );

  return (
    <>
      <button
        onClick={() => setMobileOpen(!mobileOpen)}
        className="fixed left-3 top-2 z-50 flex h-8 w-8 items-center justify-center rounded-md border border-border bg-card text-foreground md:hidden"
        aria-label="Toggle menu"
      >
        {mobileOpen ? <X className="h-4 w-4" /> : <Menu className="h-4 w-4" />}
      </button>

      {mobileOpen && (
        <div className="fixed inset-0 z-40 bg-black/60 md:hidden" onClick={() => setMobileOpen(false)} />
      )}

      <aside className="hidden w-56 shrink-0 flex-col border-r border-sidebar-border bg-sidebar md:flex">
        {sidebarContent}
      </aside>

      <aside className={cn(
        "fixed bottom-0 left-0 top-0 z-40 flex w-64 flex-col border-r border-sidebar-border bg-sidebar transition-transform duration-200 md:hidden",
        mobileOpen ? "translate-x-0" : "-translate-x-full",
      )}>
        {sidebarContent}
      </aside>
    </>
  );
}
