"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";
import { useState } from "react";
import {
  LayoutDashboard,
  ClipboardList,
  Crosshair,
  Activity,
  Wallet,
  Film,
  FlaskConical,
  Menu,
  X,
} from "lucide-react";

// IA BY PLATFORM, WITH THE MONEY STATE IN THE SECTION NAME. Two desks (Sep 19 2026):
// Robinhood (US equity options, REAL account — the live desk armed Sep 13 2026, one contract,
// $150 max loss) and futures on the Tradovate DEMO — the edge lab (TradingView alerts → demo
// fills with the stop attached, Sep 11 2026), paper only by design; Spencer trades futures by
// hand and the desk is his analyst. The Kraken crypto margin desk was RETIRED and its code
// DELETED Sep 19 2026 (−79% from peak; the pivot is options + futures); the Tradeify 247
// DXtrade crypto prop and the spot trend bot went with it. The old Tradovate retail ENGINES
// are retired the same way (Aug 2026), along with the futures-era research pages. A page
// belongs to exactly one section and its section says which, so "is this real money?" is
// answered by the sidebar before the page loads. Page titles match these labels one-to-one.
const sections = [
  {
    label: "Overview",
    links: [
      { href: "/", label: "Dashboard", icon: LayoutDashboard },
    ],
  },
  {
    // Orders is cross-platform by construction (the Tradovate demo ledger, the Robinhood
    // account's positions and orders), so it is its own tab, not a platform page (Sep 14 2026).
    label: "Orders · every platform",
    links: [
      { href: "/orders", label: "Orders", icon: ClipboardList },
    ],
  },
  {
    // Spencer's own futures trading on the LIVE Tradovate account, by hand. The room is his analyst:
    // the level set his chart draws, the size his rule allows, the news clock, the tape of level
    // breaks. Read-only by construction — it has no order path (Sep 19 2026).
    label: "Tradovate · futures · live, by hand",
    tone: "live" as const,
    links: [
      { href: "/trade", label: "Trading Room", icon: Crosshair },
      { href: "/trade/library", label: "Trade Library", icon: Film },
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
    // The record of every idea tested and its verdict — read-only, nothing on it trades (Sep 24 2026).
    label: "Research",
    links: [
      { href: "/research/tested", label: "Tested ideas", icon: FlaskConical },
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

  // The active link is the one whose href is the longest prefix of the current path, so a
  // parent page does not light up while on one of its children.
  const bestMatch = sections
    .flatMap((s) => s.links.map((l) => l.href))
    .filter((href) => href === "/" ? pathname === "/" : pathname === href || pathname.startsWith(href + "/"))
    .sort((a, b) => b.length - a.length)[0];

  const isActive = (href: string) => href === bestMatch;

  const sidebarContent = (
    <>
      <div className="flex h-12 items-center border-b border-sidebar-border px-4">
        <Link href="/" className="flex items-center gap-2.5">
          <div className="num flex h-7 w-7 items-center justify-center rounded-md bg-primary text-primary-foreground shadow-[0_0_0_1px_oklch(1_0_0/8%),0_4px_12px_-4px_oklch(0.84_0.13_88/60%)]">
            <span className="text-[13px] font-bold">E</span>
          </div>
          <div className="leading-none">
            <span className="block text-[13px] font-semibold tracking-tight">Esbueno Trades</span>
            <span className="num mt-1 block text-[9px] uppercase tracking-[0.18em] text-muted-foreground/70">options · futures</span>
          </div>
        </Link>
      </div>

      <nav className="flex-1 overflow-auto py-3">
        {sections.map((section) => (
          <div key={section.label} className="mb-4">
            <p className={cn(
              "num px-4 pb-1.5 text-[9.5px] font-medium uppercase tracking-[0.14em]",
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
                      "relative flex items-center gap-2.5 rounded-md px-2.5 py-1.5 text-[13px] font-medium transition-colors",
                      active
                        ? "bg-sidebar-accent text-foreground before:absolute before:-left-2 before:top-1.5 before:h-[calc(100%-12px)] before:w-0.5 before:rounded-full before:bg-primary"
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
