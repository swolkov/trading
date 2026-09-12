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
  Landmark,
  Menu,
  X,
} from "lucide-react";

// IA BY PLATFORM, WITH THE MONEY STATE IN THE SECTION NAME. The desks Spencer actually
// wants: Kraken (crypto margin, REAL money), Robinhood (US equity options, PAPER only —
// measured, never traded, no server credentials), and a FUTURES prop account (ES/NQ,
// automated through the eval and the funded stage) — the latter is NOT bought yet, so it has
// no section; one appears the day an account exists. Tradeify 247 is listed because the
// account exists, not because it is wanted: it is a DXtrade CRYPTO prop account bought on
// Sep 11 2026 by mistake (Spencer wanted futures; he already has Kraken for crypto). The
// desk code stays deployed and DISARMED while a conversion/refund is pursued. The old
// Tradovate retail engines are RETIRED (Aug 2026): unlinked here, redirected home by
// proxy.ts along with the spot trend bot and the futures-era research pages. A page belongs
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
    // The account exists, so its page stays reachable (balance, floors, the disarm state,
    // the conversion attempt). The label says what it is so nobody mistakes it for the
    // futures desk.
    label: "Tradeify 247 · crypto prop · bought in error, not in use",
    tone: "paper" as const,
    links: [
      { href: "/prop", label: "Crypto Prop Account", icon: Landmark },
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
