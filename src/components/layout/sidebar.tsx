"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";
import { useState, useEffect } from "react";
import {
  LayoutDashboard,
  BarChart3,
  LineChart,
  Layers,
  ClipboardList,
  BookOpen,
  TrendingUp,
  Bot,
} from "lucide-react";

const sections = [
  {
    label: "OVERVIEW",
    links: [
      { href: "/", label: "Dashboard", icon: LayoutDashboard },
    ],
  },
  {
    label: "MARKETS",
    links: [
      { href: "/futures", label: "Futures", icon: BarChart3 },
      { href: "/stocks", label: "Stocks", icon: LineChart },
      { href: "/options", label: "Options", icon: Layers },
    ],
  },
  {
    label: "CONTROL",
    links: [
      { href: "/agents", label: "Agent Hub", icon: Bot },
    ],
  },
  {
    label: "ACTIVITY",
    links: [
      { href: "/orders", label: "Orders", icon: ClipboardList },
      { href: "/journal", label: "Journal", icon: BookOpen },
      { href: "/performance", label: "Performance", icon: TrendingUp },
    ],
  },
];

export function Sidebar() {
  const pathname = usePathname();
  const [mobileOpen, setMobileOpen] = useState(false);

  useEffect(() => {
    setMobileOpen(false);
  }, [pathname]);

  const isActive = (href: string) => {
    if (href === "/") return pathname === "/";
    return pathname.startsWith(href);
  };

  const sidebarContent = (
    <>
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
              <span className="text-[9px] text-emerald-400/80 font-semibold tracking-[0.15em] uppercase">Demo</span>
            </div>
          </div>
        </Link>
      </div>

      {/* Nav */}
      <nav className="flex-1 py-3 overflow-auto">
        {sections.map((section) => (
          <div key={section.label} className="mb-4">
            <p className="px-4 py-1 text-[9px] font-semibold tracking-[0.12em] text-muted-foreground/40 uppercase">
              {section.label}
            </p>
            <div className="px-2 space-y-0.5">
              {section.links.map((link) => {
                const Icon = link.icon;
                const active = isActive(link.href);
                return (
                  <Link
                    key={link.href}
                    href={link.href}
                    className={cn(
                      "flex items-center gap-2.5 px-2.5 py-[7px] rounded-md text-[12.5px] font-medium transition-all duration-100",
                      active
                        ? "bg-primary/10 text-primary"
                        : "text-muted-foreground hover:text-foreground hover:bg-accent"
                    )}
                  >
                    <Icon className={cn("w-3.5 h-3.5 shrink-0", active ? "text-primary" : "text-muted-foreground/50")} />
                    {link.label}
                  </Link>
                );
              })}
            </div>
          </div>
        ))}
      </nav>

      {/* Footer */}
      <div className="px-4 py-3 border-t border-border">
        <p className="text-[9px] text-muted-foreground/30 tracking-wider uppercase text-center">
          Alpaca · Tradovate · Claude
        </p>
      </div>
    </>
  );

  return (
    <>
      {/* Mobile hamburger button */}
      <button
        onClick={() => setMobileOpen(!mobileOpen)}
        className="md:hidden fixed top-3 left-3 z-50 w-10 h-10 rounded-lg bg-card border border-border flex items-center justify-center shadow-lg"
        aria-label="Toggle menu"
      >
        <div className="space-y-1.5">
          <span className={cn("block w-5 h-0.5 bg-foreground transition-all", mobileOpen && "rotate-45 translate-y-2")} />
          <span className={cn("block w-5 h-0.5 bg-foreground transition-all", mobileOpen && "opacity-0")} />
          <span className={cn("block w-5 h-0.5 bg-foreground transition-all", mobileOpen && "-rotate-45 -translate-y-2")} />
        </div>
      </button>

      {/* Mobile overlay */}
      {mobileOpen && (
        <div
          className="md:hidden fixed inset-0 bg-black/50 z-40"
          onClick={() => setMobileOpen(false)}
        />
      )}

      {/* Desktop sidebar */}
      <aside className="hidden md:flex w-52 border-r border-border bg-sidebar flex-col shrink-0">
        {sidebarContent}
      </aside>

      {/* Mobile sidebar */}
      <aside className={cn(
        "md:hidden fixed left-0 top-0 bottom-0 w-64 bg-sidebar border-r border-border z-40 flex flex-col transition-transform duration-300",
        mobileOpen ? "translate-x-0" : "-translate-x-full"
      )}>
        {sidebarContent}
      </aside>
    </>
  );
}
