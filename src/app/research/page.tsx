"use client";

import { useRouter } from "next/navigation";
import { SymbolSearch } from "@/components/trading/symbol-search";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export default function ResearchIndexPage() {
  const router = useRouter();

  return (
    <div className="space-y-6">
      <div><h1 className="text-xl font-bold tracking-tight">Symbol Research</h1><p className="text-[11px] text-muted-foreground/50">Company fundamentals, AI-generated reports, and watchlist scoring</p></div>
      <Card>
        <CardHeader>
          <CardTitle>Look up any company</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground mb-4">
            Get deep fundamental analysis: financials, earnings, analyst
            ratings, price targets, and more.
          </p>
          <div className="w-80">
            <SymbolSearch
              onSelect={(symbol) => router.push(`/research/${symbol}`)}
            />
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
