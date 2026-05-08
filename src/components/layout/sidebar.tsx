"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";

const sections = [
  {
    label: "TRADING",
    links: [
      { href: "/", label: "Dashboard" },
      { href: "/trade", label: "Trade" },
      { href: "/options", label: "Options" },
      { href: "/futures", label: "Futures" },
      { href: "/positions", label: "Positions" },
      { href: "/orders", label: "Orders" },
    ],
  },
  {
    label: "AGENTS",
    links: [
      { href: "/agents", label: "Agent Hub" },
      { href: "/ai", label: "AI Analyst" },
      { href: "/backtest", label: "Backtest" },
    ],
  },
  {
    label: "ANALYTICS",
    links: [
      { href: "/performance", label: "Performance" },
      { href: "/market", label: "Market Intel" },
      { href: "/calendar", label: "Calendar" },
      { href: "/insider", label: "Insider Trades" },
      { href: "/research", label: "Research" },
      { href: "/watchlist", label: "Watchlist" },
    ],
  },
];

export function Sidebar() {
  const pathname = usePathname();

  const isActive = (href: string) => {
    if (href === "/") return pathname === "/";
    return pathname.startsWith(href);
  };

  return (
    <aside className="w-52 border-r border-border bg-sidebar flex flex-col shrink-0">
      {/* Logo */}
      <div className="px-4 py-4 border-b border-border">
        <Link href="/" className="flex items-center gap-3 group">
          <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-emerald-500 via-emerald-400 to-teal-300 flex items-center justify-center shadow-md shadow-emerald-500/25 group-hover:shadow-emerald-500/40 transition-shadow">
            <span className="text-white font-black text-sm tracking-tighter">E</span>
          </div>
          <div>
            <h1 className="text-[13px] font-bold tracking-tight leading-none bg-gradient-to-r from-emerald-400 to-teal-300 bg-clip-text text-transparent">Esbueno Trades</h1>
            <div className="flex items-center gap-1.5 mt-1">
              <span className="relative flex h-1.5 w-1.5">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75" />
                <span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-emerald-400" />
              </span>
              <span className="text-[9px] text-emerald-400/80 font-semibold tracking-[0.15em] uppercase">Paper Live</span>
            </div>
          </div>
        </Link>
      </div>

      {/* Nav */}
      <nav className="flex-1 py-2 overflow-auto">
        {sections.map((section) => (
          <div key={section.label} className="mb-3">
            <p className="px-4 py-1 text-[9px] font-semibold tracking-[0.12em] text-muted-foreground/40 uppercase">
              {section.label}
            </p>
            <div className="px-2 space-y-px">
              {section.links.map((link) => (
                <Link
                  key={link.href}
                  href={link.href}
                  className={cn(
                    "flex items-center gap-2 px-2.5 py-[7px] rounded-md text-[12.5px] font-medium transition-all duration-100",
                    isActive(link.href)
                      ? "bg-primary/10 text-primary"
                      : "text-muted-foreground hover:text-foreground hover:bg-accent"
                  )}
                >
                  {isActive(link.href) && (
                    <span className="w-1 h-1 rounded-full bg-primary shrink-0" />
                  )}
                  {link.label}
                </Link>
              ))}
            </div>
          </div>
        ))}
      </nav>

      {/* Footer */}
      <div className="px-4 py-3 border-t border-border">
        <p className="text-[9px] text-muted-foreground/30 tracking-wider uppercase text-center">
          Alpaca · Yahoo · Finnhub · Claude
        </p>
      </div>
    </aside>
  );
}
