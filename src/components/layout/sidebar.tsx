"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";

const sections = [
  {
    label: "TRADING",
    links: [
      { href: "/", label: "Dashboard", icon: "◈" },
      { href: "/trade", label: "Trade", icon: "⟐" },
      { href: "/options", label: "Options", icon: "◎" },
      { href: "/positions", label: "Positions", icon: "▦" },
      { href: "/orders", label: "Orders", icon: "☰" },
    ],
  },
  {
    label: "AI & AUTOMATION",
    links: [
      { href: "/ai", label: "AI Analyst", icon: "◆" },
      { href: "/agent", label: "Auto Trader", icon: "⚡" },
      { href: "/backtest", label: "Backtest", icon: "⧖" },
    ],
  },
  {
    label: "INTELLIGENCE",
    links: [
      { href: "/market", label: "Market Intel", icon: "◉" },
      { href: "/analytics", label: "P&L Analytics", icon: "△" },
      { href: "/calendar", label: "Calendar", icon: "▤" },
      { href: "/insider", label: "Insider Trades", icon: "◈" },
      { href: "/research", label: "Research", icon: "◇" },
      { href: "/watchlist", label: "Watchlist", icon: "◎" },
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
    <aside className="w-56 border-r border-white/[0.06] bg-[oklch(0.13_0.005_260)] flex flex-col shrink-0">
      {/* Logo */}
      <div className="p-5 border-b border-white/[0.06]">
        <div className="flex items-center gap-2.5">
          <div className="w-8 h-8 rounded-lg bg-emerald-500/20 flex items-center justify-center">
            <span className="text-emerald-400 font-bold text-sm">T</span>
          </div>
          <div>
            <h1 className="text-sm font-bold tracking-tight">Trading Platform</h1>
            <p className="text-[10px] text-emerald-400/80 font-medium tracking-wider">PAPER TRADING</p>
          </div>
        </div>
      </div>

      {/* Nav */}
      <nav className="flex-1 py-3 overflow-auto">
        {sections.map((section) => (
          <div key={section.label} className="mb-4">
            <p className="px-5 mb-1.5 text-[9px] font-bold tracking-[0.15em] text-muted-foreground/50 uppercase">
              {section.label}
            </p>
            <div className="px-2 space-y-0.5">
              {section.links.map((link) => (
                <Link
                  key={link.href}
                  href={link.href}
                  className={cn(
                    "flex items-center gap-2.5 px-3 py-2 rounded-lg text-[13px] font-medium transition-all duration-150",
                    isActive(link.href)
                      ? "bg-emerald-500/15 text-emerald-400 shadow-[inset_0_0_0_1px_rgba(16,185,129,0.2)]"
                      : "text-muted-foreground hover:text-foreground hover:bg-white/[0.04]"
                  )}
                >
                  <span className={cn("text-xs w-4 text-center", isActive(link.href) ? "text-emerald-400" : "opacity-50")}>
                    {link.icon}
                  </span>
                  {link.label}
                </Link>
              ))}
            </div>
          </div>
        ))}
      </nav>

      {/* Footer */}
      <div className="p-4 border-t border-white/[0.06]">
        <p className="text-[10px] text-muted-foreground/40 text-center">
          Alpaca · Yahoo · Finnhub · Claude
        </p>
      </div>
    </aside>
  );
}
