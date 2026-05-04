"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";

const links = [
  { href: "/", label: "Dashboard", icon: "📊" },
  { href: "/ai", label: "AI Analyst", icon: "🧠" },
  { href: "/agent", label: "Auto Trader", icon: "🤖" },
  { href: "/trade", label: "Trade", icon: "💹" },
  { href: "/options", label: "Options", icon: "📈" },
  { href: "/positions", label: "Positions", icon: "📁" },
  { href: "/orders", label: "Orders", icon: "📋" },
  { href: "/analytics", label: "P&L Analytics", icon: "📉" },
  { href: "/market", label: "Market Intel", icon: "🌐" },
  { href: "/calendar", label: "Calendar", icon: "📅" },
  { href: "/insider", label: "Insider Trades", icon: "🕵" },
  { href: "/research", label: "Research", icon: "🔬" },
  { href: "/watchlist", label: "Watchlist", icon: "👁" },
];

export function Sidebar() {
  const pathname = usePathname();

  const isActive = (href: string) => {
    if (href === "/") return pathname === "/";
    return pathname.startsWith(href);
  };

  return (
    <aside className="w-56 border-r bg-card flex flex-col shrink-0">
      <div className="p-4 border-b">
        <h1 className="text-lg font-bold tracking-tight">Trading Platform</h1>
        <p className="text-xs text-muted-foreground">Paper Trading</p>
      </div>
      <nav className="flex-1 p-2 space-y-1 overflow-auto">
        {links.map((link) => (
          <Link
            key={link.href}
            href={link.href}
            className={cn(
              "flex items-center gap-3 px-3 py-2 rounded-md text-sm font-medium transition-colors",
              isActive(link.href)
                ? "bg-primary text-primary-foreground"
                : "text-muted-foreground hover:bg-accent hover:text-accent-foreground"
            )}
          >
            <span>{link.icon}</span>
            {link.label}
          </Link>
        ))}
      </nav>
      <div className="p-4 border-t text-xs text-muted-foreground">
        Powered by Alpaca + Yahoo Finance
      </div>
    </aside>
  );
}
