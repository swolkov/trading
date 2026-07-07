"use client";

import Link from "next/link";

export default function OptionsRetiredPage() {
  return (
    <div className="max-w-xl mx-auto px-4 py-20 text-center space-y-4 animate-fade-up">
      <h1 className="text-xl font-bold tracking-tight">Options trading retired</h1>
      <p className="text-sm text-muted-foreground leading-relaxed">
        Options are no longer part of the system. The live engines now run micro futures on
        Tradovate and a daily DCA accumulator on Kraken.
      </p>
      <div className="flex items-center justify-center gap-4 pt-2 text-sm">
        <Link href="/futures" className="text-amber-400 hover:underline">Futures</Link>
        <Link href="/kraken" className="text-purple-400 hover:underline">Kraken</Link>
        <Link href="/" className="text-emerald-400 hover:underline">Dashboard</Link>
      </div>
    </div>
  );
}
